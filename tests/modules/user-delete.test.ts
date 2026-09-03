import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  CannotDeleteSelfError,
  deleteUser,
  LastAdminError,
  UserNotInScopeError,
} from "@/api/features/admin/admin.service";
import type { TenantContext } from "@/lib/tenancy";

// The caller, as the principal the delete now records itself under (#400): its tenant is the scope
// the target has to fall inside, and its user is the one the self-delete guard compares against.
const actor = (tenantId: bigint, userId: bigint): TenantContext => ({
  tenantId,
  userId,
  role: "TENANT_ADMIN",
});

// deleteUser takes an injectable `base` (the users table is global/RLS-exempt). We pass the app-role
// client and seed/assert with the superuser one. Needs a real Postgres.
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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

describe.skipIf(!dbUp)("deleteUser (guards)", () => {
  let tenantId = 0n;
  let otherTenantId = 0n;
  let admin1 = 0n;
  let admin2 = 0n;
  let agent1 = 0n;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DU", slug: `du-${process.pid}` },
    });
    const other = await suDb.tenant.create({
      data: { name: "DU2", slug: `du2-${process.pid}` },
    });
    tenantId = t.id;
    otherTenantId = other.id;
    const mk = (email: string, role: "TENANT_ADMIN" | "AGENT") =>
      suDb.user.create({
        // passwordHash satisfies the users_auth_method_check (a user needs an auth method).
        data: {
          tenantId,
          email: `${email}-${process.pid}@x.test`,
          role,
          passwordHash: "x",
        },
        select: { id: true },
      });
    admin1 = (await mk("a1", "TENANT_ADMIN")).id;
    admin2 = (await mk("a2", "TENANT_ADMIN")).id;
    agent1 = (await mk("ag", "AGENT")).id;
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id IN (${tenantId}, ${otherTenantId})`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id IN (${tenantId}, ${otherTenantId})`,
    );
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("cannot delete yourself", async () => {
    await expect(
      deleteUser(actor(tenantId, admin1), admin1, appDb),
    ).rejects.toBeInstanceOf(CannotDeleteSelfError);
  });

  test("out-of-scope target → not found", async () => {
    // agent1 is in `tenantId`, not in otherTenantId → fenced out.
    await expect(
      deleteUser(actor(otherTenantId, 999_999n), agent1, appDb),
    ).rejects.toBeInstanceOf(UserNotInScopeError);
    expect(await suDb.user.count({ where: { id: agent1 } })).toBe(1);
  });

  test("deletes a regular user", async () => {
    await deleteUser(actor(tenantId, admin1), agent1, appDb);
    expect(await suDb.user.count({ where: { id: agent1 } })).toBe(0);
  });

  test("refuses to delete the LAST admin of a tenant", async () => {
    // Two admins (admin1, admin2). Deleting admin1 is fine — admin2 remains.
    await deleteUser(actor(tenantId, admin2), admin1, appDb);
    expect(await suDb.user.count({ where: { id: admin1 } })).toBe(0);
    // admin2 is now the last TENANT_ADMIN → blocked.
    await expect(
      deleteUser(actor(tenantId, 999_999n), admin2, appDb),
    ).rejects.toBeInstanceOf(LastAdminError);
    expect(await suDb.user.count({ where: { id: admin2 } })).toBe(1);
  });
});
