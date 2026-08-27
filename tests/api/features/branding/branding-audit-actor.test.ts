import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// The branding trail, driven through a real request all the way to the row.
//
// The row is the service's to write now, and it can only name who wrote it if the transport passes a
// principal. `tests/modules/audit-tenant-family.test.ts` proves the services record; this proves the
// door reaches them with an actor, which no service test can see.
//
// Two things are asserted together on purpose. The actor's `tenantId` is NULL even though this admin
// has a tenant selected, because branding is the whole deployment's identity. And a write with no
// session never reaches the service: the actor is resolved per WRITE HANDLER rather than by mounting
// the tenancy plugin, precisely so the identity config the login page loads, and the favicon, keep
// costing nothing.
//
// The service is wrapped rather than replaced, and the wrapper CALLS THROUGH. `mock.module` is global
// to the process and outlives this file for every other one in the same worker: a stub that swallowed
// the real behavior turns `branding.test.ts` green for the wrong reason, since that file asserts this
// same function's validation throws. Measured, not guessed: replacing it made two of its tests end
// with zero assertions. All the wrapper does is record the context and hand the write the test
// database, which the controller has no way to inject.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

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

setupPrismaMock();

const admin = await import("@/api/features/branding/branding.admin.service");
// A COPY, taken before the mock is installed. Bun updates the imported namespace in place, so
// `admin.updateBrandingColors` read after `mock.module` is the wrapper itself, and a wrapper that
// calls through by that name calls ITSELF: the pass-through below came back as a RangeError from a
// blown stack, not as the AppError the real validation raises.
const real = { ...admin };
const seen: TenantContext[] = [];
mock.module("@/api/features/branding/branding.admin.service", () => ({
  ...real,
  updateBrandingColors: mock(
    async (
      ctx: TenantContext,
      input: Parameters<typeof admin.updateBrandingColors>[1],
    ) => {
      seen.push(ctx);
      return real.updateBrandingColors(ctx, input, app);
    },
  ),
  clearBrandingAsset: mock(
    async (
      ctx: TenantContext,
      kind: Parameters<typeof admin.clearBrandingAsset>[1],
      variant: Parameters<typeof admin.clearBrandingAsset>[2],
    ) => {
      seen.push(ctx);
      return real.clearBrandingAsset(ctx, kind, variant, app);
    },
  ),
}));

const server = (await import("@/app")).default;

const ADMIN_ID = 5150n;

afterAll(async () => {
  mock.module("@/api/features/branding/branding.admin.service", () => real);
  // `dbUp`, not `su`: the probe assigns the client and THEN checks the connection, so a database
  // that is configured but unreachable leaves `su` truthy with `dbUp` false. The suite skips, and
  // this hook would still issue a DELETE and fail the file under `ALLOW_NO_DB=1`.
  if (dbUp && su) {
    await su.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE actor_id = ${ADMIN_ID}`,
    );
    await su.$executeRawUnsafe(`DELETE FROM app_branding WHERE id = 1`);
  }
  await su?.$disconnect();
  await app?.$disconnect();
});

const superAdmin = {
  ...mockUser,
  id: ADMIN_ID,
  tenantId: null,
  role: "SUPER_ADMIN" as const,
};
mockFindUnique.mockImplementation(() => Promise.resolve(superAdmin));
const fleetRows = async () =>
  (await su?.auditLog.findMany({
    where: { actorId: ADMIN_ID },
    orderBy: { id: "asc" },
  })) ?? [];

const reset = async () => {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE actor_id = ${ADMIN_ID}`,
  );
};

describe.skipIf(!dbUp)("the branding transport names who wrote", () => {
  beforeAll(async () => {
    await su?.$executeRawUnsafe(`DELETE FROM app_branding WHERE id = 1`);
  });
  test("a write with no session is refused before reaching the service", async () => {
    seen.length = 0;
    await reset();
    const res = await server.handle(
      new BunRequest("http://localhost/api/v1/branding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandName: "nope" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
    expect(await fleetRows()).toEqual([]);
  });
});
