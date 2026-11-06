import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  markAccountIdentities,
  parseAccountCreatedAt,
} from "@/modules/chatwoot/account-identity";
import { dbProbeFailed } from "@/tests/db-gate";
import { fakeInstallation, seedChatwootInstance } from "../utils/chatwoot";

// Rows connected before the account's identity was recorded get it from the reconcile pass, which
// runs this. A row whose account another tenant already holds under the same identity is left as it
// is: the two tenants own one account, and the pass neither picks a winner nor breaks either.
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

const install = fakeInstallation("backfill");
const made: bigint[] = [];
let seq = 0;
async function legacyTenant(baseUrl: string, accountId: number) {
  const t = await suDb.tenant.create({
    data: { name: "BF", slug: `acct-backfill-${process.pid}-${seq++}` },
  });
  made.push(t.id);
  const row = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    accountId,
    baseUrl,
    adminToken: encryptJson("tok"),
  });
  return { tenantId: t.id, instanceId: row.id };
}
async function identityOf(instanceId: bigint) {
  return (
    await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { accountCreatedAt: true },
    })
  ).accountCreatedAt;
}

describe("parseAccountCreatedAt", () => {
  test("reads the instant of the account the response describes", () => {
    expect(
      parseAccountCreatedAt(
        { id: 7, created_at: "2026-11-05T21:57:37.015Z" },
        7,
      )?.toISOString(),
    ).toBe("2026-11-05T21:57:37.015Z");
    expect(
      parseAccountCreatedAt(
        { id: "7", created_at: "2026-11-05T18:57:37.015-03:00" },
        7,
      )?.toISOString(),
    ).toBe("2026-11-05T21:57:37.015Z");
  });

  test("refuses another account, a missing instant and an unreadable one", () => {
    expect(
      parseAccountCreatedAt(
        { id: 8, created_at: "2026-11-05T21:57:37.015Z" },
        7,
      ),
    ).toBeNull();
    expect(parseAccountCreatedAt({ id: 7 }, 7)).toBeNull();
    expect(parseAccountCreatedAt({ id: 7, created_at: "soon" }, 7)).toBeNull();
    expect(parseAccountCreatedAt([{ id: 7 }], 7)).toBeNull();
  });
});

describe.skipIf(!dbUp)("markAccountIdentities", () => {
  afterAll(async () => {
    for (const tid of made) {
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

  test("records the identity of an account connected before it existed, paused ones included", async () => {
    const a = await legacyTenant("http://127.0.0.1:9", 11);
    await suDb.chatwootInstance.update({
      where: { id: a.instanceId },
      data: { disconnectedAt: new Date() },
    });
    expect(await identityOf(a.instanceId)).toBeNull();
    const r = await markAccountIdentities(
      a.tenantId,
      { fetchAccount: install.fetchAccount },
      appDb,
    );
    expect(r).toEqual({ marked: 1, unreadable: 0, heldElsewhere: [] });
    expect((await identityOf(a.instanceId))?.getTime()).toBe(
      install.createdAt(11).getTime(),
    );
  });

  test("an account another tenant holds through another address is left as it is, still connected", async () => {
    const first = await legacyTenant("http://127.0.0.1:9", 12);
    const second = await legacyTenant("http://localhost:9", 12);
    await markAccountIdentities(
      first.tenantId,
      { fetchAccount: install.fetchAccount },
      appDb,
    );
    const r = await markAccountIdentities(
      second.tenantId,
      { fetchAccount: install.fetchAccount },
      appDb,
    );
    expect(r).toEqual({ marked: 0, unreadable: 0, heldElsewhere: [12] });
    expect(await identityOf(second.instanceId)).toBeNull();
    const row = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: second.instanceId },
      select: { disconnectedAt: true },
    });
    expect(row.disconnectedAt).toBeNull();
  });

  test("a Chatwoot that does not answer leaves the row for the next pass", async () => {
    const a = await legacyTenant("http://127.0.0.1:9", 13);
    const r = await markAccountIdentities(
      a.tenantId,
      {
        fetchAccount: async () => {
          throw new Error("offline");
        },
      },
      appDb,
    );
    expect(r).toEqual({ marked: 0, unreadable: 1, heldElsewhere: [] });
    expect(await identityOf(a.instanceId)).toBeNull();
    const again = await markAccountIdentities(
      a.tenantId,
      { fetchAccount: install.fetchAccount },
      appDb,
    );
    expect(again.marked).toBe(1);
  });
});
