import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { setConnectedAccounts } from "@/modules/chatwoot/management";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { deploymentSetAccounts } from "@/modules/mcp/write-channels";
import { dbProbeFailed } from "@/tests/db-gate";
import { fakeInstallation, withRunNamespace } from "../utils/chatwoot";

// One Chatwoot installation reached by two tenants through two of its addresses. The address does
// not identify the installation, so an account one tenant holds must be refused to the other however
// it is reached. Loopback addresses: the SSRF guard refuses them offline, so the best-effort calls
// that follow a connect fail fast instead of reaching anything.
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const VIA_IP = "http://127.0.0.1:9";
const VIA_NAME = "http://localhost:9";
const OTHER_INSTALL = "http://127.0.0.2:9";

const profile = {
  fetchProfile: async () => ({
    accounts: Array.from({ length: 12 }, (_, i) => i + 1).map((id) => ({
      id,
      name: `Acc ${id}`,
    })),
  }),
};
const install = fakeInstallation("one");
const sameInstall = { ...profile, fetchAccount: install.fetchAccount };

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: 1n, role: "TENANT_ADMIN" };
}

function principal(tenantId: bigint): VerifiedToken {
  return {
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    clientId: "c",
    jti: "j",
  };
}

const made: bigint[] = [];
let seq = 0;
async function tenantAt(baseUrl: string): Promise<bigint> {
  const t = await suDb.tenant.create({
    data: { name: "AI", slug: `acct-identity-${process.pid}-${seq++}` },
  });
  made.push(t.id);
  await suDb.chatwootDeployment.create({
    data: {
      tenantId: t.id,
      baseUrl: withRunNamespace(baseUrl),
      adminToken: encryptJson("tok"),
    },
  });
  return t.id;
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { translationKey?: string }).translationKey ?? String(e);
  }
}

async function owners(accountId: number): Promise<bigint[]> {
  const rows = await suDb.chatwootInstance.findMany({
    where: { accountId, tenantId: { in: made }, disconnectedAt: null },
    select: { tenantId: true },
    orderBy: { tenantId: "asc" },
  });
  return rows.map((r) => r.tenantId);
}

describe.skipIf(!dbUp)("Chatwoot account identity across addresses", () => {
  beforeAll(() => {
    expect(made).toHaveLength(0);
  });

  afterAll(async () => {
    for (const tid of made) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_deployments WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("an account held through one address is refused through another address of the same Chatwoot", async () => {
    const t1 = await tenantAt(VIA_IP);
    const t2 = await tenantAt(VIA_NAME);
    expect(
      await outcome(setConnectedAccounts(ctx(t1), [1], sameInstall, appDb)),
    ).toBe("ok");
    expect(
      await outcome(setConnectedAccounts(ctx(t2), [1], sameInstall, appDb)),
    ).toBe("errors.chatwootAccountTaken");
    expect(await owners(1)).toEqual([t1]);
  });

  test("the MCP preview refuses the same claim the apply refuses", async () => {
    const t1 = await tenantAt(VIA_IP);
    const t2 = await tenantAt(VIA_NAME);
    await setConnectedAccounts(ctx(t1), [2], sameInstall, appDb);
    const r = await deploymentSetAccounts(
      principal(t2),
      { account_ids: [2] },
      { base: appDb, ...sameInstall },
    );
    expect(r.ok).toBe(false);
    expect(await owners(2)).toEqual([t1]);
  });

  test("a request with one taken account and one free is refused before anything is connected", async () => {
    const t1 = await tenantAt(VIA_IP);
    const t2 = await tenantAt(VIA_NAME);
    await setConnectedAccounts(ctx(t1), [4], sameInstall, appDb);
    expect(
      await outcome(setConnectedAccounts(ctx(t2), [3, 4], sameInstall, appDb)),
    ).toBe("errors.chatwootAccountTaken");
    expect(await owners(3)).toEqual([]);
    expect(await owners(4)).toEqual([t1]);
  });

  test("two claims through two addresses at once leave one owner", async () => {
    const t1 = await tenantAt(VIA_IP);
    const t2 = await tenantAt(VIA_NAME);
    // Both reads of the account wait for each other, so both claim checks run before either
    // write and only the database can decide between them.
    let arrived = 0;
    let release: () => void = () => {};
    const together = new Promise<void>((r) => {
      release = r;
    });
    const rendezvous = {
      ...profile,
      fetchAccount: async (p: { accountId: number }) => {
        arrived += 1;
        if (arrived === 2) release();
        await together;
        return install.fetchAccount(p);
      },
    };
    const results = await Promise.all([
      outcome(setConnectedAccounts(ctx(t1), [5], rendezvous, appDb)),
      outcome(setConnectedAccounts(ctx(t2), [5], rendezvous, appDb)),
    ]);
    expect(arrived).toBe(2);
    expect(results.sort()).toEqual(["errors.chatwootAccountTaken", "ok"]);
    expect(await owners(5)).toHaveLength(1);
  });

  test("the same account id on ANOTHER installation is not the same account", async () => {
    const t1 = await tenantAt(VIA_IP);
    const t2 = await tenantAt(OTHER_INSTALL);
    const other = fakeInstallation("two");
    await setConnectedAccounts(ctx(t1), [6], sameInstall, appDb);
    expect(
      await outcome(
        setConnectedAccounts(
          ctx(t2),
          [6],
          { ...profile, fetchAccount: other.fetchAccount },
          appDb,
        ),
      ),
    ).toBe("ok");
    expect(await owners(6)).toEqual([t1, t2]);
  });

  test("a claim whose account cannot be read from Chatwoot is refused and writes nothing", async () => {
    const t1 = await tenantAt(VIA_IP);
    const r = await outcome(
      setConnectedAccounts(
        ctx(t1),
        [7],
        {
          ...profile,
          fetchAccount: async () => {
            throw new Error("offline");
          },
        },
        appDb,
      ),
    );
    expect(r).toBe("errors.chatwootProfileFailed");
    expect(await owners(7)).toEqual([]);
  });

  test("a tenant reconnecting its own paused account records its identity", async () => {
    const t1 = await tenantAt(VIA_IP);
    await setConnectedAccounts(ctx(t1), [8], sameInstall, appDb);
    await suDb.chatwootInstance.updateMany({
      where: { tenantId: t1, accountId: 8 },
      data: { disconnectedAt: new Date(), accountCreatedAt: null },
    });
    expect(
      await outcome(setConnectedAccounts(ctx(t1), [8], sameInstall, appDb)),
    ).toBe("ok");
    const row = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId: t1, accountId: 8 },
      select: { accountCreatedAt: true, disconnectedAt: true },
    });
    expect(row.disconnectedAt).toBeNull();
    expect(row.accountCreatedAt?.getTime()).toBe(
      install.createdAt(8).getTime(),
    );
  });

  test("an account read that carries no creation instant is refused like one that failed", async () => {
    const t1 = await tenantAt(VIA_IP);
    const r = await outcome(
      setConnectedAccounts(
        ctx(t1),
        [9],
        { ...profile, fetchAccount: async () => ({ id: 9, name: "Acc 9" }) },
        appDb,
      ),
    );
    expect(r).toBe("errors.chatwootProfileFailed");
    expect(await owners(9)).toEqual([]);
  });

  test("a paused account reconnected while another tenant claims it through another address is refused, not crashed", async () => {
    const t1 = await tenantAt(VIA_IP);
    const t2 = await tenantAt(VIA_NAME);
    await setConnectedAccounts(ctx(t1), [10], sameInstall, appDb);
    await suDb.chatwootInstance.updateMany({
      where: { tenantId: t1, accountId: 10 },
      data: { disconnectedAt: new Date(), accountCreatedAt: null },
    });
    // Holding t1's deployment row keeps its reconnect after its claim checks and before its write,
    // so t2's claim commits in between and only the unique index can answer t1.
    const hold = new Client({ connectionString: suUrl });
    await hold.connect();
    await hold.query("BEGIN");
    await hold.query(
      "SELECT id FROM chatwoot_deployments WHERE tenant_id = $1 FOR UPDATE",
      [String(t1)],
    );
    const reconnect = outcome(
      setConnectedAccounts(ctx(t1), [10], sameInstall, appDb),
    );
    // Polled from its own connection: inside the holding transaction pg_stat_activity is a
    // snapshot taken at its first read and never shows the wait.
    const probe = new Client({ connectionString: suUrl });
    await probe.connect();
    let waiting = 0;
    for (let i = 0; i < 200 && waiting === 0; i++) {
      const r = await probe.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%chatwoot_deployments%FOR NO KEY UPDATE%'",
      );
      waiting = r.rows[0].n;
      if (waiting === 0) await Bun.sleep(25);
    }
    await probe.end();
    expect(waiting).toBe(1);
    const claim = await outcome(
      setConnectedAccounts(ctx(t2), [10], sameInstall, appDb),
    );
    await hold.query("COMMIT");
    await hold.end();
    expect(claim).toBe("ok");
    expect(await reconnect).toBe("errors.chatwootAccountTaken");
    expect(await owners(10)).toEqual([t2]);
  });
});
