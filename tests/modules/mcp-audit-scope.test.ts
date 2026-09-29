import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { recordAudit } from "@/modules/audit/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { auditList } from "@/modules/mcp/read";
import { buildMcpServer } from "@/modules/mcp/server";
import { syntheticAction } from "../utils/audit-action";

// THE SCOPE HAS TO SURVIVE THE TRANSPORT. `audit_list` goes through `registerTenantTool`, which makes
// a fleet SUPER_ADMIN token name a target tenant before any per-tenant tool runs. `fleet` and `all`
// name their own trail, so a tenant target is a value the read has nowhere to put, and demanding one
// would let the widest reader reach the fleet rows only by naming an unrelated tenant. The REST
// surface answers this too; these tests hold the two doors to agreeing. TWO BLOCKS, because the gates
// sit on opposite sides of the DB line: `tests/setup.ts` points `DATABASE_URL` at a database that
// does not exist, so a call through the registered tool proves only that the WRAPPER let it past. The
// rows are asserted one layer down, on `auditList` with an injected client.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;

let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;

if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const TAG = `m520-${process.pid}`;
const USER = 9521n;

// The exact sentence `resolveEffectivePrincipal` answers a targetless SUPER_ADMIN with. Asserting on
// it is what tells "the wrapper demanded a tenant" apart from every other way a call can fail.
const ASKS_FOR_A_TARGET = "pass `tenant`";

function principal(over: Partial<VerifiedToken> = {}): VerifiedToken {
  return {
    userId: USER,
    tenantId: null,
    role: "SUPER_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

async function withClient<T>(
  p: VerifiedToken,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const server = buildMcpServer(p);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "audit-scope", version: "0" });
  await client.connect(clientT);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function call(p: VerifiedToken, args: Record<string, unknown>) {
  return withClient(p, async (client) => {
    const res = await client.callTool({ name: "audit_list", arguments: args });
    const text = (res.content as { type: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("");
    return { isError: res.isError === true, text };
  });
}

describe("audit_list tenant targeting over MCP", () => {
  // THE SCHEMA IS A GATE OF ITS OWN, and it is the one that refuses before any code of ours runs:
  // a required `tenant` makes the SDK reject the call with a validation error, so no handler branch
  // could have rescued it.
  test("the selector is optional on this tool, and required on the others", async () => {
    const required = await withClient(principal(), async (client) => {
      const { tools } = await client.listTools();
      return new Map(
        tools.map((t) => [
          t.name,
          ((t.inputSchema as { required?: string[] }).required ??
            []) as string[],
        ]),
      );
    });
    expect(required.get("audit_list")).not.toContain("tenant");
    // The rule it is an exception to. `agent_list` has no scope to widen and reads one tenant only.
    expect(required.get("agent_list")).toContain("tenant");
  });

  for (const scope of ["fleet", "all"] as const) {
    test(`the wrapper lets a targetless ${scope} read through`, async () => {
      const r = await call(principal(), { scope, limit: 1 });
      expect(r.text).not.toContain(ASKS_FOR_A_TARGET);
    });
  }

  // The default is unchanged: the tenant trail cannot say WHICH tenant without a target, so that
  // scope still demands one and says so.
  test("the tenant scope still asks for a target", async () => {
    const r = await call(principal(), { limit: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(ASKS_FOR_A_TARGET);
  });

  // Ignoring the target would answer "acme plus the fleet rows" -- which is what an agent passing
  // both almost certainly meant -- with EVERY tenant's rows, presented as the answer.
  test("naming a tenant alongside a fleet scope is refused, not ignored", async () => {
    const r = await call(principal(), {
      scope: "all",
      tenant: "acme",
      limit: 1,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("scope");
    expect(r.text).not.toContain(ASKS_FOR_A_TARGET);
  });

  // A tenant-scoped token never sees the selector at all, so there is nothing to make optional.
  test("a tenant token is offered no selector on any tool", async () => {
    const required = await withClient(
      principal({ tenantId: 1n, role: "TENANT_ADMIN" }),
      async (client) => {
        const { tools } = await client.listTools();
        return new Map(
          tools.map((t) => [
            t.name,
            Object.keys(
              (t.inputSchema as { properties?: Record<string, unknown> })
                .properties ?? {},
            ),
          ]),
        );
      },
    );
    expect(required.get("audit_list")).not.toContain("tenant");
    expect(required.get("agent_list")).not.toContain("tenant");
  });
});

describe.skipIf(!dbUp)("what a targetless audit_list actually reads", () => {
  let mine = 0n;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "M520", slug: `m520-${process.pid}` },
    });
    mine = t.id;
    const ctx: TenantContext = {
      tenantId: mine,
      userId: USER,
      role: "SUPER_ADMIN",
    };
    await runScopedOn(appDb, ctx, (db) =>
      recordAudit(db, mine, {
        action: syntheticAction("agent.create"),
        target: `${TAG}:mine`,
        actorId: USER,
        actorType: "user",
      }),
    );
    await asSuperAdminOn(appDb, (db) =>
      recordAudit(db, null, {
        action: syntheticAction("mcp_client.create"),
        target: `${TAG}:fleet`,
        actorId: USER,
        actorType: "user",
      }),
    );
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE target LIKE '${TAG}:%'`,
    );
    if (mine) {
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${mine}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  const read = (p: VerifiedToken, args: Record<string, unknown>) =>
    auditList(p, { limit: 500, ...args }, { base: appDb });

  test("fleet reaches the rows keyed to no tenant, with no tenant selected", async () => {
    const r = await read(principal(), { scope: "fleet" });
    const text = JSON.stringify(r);
    expect(text).toContain(`${TAG}:fleet`);
    expect(text).not.toContain(`${TAG}:mine`);
  });

  // `all` is the one that must ALSO reach the tenant rows: a fleet read that stopped at the
  // NULL-tenant slice would answer the widest ask with the narrowest trail.
  test("all reaches both, still with no tenant selected", async () => {
    const text = JSON.stringify(await read(principal(), { scope: "all" }));
    expect(text).toContain(`${TAG}:fleet`);
    expect(text).toContain(`${TAG}:mine`);
  });

  // NOTE: BOTH DOORS AGREE ON THE CURSOR TOO. The REST endpoint answers a cursor of neither shape with a 400;
  // this one refuses it as well, and for the same reason: read as the new key it would continue the
  // walk from somewhere else while the caller believes it is paging the same trail. An agent that
  // stored a cursor is the likeliest holder of an old one.
  test("a cursor that is neither shape is refused here too", async () => {
    for (const bad of [
      "abc",
      "|",
      "2026-01-01T00:00:00.000Z|x",
      "9".repeat(40),
    ]) {
      const r = await read(
        principal({ tenantId: mine, role: "TENANT_ADMIN" }),
        {
          cursor: bad,
        },
      );
      expect(JSON.stringify(r)).toContain("nextCursor` from a previous");
    }
  });

  // NOTE: AND A BARE ID IS REFUSED HERE TOO. A bare id is the cursor from before the keyset change, and both
  // doors accept one shape. The refusal is the RIGHT answer rather than a translation: read as the new
  // key, a bare id resumes from a different place in the trail while the agent believes it is paging
  // the same one.
  test("a bare id from before the keyset change is refused", async () => {
    const p = principal();
    const first = (await auditList(
      p,
      { limit: 1, scope: "all" },
      { base: appDb },
    )) as { ok: true; data: { nextCursor: string | null } };
    const bareId = (first.data.nextCursor ?? "").split("|")[1] as string;
    expect(bareId).toBeTruthy();
    const r = await auditList(
      p,
      { limit: 1, scope: "all", cursor: bareId },
      { base: appDb },
    );
    expect(JSON.stringify(r)).toContain("nextCursor` from a previous");
  });

  // NOTE: AND THE REFUSAL SAYS NOTHING ABOUT WHETHER THE ID EXISTS. Resolving a bare id needs the trail
  // predicate, which is how such an endpoint turns into a way to ask whether some row is there.
  // Refused at the parse, the answer is the same sentence for a real id from another trail, a real id
  // from this one, and a number naming nothing.
  test("a foreign id, a live id and a made-up one are all refused the same way", async () => {
    const p = principal();
    const mineRow = (await auditList(
      principal({ tenantId: mine, role: "TENANT_ADMIN" }),
      { limit: 1 },
      { base: appDb },
    )) as { ok: true; data: { entries: { id: string }[] } };
    const tenantRowId = mineRow.data.entries[0]?.id as string;
    expect(tenantRowId).toBeTruthy();

    const answers = new Set<string>();
    for (const cursor of [tenantRowId, "115", "999999999"]) {
      const r = await auditList(
        p,
        { limit: 500, scope: "fleet", cursor },
        { base: appDb },
      );
      const text = JSON.stringify(r);
      expect(text).toContain("nextCursor` from a previous");
      // No trail is read at all, so no row of one can leak into the refusal.
      expect(text).not.toContain(`${TAG}:mine`);
      answers.add(text);
    }
    expect(answers.size).toBe(1);
  });

  // NOTE: THE UNAUTHORIZED SCOPE IS STILL AN ORDINARY ANSWER, cursor or no cursor: a scope check that throws
  // OUTSIDE the handler's `try` rejects the promise instead of answering with `isError` like every
  // other refusal. Which refusal wins is pinned too: the cursor is refused at the parse, before the
  // scope is looked at, so an unauthorized caller passing a bare id hears about the cursor. Neither
  // sentence describes the trail, so both are safe; a reorder should be deliberate.
  test("an unauthorized scope answers, rather than rejecting, with a bare cursor and without", async () => {
    const tenantAdmin = principal({ tenantId: mine, role: "TENANT_ADMIN" });
    for (const scope of ["fleet", "all"]) {
      const bare = await auditList(
        tenantAdmin,
        { limit: 1, scope, cursor: "115" },
        { base: appDb },
      );
      const none = await auditList(
        tenantAdmin,
        { limit: 1, scope },
        { base: appDb },
      );
      expect(JSON.stringify(none)).toContain("SUPER_ADMIN");
      expect(JSON.stringify(bare)).toContain("nextCursor` from a previous");
    }
  });

  test("the cursor this tool handed out is accepted, and continues the walk", async () => {
    // `all`, because it is the scope that reaches more than one row here and a cursor only exists
    // when there is a next page.
    const p = principal();
    const first = (await auditList(
      p,
      { limit: 1, scope: "all" },
      { base: appDb },
    )) as {
      ok: true;
      data: { nextCursor: string | null };
    };
    const cursor = first.data.nextCursor ?? "";
    expect(cursor).toContain("|");
    const second = await auditList(
      p,
      { limit: 1, scope: "all", cursor },
      { base: appDb },
    );
    expect(JSON.stringify(second)).not.toContain("nextCursor` from a previous");
    // ...and it really moved: the second page is not the first one again.
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
  });

  test("a tenant token still reads its own trail and only that", async () => {
    const text = JSON.stringify(
      await read(principal({ tenantId: mine, role: "TENANT_ADMIN" }), {}),
    );
    expect(text).toContain(`${TAG}:mine`);
    expect(text).not.toContain(`${TAG}:fleet`);
  });

  test("and is refused the wider scopes rather than narrowed to itself", async () => {
    const text = JSON.stringify(
      await read(principal({ tenantId: mine, role: "TENANT_ADMIN" }), {
        scope: "fleet",
      }),
    );
    expect(text).not.toContain(`${TAG}:mine`);
    expect(text).not.toContain(`${TAG}:fleet`);
  });
});
