import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient, type UserRole } from "@/../generated/prisma/client";
import config from "@/config";

// The consent DECISION, driven through its own door (#497).
//
// `tests/modules/mcp-oauth-consent.test.ts` proves the pending record and the approvals. This file
// answers what no module test can see: whether the row that records the decision shares the fate of
// the decision. Until #497 it did not — the grant committed, then a second transaction appended the
// row best-effort inside a `try/catch` that logged at warn — so a granted consent could leave
// nothing behind, and a reader cannot tell that from a consent that never happened.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

const suUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (suUrl && appUrl) {
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

// THE APP'S OWN CLIENT, not the shared stub. `setupPrismaMock` replaces `@/api/lib/prisma` with a
// mock carrying `user` and `tenant` only, so every request through this controller answered 500 on
// `mcpOAuthPendingAuthorization` — and two of the assertions below went GREEN on it, because "the
// grant did not stand" is also true when the request never reached the database. The principal is
// therefore a real row, and the transaction under test is a real one.
// The value the registry held before this file touched it, captured as the PROPERTY rather than as
// the namespace: `mock.module` rewrites the namespace object in place, so handing that object back
// at teardown puts nothing back (`tests/lib/module-mock-undo.test.ts` is the fence, and it
// caught this file doing exactly that). A fresh literal holding the original client does restore it.
const originalPrisma = (await import("@/api/lib/prisma")).default;
mock.module("@/api/lib/prisma", () => ({ default: app }));
// Top-level rather than inside the `describe`, since an `afterAll` in a describe that SKIPS never
// runs while the mock above is already installed for the whole worker.
afterAll(() => {
  mock.module("@/api/lib/prisma", () => ({ default: originalPrisma }));
});

// The audit write is wrapped rather than stubbed: every other file's assertions about `recordAudit`
// stay true, and this one only decides whether THIS call throws. `mock.module` is global to the
// worker, so a stub that swallowed the real behaviour would turn them all green for the wrong
// reason.
const auditSvc = await import("@/modules/audit/service");
const realAudit = { ...auditSvc };
let auditFails = false;
mock.module("@/modules/audit/service", () => ({
  ...realAudit,
  recordAudit: async (...args: Parameters<typeof realAudit.recordAudit>) => {
    if (auditFails) throw new Error("audit write refused (test)");
    return realAudit.recordAudit(...args);
  },
}));
afterAll(() => {
  mock.module("@/modules/audit/service", () => realAudit);
});

const server = (await import("@/app")).default;

const USER_ID = 9_497_101n;
const CLIENT = `seam-${process.pid}`;
const REDIRECT = "https://client.example/cb";
const PASSWORD = "the-step-up-password-9497";

let tenantId = 0n;
let cookie = "";
let signedIn: { id: bigint; tenantId: bigint | null; role: UserRole } = {
  id: USER_ID,
  tenantId: 0n,
  role: "TENANT_ADMIN",
};

async function signIn(as: typeof signedIn): Promise<string> {
  signedIn = as;
  const token = await new SignJWT({
    userId: as.id.toString(),
    email: `p${as.id}@seam497.test`,
    role: as.role,
    tenantId: as.tenantId === null ? null : as.tenantId.toString(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(config.jwtSecret));
  return `fazerai_auth_token=${token}`;
}

function req(path: string, init: RequestInit = {}): Request {
  return new BunRequest(`http://localhost/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...init.headers },
  });
}

// A pending authorization straight into the table, with the tenant the test needs. The state is
// what the flow would have parked; going through /authorize as well would test that endpoint again.
async function pending(
  tenant: bigint | null,
): Promise<{ requestId: string; csrf: string }> {
  const { createPendingAuthorization, issueConsentCsrf } = await import(
    "@/modules/mcp/oauth/consent"
  );
  const { requestId } = await createPendingAuthorization({
    clientId: CLIENT,
    userId: USER_ID,
    tenantId: tenant,
    redirectUri: REDIRECT,
    scopes: ["mcp:read"],
    codeChallenge: randomBytes(16).toString("base64url"),
    codeChallengeMethod: "S256",
    state: "xyz",
    base: suDb,
  });
  const csrf = await issueConsentCsrf(requestId, USER_ID, suDb);
  return { requestId, csrf: csrf as string };
}

const consentRows = async () =>
  suDb.auditLog.findMany({
    where: { actorId: USER_ID, action: { startsWith: "mcp_oauth_consent." } },
    orderBy: { id: "asc" },
  });

const codes = async () =>
  suDb.mcpOAuthAuthorizationCode.findMany({ where: { clientId: CLIENT } });

const approvals = async () =>
  suDb.mcpOAuthClientApproval.findMany({ where: { clientId: CLIENT } });

const pendings = async () =>
  suDb.mcpOAuthPendingAuthorization.findMany({ where: { clientId: CLIENT } });

async function clear(): Promise<void> {
  await suDb.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE actor_id = ${USER_ID}`,
  );
  await suDb.$executeRawUnsafe(
    `DELETE FROM mcp_oauth_authorization_codes WHERE client_id = '${CLIENT}'`,
  );
  await suDb.$executeRawUnsafe(
    `DELETE FROM mcp_oauth_client_approvals WHERE client_id = '${CLIENT}'`,
  );
  await suDb.$executeRawUnsafe(
    `DELETE FROM mcp_oauth_pending_authorizations WHERE client_id = '${CLIENT}'`,
  );
}

describe.skipIf(!dbUp)(
  "the consent decision and its row commit together",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Seam497", slug: `seam497-${process.pid}` },
      });
      tenantId = t.id;
      const { hashPassword } = await import("@/api/features/auth/auth.service");
      await suDb.user.create({
        data: {
          id: USER_ID,
          tenantId,
          email: `p${USER_ID}@seam497.test`,
          passwordHash: await hashPassword(PASSWORD),
          role: "TENANT_ADMIN",
        },
      });
      await suDb.mcpOAuthClient.create({
        data: {
          clientId: CLIENT,
          name: "Seam",
          redirectUris: [REDIRECT],
          grantTypes: ["authorization_code", "refresh_token"],
          scopes: ["mcp:read"],
        },
      });
      cookie = await signIn({ id: USER_ID, tenantId, role: "TENANT_ADMIN" });
      await clear();
    });

    afterAll(async () => {
      if (!dbUp) return;
      await clear();
      await suDb.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_clients WHERE client_id = '${CLIENT}'`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM users WHERE id = ${USER_ID}`);
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
      await suDb.$disconnect();
      await app?.$disconnect();
    });

    test("a grant records the decision on the tenant's trail", async () => {
      await clear();
      const { requestId, csrf } = await pending(tenantId);
      const res = await server.handle(
        req(`/v1/mcp/oauth/consent/${requestId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "approve", csrfToken: csrf }),
        }),
      );
      expect(res.status).toBe(200);
      const rows = await consentRows();
      expect(rows.map((r) => [r.action, r.tenantId])).toEqual([
        ["mcp_oauth_consent.grant", tenantId],
      ]);
      // The three writes the row now shares a transaction with, asserted as effects rather than as
      // calls: a code to exchange, the approval remembered so the next /authorize can skip consent,
      // and the request spent.
      expect({
        codes: (await codes()).length,
        approvals: (await approvals()).map((a) => a.scopes),
        consumed: (await pendings()).filter((p) => p.consumedAt !== null)
          .length,
      }).toEqual({ codes: 1, approvals: [["mcp:read"]], consumed: 1 });
    });

    // The denial's own happy path, which is not implied by the failure case below: an assertion that
    // only counts rows cannot tell a denial recorded as a denial from one recorded as a grant, and the
    // two branches write the action from different literals.
    test("a denial records a denial, and mints nothing", async () => {
      await clear();
      const { requestId, csrf } = await pending(tenantId);
      const res = await server.handle(
        req(`/v1/mcp/oauth/consent/${requestId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "deny", csrfToken: csrf }),
        }),
      );
      expect(res.status).toBe(200);
      const rows = await consentRows();
      expect(rows.map((r) => [r.action, r.tenantId])).toEqual([
        ["mcp_oauth_consent.deny", tenantId],
      ]);
      expect({
        codes: (await codes()).length,
        approvals: (await approvals()).length,
      }).toEqual({ codes: 0, approvals: 0 });
    });

    // THE POINT OF THE SEAM. With the row's write refused, the grant must not stand: no code to
    // exchange, no approval remembered, and the pending still unconsumed so the user can decide
    // again. Before #497 the three writes had already committed and only the row was missing, which
    // is the one outcome a trail must never produce — a grant nobody can read.
    test("a refused audit write takes the whole grant with it", async () => {
      await clear();
      const { requestId, csrf } = await pending(tenantId);
      auditFails = true;
      const res = await server.handle(
        req(`/v1/mcp/oauth/consent/${requestId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "approve", csrfToken: csrf }),
        }),
      );
      auditFails = false;
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect({
        rows: (await consentRows()).length,
        codes: (await codes()).length,
        approvals: (await approvals()).length,
        consumed: (await pendings()).filter((p) => p.consumedAt !== null)
          .length,
      }).toEqual({ rows: 0, codes: 0, approvals: 0, consumed: 0 });
    });

    // A DENIAL IS A MUTATION TOO: consuming the pending is the write, and the row belongs to it.
    test("a refused audit write leaves the denial undone as well", async () => {
      await clear();
      const { requestId, csrf } = await pending(tenantId);
      auditFails = true;
      const res = await server.handle(
        req(`/v1/mcp/oauth/consent/${requestId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "deny", csrfToken: csrf }),
        }),
      );
      auditFails = false;
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect({
        rows: (await consentRows()).length,
        consumed: (await pendings()).filter((p) => p.consumedAt !== null)
          .length,
      }).toEqual({ rows: 0, consumed: 0 });
    });

    // A FLEET-LEVEL SUPER_ADMIN, WITH A TENANT SELECTED IN THE CONSOLE. `/authorize` parks a
    // tenant-less pending for that principal on purpose, so the decision has to file fleet-level too —
    // and `X-Tenant-Id` is a SELECTOR, not the principal's tenant. Reading `ctx.tenantId` straight
    // would make the refusal below fire on a legitimate grant, or file the row on whatever tab the
    // admin had open, which is the same mistake `admin.service.ts` documents for its own family.
    test("a fleet admin's decision is fleet-level, whatever tenant is selected", async () => {
      await clear();
      const previous = cookie;
      cookie = await signIn({
        id: USER_ID,
        tenantId: null,
        role: "SUPER_ADMIN",
      });
      await suDb.$executeRawUnsafe(
        `UPDATE users SET role = 'SUPER_ADMIN', tenant_id = NULL WHERE id = ${USER_ID}`,
      );
      const { requestId, csrf } = await pending(null);
      const res = await server.handle(
        req(`/v1/mcp/oauth/consent/${requestId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "approve", csrfToken: csrf }),
          headers: { "x-tenant-id": String(tenantId) },
        }),
      );
      await suDb.$executeRawUnsafe(
        `UPDATE users SET role = 'TENANT_ADMIN', tenant_id = ${tenantId} WHERE id = ${USER_ID}`,
      );
      cookie = previous;
      expect(res.status).toBe(200);
      const rows = await consentRows();
      expect(rows.map((r) => [r.action, r.tenantId])).toEqual([
        ["mcp_oauth_consent.grant", null],
      ]);
    });

    // THE FOURTH BRANCH, which wrote nothing and did not even warn. `auditConsentDecision` dispatched
    // on the principal — SUPER_ADMIN, else a tenant, and no `else` — so a non-SUPER_ADMIN holding a
    // pending with a null tenant fell through in silence.
    //
    // Reachable only if the role changed inside the pending's 10-minute TTL, and measured: the only
    // producer of a null `tenantId` on a pending is a SUPER_ADMIN at /authorize, and `users_role_tenant_check`
    // forbids a SUPER_ADMIN with a tenant, while `updateUserRole` writes only the role — so demoting
    // one fails at the database today (that is #534). The state is therefore constructed here rather
    // than driven, because the app cannot reach it yet and the code must still answer when #534 is
    // fixed.
    test("a principal that no longer matches the pending is refused, not ignored", async () => {
      await clear();
      const { requestId, csrf } = await pending(null);
      const res = await server.handle(
        req(`/v1/mcp/oauth/consent/${requestId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "approve", csrfToken: csrf }),
        }),
      );
      expect(res.status).toBe(409);
      expect({
        rows: (await consentRows()).length,
        codes: (await codes()).length,
        consumed: (await pendings()).filter((p) => p.consumedAt !== null)
          .length,
      }).toEqual({ rows: 0, codes: 0, consumed: 0 });
    });
  },
);
