import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";

// Issue #756, through the app's own doors: a person is ONE user with a membership per tenant.
//
// The issue opened on the symptom: two rows with the same email in two tenants, and the login
// picking one with no order at all, so the operator saw the empty tenant and nothing said why. What
// replaced it is asserted here end to end, against real rows: one login, the tenant chosen per
// request among the person's memberships, a tenant they do not belong to refused (and named, so the
// console drops it), an invitation that joins the EXISTING account only when the account proves it
// is theirs, and a tenant administrator who can take a person out of their tenant and nothing more.

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

// The app's own client against the test database, so the session lookup reads real rows (the
// shared stub answers `user` and `tenant` only). Restored as a fresh literal, the way
// tests/lib/module-mock-undo.test.ts requires.
const originalPrisma = (await import("@/api/lib/prisma")).default;
mock.module("@/api/lib/prisma", () => ({ default: app }));
afterAll(() => {
  mock.module("@/api/lib/prisma", () => ({ default: originalPrisma }));
});

const server = (await import("@/app")).default;

const tag = `m756-${process.pid}`;
const PASSWORD = "the-person-password-756";
let passwordHash = "";
let first = 0n; // the older membership: AGENT
let second = 0n; // the newer one: TENANT_ADMIN
let outside = 0n; // a tenant the person does not belong to
let personId = 0n;
const people: bigint[] = [];

async function cookieFor(userId: bigint): Promise<string> {
  const token = await new SignJWT({
    userId: userId.toString(),
    email: `${tag}@x.test`,
    role: "AGENT",
    tenantId: null,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(config.jwtSecret));
  return `fazerai_auth_token=${token}`;
}

function req(
  path: string,
  init: RequestInit & { cookie?: string; tenant?: bigint | string } = {},
): Request {
  const { cookie, tenant, ...rest } = init;
  return new BunRequest(`http://localhost/api${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(tenant !== undefined ? { "x-tenant-id": String(tenant) } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

async function person(
  email: string,
  memberships: Array<[bigint, "AGENT" | "TENANT_ADMIN"]>,
  createdAt?: Date[],
): Promise<bigint> {
  const u = await suDb.user.create({
    data: { email, passwordHash, lastLoginAt: new Date() },
    select: { id: true },
  });
  people.push(u.id);
  for (const [i, [tenantId, role]] of memberships.entries()) {
    await suDb.tenantUser.create({
      data: {
        tenantId,
        userId: u.id,
        role,
        ...(createdAt?.[i] ? { createdAt: createdAt[i] } : {}),
      },
    });
  }
  return u.id;
}

describe.skipIf(!dbUp)("a person with several tenants", () => {
  beforeAll(async () => {
    passwordHash = await Bun.password.hash(PASSWORD, {
      algorithm: "bcrypt",
      cost: 4,
    });
    const mk = async (n: string) =>
      (
        await suDb.tenant.create({
          data: { name: `T756 ${n}`, slug: `${tag}-${n}` },
          select: { id: true },
        })
      ).id;
    first = await mk("first");
    second = await mk("second");
    outside = await mk("outside");
    personId = await person(
      `${tag}@x.test`,
      [
        [first, "AGENT"],
        [second, "TENANT_ADMIN"],
      ],
      [new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z")],
    );
  });

  afterAll(async () => {
    const tenants = [first, second, outside].filter((t) => t !== 0n);
    if (people.length > 0) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM users WHERE id IN (${people.join(",")})`,
      );
    }
    if (tenants.length > 0) {
      const list = tenants.join(",");
      await suDb.$executeRawUnsafe(
        `DELETE FROM users WHERE id IN (SELECT user_id FROM tenant_users WHERE tenant_id IN (${list}))`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id IN (${list})`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM invitations WHERE tenant_id IN (${list})`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN (${list})`);
    }
    await suDb.$disconnect();
    await app?.$disconnect();
  });

  // The symptom the issue was opened on, now with a rule: one login, and it lands on the OLDEST
  // membership until the console names another.
  test("one login, landing on the oldest membership", async () => {
    const res = await server.handle(
      req("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: `${tag}@X.test`, password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(personId.toString());
    expect(body.user.tenantId).toBe(first.toString());
    expect(body.user.role).toBe("AGENT");
  });

  // A person with no membership has nowhere to enter, and the login answers as it does for a wrong
  // password, after checking it, so the answer confirms nothing to a guesser.
  test("a person who belongs to no tenant cannot log in", async () => {
    await person(`${tag}-nowhere@x.test`, []);
    const res = await server.handle(
      req("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: `${tag}-nowhere@x.test`,
          password: PASSWORD,
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  // The fleet view lists a row per membership AND the fleet administrators, who belong to no tenant.
  test("the fleet list shows fleet administrators, with no tenant", async () => {
    const root = await person(`${tag}-root@x.test`, []);
    await suDb.user.update({
      where: { id: root },
      data: { isSuperAdmin: true },
    });
    const res = await server.handle(
      req(`/admin/users?search=${encodeURIComponent(`${tag}-root`)}`, {
        cookie: await cookieFor(root),
      }),
    );
    expect(res.status).toBe(200);
    const { users } = await res.json();
    expect(
      users.map((u: { id: string; tenantId: string | null; role: string }) => [
        u.id,
        u.tenantId,
        u.role,
      ]),
    ).toEqual([[root.toString(), null, "SUPER_ADMIN"]]);
  });

  test("the session lists every tenant, and runs under the one the selector names", async () => {
    const cookie = await cookieFor(personId);
    const res = await server.handle(
      req("/auth/me", { cookie, tenant: second }),
    );
    expect(res.status).toBe(200);
    const { user } = await res.json();
    expect(user.tenantId).toBe(second.toString());
    expect(user.role).toBe("TENANT_ADMIN");
    expect(user.tenantName).toBe("T756 second");
    expect(user.tenants).toEqual([
      { id: first.toString(), name: "T756 first", role: "AGENT" },
      { id: second.toString(), name: "T756 second", role: "TENANT_ADMIN" },
    ]);
  });

  // Never exchanged for another membership: landing somewhere the person did not choose is the
  // defect. The refusal names the id so the console drops the stored selection.
  test("a tenant the person does not belong to is refused, and named", async () => {
    const cookie = await cookieFor(personId);
    const res = await server.handle(
      req("/auth/me", { cookie, tenant: outside }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Tenant-Id-Invalid")).toBe(outside.toString());
  });

  // The role is the one held in the SELECTED tenant: an administrator in one, an agent in the other.
  test("the role gate reads the role held in the selected tenant", async () => {
    const cookie = await cookieFor(personId);
    const asAgent = await server.handle(
      req("/admin/users", { cookie, tenant: first }),
    );
    expect(asAgent.status).toBe(403);
    const asAdmin = await server.handle(
      req("/admin/users", { cookie, tenant: second }),
    );
    expect(asAdmin.status).toBe(200);
    const { users } = await asAdmin.json();
    expect(
      users.map((u: { id: string; tenantId: string }) => u.tenantId),
    ).toEqual(users.map(() => second.toString()));
    expect(users.map((u: { id: string }) => u.id)).toContain(
      personId.toString(),
    );
  });

  // Decision 4 on the issue: a tenant administrator removes a person FROM THEIR TENANT. The account,
  // and the person's other tenants, are not theirs to delete.
  test("a tenant administrator removes a member from their tenant, and only from it", async () => {
    const both = await person(`${tag}-both@x.test`, [
      [first, "AGENT"],
      [second, "AGENT"],
    ]);
    const onlyHere = await person(`${tag}-only@x.test`, [[second, "AGENT"]]);
    const cookie = await cookieFor(personId);
    for (const target of [both, onlyHere]) {
      const res = await server.handle(
        req(`/admin/users/${target}`, {
          method: "DELETE",
          cookie,
          tenant: second,
          body: JSON.stringify({ password: PASSWORD }),
        }),
      );
      expect(res.status).toBe(200);
    }
    const left = await suDb.tenantUser.findMany({
      where: { userId: both },
      select: { tenantId: true },
    });
    expect(left).toEqual([{ tenantId: first }]);
    // The last membership takes the account with it: nowhere left to enter.
    expect(await suDb.user.count({ where: { id: onlyHere } })).toBe(0);
    expect(await suDb.user.count({ where: { id: both } })).toBe(1);
  });

  describe("an invitation to an email that already has an account", () => {
    async function invite(): Promise<string> {
      const { createInvite } = await import(
        "@/api/features/invitations/invitation.service"
      );
      const { token } = await createInvite(
        { tenantId: null, userId: personId, role: "SUPER_ADMIN" },
        { tenantId: outside, email: `${tag}@x.test`, role: "AGENT" },
        suDb,
      );
      return token;
    }

    test("says so to the page, so it asks for the account's password", async () => {
      const token = await invite();
      const res = await server.handle(
        req(`/auth/invite?token=${encodeURIComponent(token)}`),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).invite.existingAccount).toBe(true);
    });

    // Whoever holds the link must not take the account over with it: no proof, no membership, and
    // nothing about the account changes.
    test("refuses a wrong password, and joins nothing", async () => {
      const token = await invite();
      const res = await server.handle(
        req("/auth/accept-invite", {
          method: "POST",
          body: JSON.stringify({ token, password: "not-the-password" }),
        }),
      );
      expect(res.status).toBe(401);
      expect(
        await suDb.tenantUser.count({
          where: { userId: personId, tenantId: outside },
        }),
      ).toBe(0);
    });

    test("with the account's password, adds the membership and changes nothing else", async () => {
      const token = await invite();
      const before = await suDb.user.findUniqueOrThrow({
        where: { id: personId },
        select: { passwordHash: true, name: true },
      });
      const res = await server.handle(
        req("/auth/accept-invite", {
          method: "POST",
          body: JSON.stringify({ token, password: PASSWORD, name: "Other" }),
        }),
      );
      expect(res.status).toBe(200);
      const { user } = await res.json();
      // The session answered runs under the tenant just joined.
      expect(user.tenantId).toBe(outside.toString());
      expect(user.role).toBe("AGENT");
      expect(await suDb.user.count({ where: { email: `${tag}@x.test` } })).toBe(
        1,
      );
      expect(
        await suDb.user.findUniqueOrThrow({
          where: { id: personId },
          select: { passwordHash: true, name: true },
        }),
      ).toEqual(before);
      expect(
        await suDb.tenantUser.count({
          where: { userId: personId, tenantId: outside },
        }),
      ).toBe(1);
      await suDb.tenantUser.deleteMany({
        where: { userId: personId, tenantId: outside },
      });
    });

    // Being signed in proves who THIS browser is, and only that: somebody else's session is not
    // the invitee's account.
    test("signed in as somebody else, still needs the account's password", async () => {
      const token = await invite();
      const stranger = await person(`${tag}-stranger@x.test`, [
        [first, "AGENT"],
      ]);
      const res = await server.handle(
        req("/auth/accept-invite", {
          method: "POST",
          cookie: await cookieFor(stranger),
          body: JSON.stringify({ token }),
        }),
      );
      expect(res.status).toBe(401);
      expect(
        await suDb.tenantUser.count({
          where: { userId: personId, tenantId: outside },
        }),
      ).toBe(0);
    });

    test("signed in as that account, needs no password at all", async () => {
      const token = await invite();
      const res = await server.handle(
        req("/auth/accept-invite", {
          method: "POST",
          cookie: await cookieFor(personId),
          body: JSON.stringify({ token }),
        }),
      );
      expect(res.status).toBe(200);
      expect(
        await suDb.tenantUser.count({
          where: { userId: personId, tenantId: outside },
        }),
      ).toBe(1);
      await suDb.tenantUser.deleteMany({
        where: { userId: personId, tenantId: outside },
      });
    });
  });

  // The password is optional on the wire only because an existing account proves itself another way.
  // A NEW account still needs one, of the usual length.
  test("an invitation for a new account without a password is refused", async () => {
    const { createInvite } = await import(
      "@/api/features/invitations/invitation.service"
    );
    const { token } = await createInvite(
      { tenantId: null, userId: personId, role: "SUPER_ADMIN" },
      { tenantId: outside, email: `${tag}-fresh@x.test`, role: "AGENT" },
      suDb,
    );
    const res = await server.handle(
      req("/auth/accept-invite", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    );
    expect(res.status).toBe(422);
    expect(
      await suDb.user.count({ where: { email: `${tag}-fresh@x.test` } }),
    ).toBe(0);
  });

  // /authorize is a navigation with no selector, so it parks the request under the person's default
  // membership; the console tab that answers the consent may have another tenant selected. The
  // decision acts where the request was parked, as long as the person still belongs there.
  test("an MCP consent answered from another tenant's tab acts where it was parked", async () => {
    const { createPendingAuthorization, issueConsentCsrf } = await import(
      "@/modules/mcp/oauth/consent"
    );
    const client = `${tag}-client`;
    await suDb.mcpOAuthClient.create({
      data: {
        clientId: client,
        name: "756 client",
        redirectUris: ["https://client.example/cb"],
        grantTypes: ["authorization_code"],
        scopes: ["mcp:read"],
      },
    });
    try {
      const { requestId } = await createPendingAuthorization({
        clientId: client,
        userId: personId,
        tenantId: first,
        redirectUri: "https://client.example/cb",
        scopes: ["mcp:read"],
        codeChallenge: randomBytes(16).toString("base64url"),
        codeChallengeMethod: "S256",
        state: "s",
        base: suDb,
      });
      const csrf = await issueConsentCsrf(requestId, personId, suDb);
      const res = await server.handle(
        req(`/v1/mcp/oauth/consent/${requestId}`, {
          method: "POST",
          cookie: await cookieFor(personId),
          tenant: second,
          body: JSON.stringify({ decision: "deny", csrfToken: csrf }),
        }),
      );
      expect(res.status).toBe(200);
      const rows = await suDb.auditLog.findMany({
        where: { actorId: personId, action: "mcp_oauth_consent.deny" },
        select: { tenantId: true },
      });
      expect(rows).toEqual([{ tenantId: first }]);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_pending_authorizations WHERE client_id = '${client}'`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_clients WHERE client_id = '${client}'`,
      );
    }
  });
});
