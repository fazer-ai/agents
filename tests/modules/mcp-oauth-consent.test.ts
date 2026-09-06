import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  consumePendingAuthorization,
  createPendingAuthorization,
  findApproval,
  getPendingAuthorization,
  isApprovalSufficient,
  issueConsentCsrf,
  upsertApproval,
} from "@/modules/mcp/oauth/consent";

const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

const CLIENT = `consent-${process.pid}`;

// Whether SOMETHING holds a row/tuple lock on the approvals table right now. The first grant's write
// is uncommitted, so it cannot be read; what is observable is the lock it took.
async function findApprovalUncommitted(_client: string): Promise<boolean> {
  const rows = await suDb.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
     WHERE c.relname = 'mcp_oauth_client_approvals' AND l.mode = 'RowExclusiveLock'`;
  return (rows[0]?.n ?? 0n) > 0n;
}
const REDIRECT = "https://client.example/cb";
let tenantId = 0n;
let userId = 0n;
const OTHER_USER = 999_999_999n;

async function mintPending(): Promise<string> {
  const { requestId } = await createPendingAuthorization({
    clientId: CLIENT,
    userId,
    tenantId,
    redirectUri: REDIRECT,
    scopes: ["mcp:read", "mcp:write"],
    codeChallenge: randomBytes(16).toString("base64url"),
    codeChallengeMethod: "S256",
    state: "xyz",
    base: suDb,
  });
  return requestId;
}

describe.skipIf(!dbUp)("mcp oauth consent (pending + approvals)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ConsentT", slug: `consent-${process.pid}` },
    });
    tenantId = t.id;
    const u = await suDb.user.create({
      data: {
        tenantId,
        email: `consent-${process.pid}@example.com`,
        role: "TENANT_ADMIN",
        passwordHash: "x",
      },
    });
    userId = u.id;
  });

  afterAll(async () => {
    // BY PREFIX, not by the exact id: the tests below derive clients from `CLIENT` (`-race`,
    // `-dup`), and an approval row has no foreign key to the user or the tenant deleted just after,
    // so an exact match leaves them behind for good — one more orphan per local run.
    await suDb.$executeRawUnsafe(
      `DELETE FROM mcp_oauth_pending_authorizations WHERE client_id LIKE '${CLIENT}%'`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM mcp_oauth_client_approvals WHERE client_id LIKE '${CLIENT}%'`,
    );
    if (userId)
      await suDb.$executeRawUnsafe(`DELETE FROM users WHERE id = ${userId}`);
    if (tenantId)
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    await suDb.$disconnect();
  });

  test("create → get returns the (unconsumed) pending for its owner", async () => {
    const req = await mintPending();
    const row = await getPendingAuthorization(req, userId, suDb);
    expect(row).not.toBeNull();
    expect(row?.clientId).toBe(CLIENT);
    expect(row?.scopes).toEqual(["mcp:read", "mcp:write"]);
    expect(row?.consumedAt).toBeNull();
  });

  test("get is bound to the owner (a different user sees nothing)", async () => {
    const req = await mintPending();
    expect(await getPendingAuthorization(req, OTHER_USER, suDb)).toBeNull();
  });

  test("expired pending is not returned", async () => {
    const req = await mintPending();
    await suDb.mcpOAuthPendingAuthorization.updateMany({
      where: { clientId: CLIENT, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await getPendingAuthorization(req, userId, suDb)).toBeNull();
    // restore future expiry for subsequent tests' freshly-minted rows is unnecessary (each mints new)
  });

  test("issue CSRF then consume with it yields the row exactly once", async () => {
    const req = await mintPending();
    const csrf = await issueConsentCsrf(req, userId, suDb);
    expect(csrf).toBeTruthy();
    const row = await consumePendingAuthorization(
      req,
      userId,
      csrf as string,
      suDb,
    );
    expect(row?.clientId).toBe(CLIENT);
    // single-use: a replay sees a consumed record → null
    expect(
      await consumePendingAuthorization(req, userId, csrf as string, suDb),
    ).toBeNull();
  });

  test("consume with a wrong CSRF token is rejected", async () => {
    const req = await mintPending();
    await issueConsentCsrf(req, userId, suDb);
    expect(
      await consumePendingAuthorization(req, userId, "not-the-token", suDb),
    ).toBeNull();
  });

  test("consume without issuing a CSRF token is rejected", async () => {
    const req = await mintPending();
    expect(
      await consumePendingAuthorization(req, userId, "anything", suDb),
    ).toBeNull();
  });

  test("approval is scope-aware (subset passes, escalation fails)", () => {
    expect(isApprovalSufficient(["mcp:read", "mcp:write"], ["mcp:read"])).toBe(
      true,
    );
    expect(isApprovalSufficient(["mcp:read"], ["mcp:read", "mcp:write"])).toBe(
      false,
    );
  });

  test("upsert remembers and widens the approval (stores the union)", async () => {
    await upsertApproval(userId, CLIENT, ["mcp:read"], suDb);
    let approval = await findApproval(userId, CLIENT, suDb);
    expect(approval?.scopes).toEqual(["mcp:read"]);

    await upsertApproval(userId, CLIENT, ["mcp:write"], suDb);
    approval = await findApproval(userId, CLIENT, suDb);
    expect(new Set(approval?.scopes)).toEqual(
      new Set(["mcp:read", "mcp:write"]),
    );
  });

  // What the union has to be a union OF, pinned in the two directions the SQL can get wrong: a scope
  // granted twice must not accumulate, and the stored ORDER is not incidental — it is what every
  // reader of this row sees, including an audit projection of `{ scopes }`, where a re-grant that
  // reshuffled the array would read as a change that did not happen.
  test("re-granting a scope neither duplicates it nor reshuffles the row", async () => {
    const client = `${CLIENT}-dup`;
    await upsertApproval(userId, client, ["mcp:write", "mcp:read"], suDb);
    await upsertApproval(userId, client, ["mcp:read"], suDb);
    await upsertApproval(userId, client, ["mcp:read", "mcp:write"], suDb);
    const approval = await findApproval(userId, client, suDb);
    expect(approval?.scopes).toEqual(["mcp:read", "mcp:write"]);
  });

  // TWO GRANTS FOR THE SAME (user, client) AT ONCE, and the union has to hold across them (#497).
  //
  // The widening above is sequential, so it passes on a merge computed in application code from a
  // value read earlier. This one is not: the first grant runs inside a transaction held open, so it
  // keeps the row lock while the second one runs. A merge that closes over a read taken before that
  // lock was released writes a set that never saw the other's scope, and the last write wins —
  // silently, since both calls return normally and the approval row is there.
  //
  // THE RENDEZVOUS IS THE DATABASE'S OWN LOCK, not a hook on either implementation's queries. An
  // earlier version of this blocked the approval's `findUnique`, which measured the SHAPE of the
  // read-then-write and hung the moment the fix stopped reading. What both shapes must do is wait
  // for that row, so the test waits for Postgres to say someone is waiting for it, and fails if
  // nobody ever does rather than sleeping and hoping.
  test("two grants at once keep both scopes, not the last writer's", async () => {
    const client = `${CLIENT}-race`;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    const blocked = async (): Promise<boolean> => {
      const rows = await suDb.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND query ILIKE '%mcp_oauth_client_approvals%'`;
      return (rows[0]?.n ?? 0n) > 0n;
    };

    const first = suDb.$transaction(
      async (tx) => {
        await upsertApproval(
          userId,
          client,
          ["mcp:read"],
          tx as unknown as PrismaClient,
        );
        await held;
      },
      { timeout: 20_000 },
    );
    // The lock has to be taken before the second grant can queue behind it.
    while (!(await findApprovalUncommitted(client))) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = upsertApproval(userId, client, ["mcp:write"], suDb);

    let waited = false;
    for (let i = 0; i < 200 && !waited; i++) {
      waited = await blocked();
      if (!waited) await new Promise((r) => setTimeout(r, 10));
    }
    // Without this the whole test is two sleeps with a better name: it would go green on a build
    // where the second grant never contended at all.
    expect(waited).toBe(true);

    release();
    await Promise.all([first, second]);

    const approval = await findApproval(userId, client, suDb);
    expect(new Set(approval?.scopes)).toEqual(
      new Set(["mcp:read", "mcp:write"]),
    );
  });
});
