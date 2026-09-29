import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  normalizeChatwootBaseUrl,
  setConnectedAccounts,
} from "@/modules/chatwoot/management";
import { seedChatwootInstance, withRunNamespace } from "../utils/chatwoot";

// A Chatwoot ACCOUNT (server + accountId) is globally unique to one tenant, even though a server can
// back many tenants. Needs a real Postgres for the unique index + the superuser cross-tenant guard.
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

// Loopback on the discard port, NOT a hostname. The best-effort provisioning call inside
// setConnectedAccounts reaches out with this base URL; a real hostname made the test depend on DNS
// (it "passed" only because the name failed to resolve), and a public IP literal has nowhere to
// fail fast, so the connect hung until the 5s test timeout. Loopback is refused by the SSRF guard
// immediately, offline, and the caller already tolerates the failure.
const SHARED = "https://127.0.0.1:9";
// Probe stub: the accounts the (shared) server's admin token can reach.
const deps = {
  fetchProfile: async () => ({
    accounts: [
      { id: 5, name: "Acc 5" },
      { id: 8, name: "Acc 8" },
      { id: 9, name: "Acc 9" },
    ],
  }),
};

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: 1n, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("Chatwoot account uniqueness (shared server)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let tenantC = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "AU-A", slug: `au-a-${process.pid}` },
    });
    const b = await suDb.tenant.create({
      data: { name: "AU-B", slug: `au-b-${process.pid}` },
    });
    const c = await suDb.tenant.create({
      data: { name: "AU-C", slug: `au-c-${process.pid}` },
    });
    tenantA = a.id;
    tenantB = b.id;
    tenantC = c.id;
    // Tenant A owns account 5 on the SHARED server.
    await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      accountId: 5,
      baseUrl: SHARED,
      adminToken: encryptJson("tok"),
    });
    // Tenant B is on the SAME server but owns account 9 (creates B's deployment at SHARED).
    await seedChatwootInstance(suDb, {
      tenantId: tenantB,
      accountId: 9,
      baseUrl: SHARED,
      adminToken: encryptJson("tok"),
    });
    // Tenant C is on a DIFFERENT server.
    await seedChatwootInstance(suDb, {
      tenantId: tenantC,
      accountId: 1,
      baseUrl: "https://127.0.0.2:9",
      adminToken: encryptJson("tok"),
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB, tenantC]) {
      if (!tid) continue;
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

  test("claiming an account owned by ANOTHER tenant on the same server → conflict", async () => {
    let caught: unknown;
    try {
      // Tenant B tries to claim account 5 (owned by A) on the shared server.
      await setConnectedAccounts(ctx(tenantB), [9, 5], deps, appDb);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).translationKey).toBe(
      "errors.chatwootAccountTaken",
    );
    // No instance row for (tenant B, account 5) was created.
    const leaked = await suDb.chatwootInstance.count({
      where: { tenantId: tenantB, accountId: 5 },
    });
    expect(leaked).toBe(0);
  });

  test("claiming a FREE account on the shared server succeeds (serverKey set)", async () => {
    await setConnectedAccounts(ctx(tenantB), [9, 8], deps, appDb);
    const row = await suDb.chatwootInstance.findFirst({
      where: { tenantId: tenantB, accountId: 8 },
      select: { serverKey: true, disconnectedAt: true },
    });
    expect(row?.serverKey).toBe(
      normalizeChatwootBaseUrl(withRunNamespace(SHARED)),
    );
    expect(row?.disconnectedAt).toBeNull();
  });

  test("the SAME accountId on a DIFFERENT server is allowed (distinct serverKey)", async () => {
    // Tenant C (other server) claims account 5 — no collision with A's account 5 on SHARED.
    await setConnectedAccounts(
      ctx(tenantC),
      [1, 5],
      {
        fetchProfile: async () => ({
          accounts: [
            { id: 1, name: "C1" },
            { id: 5, name: "C5" },
          ],
        }),
      },
      appDb,
    );
    const row = await suDb.chatwootInstance.findFirst({
      where: { tenantId: tenantC, accountId: 5 },
      select: { id: true },
    });
    expect(row).not.toBeNull();
  });
});
