import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient, type UserRole } from "@/../generated/prisma/client";
import { hashPassword } from "@/api/features/auth/auth.service";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The actor family's trail, driven through the console's own doors (issue #400).
//
// `tests/modules/audit-actor-family.test.ts` proves the SERVICES record. This file answers the half
// no service test can see: whether the doors reach them with a principal, and WHICH principal.
//
// That second half is the whole reason these two controllers are wired differently from every other
// audited family, and the difference is invisible from either side alone. `admin.controller.ts` runs
// on `authPlugin` and builds its context by hand, because its scope is the caller's HOME tenant: a
// SUPER_ADMIN has none, which is what lets them re-role across tenants. Mounting `tenancyPlugin`
// there — the obvious tidy-up, and what every sibling controller does — would hand these routes the
// `X-Tenant-Id` SELECTOR instead, and a fleet admin with a tenant open in one tab would silently
// lose the ability to administer anyone outside it. The last two tests are that fence.

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

const adminSvc = await import("@/api/features/admin/admin.service");
const inviteSvc = await import("@/api/features/invitations/invitation.service");
const mcpAdmin = await import("@/modules/mcp/oauth/admin");
// COPIES taken before the mocks are installed: Bun updates the imported namespace in place, so a
// wrapper that called the module by name would call itself.
const realAdmin = { ...adminSvc };
const realInvite = { ...inviteSvc };
const realMcp = { ...mcpAdmin };

// The wrappers CALL THROUGH and do nothing but hand the write the test database, which the
// controllers have no way to inject. `mock.module` is global to the worker, so a stub that swallowed
// the real behaviour would turn every other file's assertions about these functions green for the
// wrong reason.
mock.module("@/api/features/admin/admin.service", () => ({
  ...realAdmin,
  updateUserRole: mock(
    (
      ctx: TenantContext,
      id: bigint,
      role: Parameters<typeof adminSvc.updateUserRole>[2],
    ) => realAdmin.updateUserRole(ctx, id, role, app),
  ),
  deleteUser: mock((ctx: TenantContext, id: bigint) =>
    realAdmin.deleteUser(ctx, id, app),
  ),
}));

mock.module("@/api/features/invitations/invitation.service", () => ({
  ...realInvite,
  createInvite: mock(
    (ctx: TenantContext, p: Parameters<typeof inviteSvc.createInvite>[1]) =>
      realInvite.createInvite(ctx, p, app),
  ),
  revokeInvite: mock((ctx: TenantContext, id: bigint) =>
    realInvite.revokeInvite(ctx, id, app),
  ),
}));

mock.module("@/modules/mcp/oauth/admin", () => ({
  ...realMcp,
  createClient: mock(
    (ctx: TenantContext, input: Parameters<typeof mcpAdmin.createClient>[1]) =>
      realMcp.createClient(ctx, input, app),
  ),
  deleteClient: mock((ctx: TenantContext, clientId: string) =>
    realMcp.deleteClient(ctx, clientId, app),
  ),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does NOT
// run, while this one does, and the wrappers are already installed for the whole worker.
afterAll(() => {
  mock.module("@/api/features/admin/admin.service", () => realAdmin);
  mock.module(
    "@/api/features/invitations/invitation.service",
    () => realInvite,
  );
  mock.module("@/modules/mcp/oauth/admin", () => realMcp);
});

const PASSWORD = "the-step-up-password-9400";
let passwordHash = "";

const TENANT_ADMIN_ID = 9_400_101n;
const FLEET_ADMIN_ID = 9_400_102n;

let tenantA = 0n;
let tenantB = 0n;

// The signed-in principal, swapped per test. The auth plugin decodes the cookie and then reads the
// user row through the mocked client, so both halves move together.
let signedIn: { id: bigint; tenantId: bigint | null; role: UserRole } = {
  id: TENANT_ADMIN_ID,
  tenantId: 0n,
  role: "TENANT_ADMIN",
};

async function signIn(as: typeof signedIn): Promise<string> {
  signedIn = as;
  const token = await new SignJWT({
    userId: as.id.toString(),
    email: `p${as.id}@aud400.test`,
    role: as.role,
    tenantId: as.tenantId === null ? null : as.tenantId.toString(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(config.jwtSecret));
  return `fazerai_auth_token=${token}`;
}

let cookie = "";

function req(path: string, init: RequestInit = {}): Request {
  return new BunRequest(`http://localhost/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...init.headers },
  });
}

// A tenant trail is isolated by its tenant. The FLEET trail (`tenant_id NULL`) is NOT: it is shared
// with every other file running against this database, so it is read by ACTOR. Measured, not
// guessed — without the actor filter this file read `tests/modules/mcp-admin.test.ts`'s fleet rows
// as its own and reported the wrong principal on a row it had just written correctly.
const rowsOf = async (of: bigint | null, action?: string) =>
  (await su?.auditLog.findMany({
    where: {
      tenantId: of,
      ...(of === null
        ? { actorId: { in: [TENANT_ADMIN_ID, FLEET_ADMIN_ID] } }
        : {}),
      ...(action ? { action } : {}),
    },
    orderBy: { id: "asc" },
  })) ?? [];

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id IN (${tenantA}, ${tenantB}) OR actor_id IN (${TENANT_ADMIN_ID}, ${FLEET_ADMIN_ID})`,
  );
}

const uniq = () => `${process.pid}${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!dbUp)("the admin pages name who wrote", () => {
  const createdClientIds: string[] = [];

  beforeAll(async () => {
    if (!su || !app) return;
    passwordHash = await hashPassword(PASSWORD);
    const a = await su.tenant.create({
      data: { name: "ACTREST", slug: `actrest-${process.pid}` },
    });
    const b = await su.tenant.create({
      data: { name: "ACTRESTB", slug: `actrestb-${process.pid}` },
    });
    tenantA = a.id;
    tenantB = b.id;
    signedIn = { id: TENANT_ADMIN_ID, tenantId: tenantA, role: "TENANT_ADMIN" };
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: signedIn.id,
        tenantId: signedIn.tenantId,
        email: `p${signedIn.id}@aud400.test`,
        passwordHash,
        googleId: null,
        name: null,
        role: signedIn.role,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    cookie = await signIn(signedIn);
    await clearAudit();
  });

  afterAll(async () => {
    if (dbUp && su) {
      for (const clientId of createdClientIds) {
        await su.$executeRawUnsafe(
          `DELETE FROM mcp_oauth_clients WHERE client_id = '${clientId}'`,
        );
      }
      await clearAudit();
      for (const id of [tenantA, tenantB]) {
        if (id) {
          await su.$executeRawUnsafe(
            `DELETE FROM users WHERE tenant_id = ${id}`,
          );
          await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
        }
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  async function seedUser(of: bigint, role: UserRole = "AGENT") {
    return await (su as PrismaClient).user.create({
      data: {
        tenantId: of,
        email: `t${uniq()}@aud400.test`,
        passwordHash: "x",
        role,
      },
      select: { id: true, email: true },
    });
  }

  test("a tenant admin re-roling from the console leaves a row naming them", async () => {
    cookie = await signIn({
      id: TENANT_ADMIN_ID,
      tenantId: tenantA,
      role: "TENANT_ADMIN",
    });
    const target = await seedUser(tenantA);
    await clearAudit();
    const res = await server.handle(
      req(`/admin/users/${target.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role: "TENANT_ADMIN" }),
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await rowsOf(tenantA, "user.role_set");
    expect(row?.actorId).toBe(TENANT_ADMIN_ID);
    expect(row?.actorType).toBe("user");
    expect(row?.after).toMatchObject({ role: "TENANT_ADMIN" });
  });

  test("deleting a user from the console records what the account was", async () => {
    cookie = await signIn({
      id: TENANT_ADMIN_ID,
      tenantId: tenantA,
      role: "TENANT_ADMIN",
    });
    const target = await seedUser(tenantA);
    await clearAudit();
    const res = await server.handle(
      req(`/admin/users/${target.id}`, {
        method: "DELETE",
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await rowsOf(tenantA, "user.delete");
    expect(row?.actorId).toBe(TENANT_ADMIN_ID);
    expect(row?.before).toMatchObject({ email: target.email });
    expect(
      await (su as PrismaClient).user.count({ where: { id: target.id } }),
    ).toBe(0);
  });

  test("inviting from the console records the invitation, never its token", async () => {
    cookie = await signIn({
      id: TENANT_ADMIN_ID,
      tenantId: tenantA,
      role: "TENANT_ADMIN",
    });
    await clearAudit();
    const email = `invited${uniq()}@aud400.test`;
    const res = await server.handle(
      req("/admin/invitations", {
        method: "POST",
        body: JSON.stringify({ email, role: "AGENT" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invite: { id: string; acceptUrl: string };
    };
    const [row] = await rowsOf(tenantA, "invitation.create");
    expect(row?.actorId).toBe(TENANT_ADMIN_ID);
    expect(row?.after).toMatchObject({ email, role: "AGENT" });
    // The accept link carries the plaintext token exactly once, to the inviter's clipboard. It must
    // not also be sitting in a table the tenant's other admins can read.
    const token = new URL(body.invite.acceptUrl).searchParams.get("token");
    expect(token).toBeTruthy();
    expect(
      JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toContain(token as string);

    await clearAudit();
    expect(
      (
        await server.handle(
          req(`/admin/invitations/${body.invite.id}`, { method: "DELETE" }),
        )
      ).status,
    ).toBe(200);
    expect((await rowsOf(tenantA, "invitation.revoke")).length).toBe(1);
  });

  test("a fleet admin's reach is their own, not the tenant the console has selected", async () => {
    cookie = await signIn({
      id: FLEET_ADMIN_ID,
      tenantId: null,
      role: "SUPER_ADMIN",
    });
    const target = await seedUser(tenantB);
    await clearAudit();
    // The header names tenant A; the target lives in tenant B. This succeeds because the scope comes
    // from the PRINCIPAL (a SUPER_ADMIN has no home tenant, so no fence), and it is exactly what
    // mounting the tenancy plugin here would break — the selector would fence the write to A and
    // answer 404 for a user the fleet admin is entitled to administer.
    const res = await server.handle(
      req(`/admin/users/${target.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role: "TENANT_ADMIN" }),
        headers: { "x-tenant-id": String(tenantA) },
      }),
    );
    expect(res.status).toBe(200);
    // And the row joins the trail of the tenant the change HAPPENED to, which is neither the actor's
    // (they have none) nor the one the header named.
    const [row] = await rowsOf(tenantB, "user.role_set");
    expect(row?.actorId).toBe(FLEET_ADMIN_ID);
    expect(await rowsOf(tenantA, "user.role_set")).toEqual([]);
    expect(await rowsOf(null, "user.role_set")).toEqual([]);
  });

  test("the MCP admin surface records fleet rows with a tenant selected", async () => {
    cookie = await signIn({
      id: FLEET_ADMIN_ID,
      tenantId: null,
      role: "SUPER_ADMIN",
    });
    await clearAudit();
    const created = await server.handle(
      req("/v1/mcp/admin/clients", {
        method: "POST",
        body: JSON.stringify({
          name: "Console client",
          redirectUris: ["https://console.example.com/cb"],
        }),
        headers: { "x-tenant-id": String(tenantA) },
      }),
    );
    expect(created.status).toBe(200);
    const { client } = (await created.json()) as {
      client: { clientId: string };
    };
    createdClientIds.push(client.clientId);

    const [row] = await rowsOf(null, "mcp_client.create");
    expect(row?.actorId).toBe(FLEET_ADMIN_ID);
    expect(row?.tenantId).toBeNull();
    expect(await rowsOf(tenantA, "mcp_client.create")).toEqual([]);

    expect(
      (
        await server.handle(
          req(`/v1/mcp/admin/clients/${client.clientId}`, {
            method: "DELETE",
            headers: { "x-tenant-id": String(tenantA) },
          }),
        )
      ).status,
    ).toBe(200);
    expect((await rowsOf(null, "mcp_client.delete")).length).toBe(1);
  });
});
