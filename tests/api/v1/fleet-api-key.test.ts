import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";
import { countInSrc } from "@/tests/utils/source-text";

// A fleet-scoped API key, driven through the console's own door.
// `tests/modules/api-keys.test.ts` proves the service. This file proves the request boundary admits
// a tenantless Bearer as the fleet principal a SUPER_ADMIN session is (the roster on `/v1/tenants`, a
// tenant per request by `X-Tenant-Id`, SUPER_ADMIN-only routes open), and that the key answers the
// password step-up itself. Edition-neutral routes only, since `POST/DELETE /v1/tenants` are stripped
// from the published Free tree: step-up is proved on `DELETE /v1/agents/:id`, which asks the same
// helper. Services are WRAPPED and call through: `mock.module` is worker-global, so a stub that
// swallowed the behaviour would turn another file green.

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

const verify = await import("@/modules/api-keys/verify");
const realVerify = { ...verify };
mock.module("@/modules/api-keys/verify", () => ({
  ...realVerify,
  verifyApiKey: (token: string) => realVerify.verifyApiKey(token, app),
}));

const keys = await import("@/modules/api-keys/service");
const realKeys = { ...keys };
mock.module("@/modules/api-keys/service", () => ({
  ...realKeys,
  listApiKeys: (ctx: TenantContext) => realKeys.listApiKeys(ctx, app),
  createApiKey: (
    ctx: TenantContext,
    input: Parameters<typeof keys.createApiKey>[1],
  ) => realKeys.createApiKey(ctx, input, app),
  createFleetApiKey: (
    ctx: TenantContext,
    input: Parameters<typeof keys.createFleetApiKey>[1],
  ) => realKeys.createFleetApiKey(ctx, input, app),
  listFleetApiKeys: (ctx: TenantContext) => realKeys.listFleetApiKeys(ctx, app),
  revokeFleetApiKey: (ctx: TenantContext, id: bigint) =>
    realKeys.revokeFleetApiKey(ctx, id, app),
}));

const tenants = await import("@/api/v1/tenants.service");
const realTenants = { ...tenants };
mock.module("@/api/v1/tenants.service", () => ({
  ...realTenants,
  listTenants: (ctx: TenantContext) => realTenants.listTenants(ctx, app),
}));

const agents = await import("@/modules/agents/service");
const realAgents = { ...agents };
mock.module("@/modules/agents/service", () => ({
  ...realAgents,
  getAgent: (ctx: TenantContext, id: bigint) =>
    realAgents.getAgent(ctx, id, app),
  deleteAgent: (ctx: TenantContext, id: bigint) =>
    realAgents.deleteAgent(ctx, id, app),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does
// NOT run, and the wrappers are already installed for the whole worker by now.
afterAll(() => {
  mock.module("@/modules/api-keys/verify", () => realVerify);
  mock.module("@/modules/api-keys/service", () => realKeys);
  mock.module("@/api/v1/tenants.service", () => realTenants);
  mock.module("@/modules/agents/service", () => realAgents);
});

// `requireSession` answers 403, and the `response:` map is the contract the spec
// and the Eden client are generated from (`openapi:check` holds the committed spec to it). A status
// a route returns and does not declare is a refusal no generated client knows how to handle. The
// list is held to the source: a new `requireSession(` site has to be named here.
describe("the routes that refuse an API-key principal declare the 403", () => {
  test("every requireSession route carries 403 in its response map", async () => {
    type Route = {
      method: string;
      path: string;
      hooks?: { response?: Record<string, unknown> };
    };
    const routes = (server as unknown as { routes: Route[] }).routes;
    // The tenant mint is registered with the group's trailing slash; the others are not.
    const wanted = [
      "POST /api/v1/api-keys/",
      "POST /api/v1/api-keys/fleet",
      "GET /api/v1/mcp/oauth/authorize",
      "GET /api/v1/mcp/oauth/consent/:req",
      "POST /api/v1/mcp/oauth/consent/:req",
      "PATCH /api/auth/me",
      "PATCH /api/auth/password",
      "POST /api/admin/super-admins",
    ];
    const sites = Object.entries(await countInSrc(/\brequireSession\(/g))
      .filter(([file]) => file !== "src/api/lib/step-up.ts")
      .reduce((n, [, c]) => n + c, 0);
    expect(sites).toBe(wanted.length);
    const missing = wanted.filter((key) => {
      const [method, path] = key.split(" ");
      const route = routes.find((r) => r.method === method && r.path === path);
      return !route || !("403" in (route.hooks?.response ?? {}));
    });
    expect(missing).toEqual([]);
  });
});

const SUPER_ID = 9494n;
const PASSWORD = "fleet-pw";
let tenantA = 0n;
let tenantB = 0n;
let tenantToken = "";
let fleetToken = "";
let agentByKey = "";
let agentBySession = "";
let legacyToken = "";
let agentByLegacy = "";
let cookie = "";

const send = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> =>
  server
    .handle(
      new BunRequest(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "accept-language": "en",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
    .then((res) => {
      // The limiter's budget is one 600/min bucket shared by every file in the worker; a 429 is a
      // statement about the SUITE, not this route.
      if (res.status === 429) {
        throw new Error(
          `rate-limit budget exhausted before ${method} ${path}: the worker's shared bucket ran out`,
        );
      }
      return res;
    });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe.skipIf(!dbUp)("a fleet-scoped API key at the request boundary", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    const a = await su.tenant.create({
      data: { name: "FLEETKEY-A", slug: `fleetkey-a-${process.pid}` },
    });
    const b = await su.tenant.create({
      data: { name: "FLEETKEY-B", slug: `fleetkey-b-${process.pid}` },
    });
    tenantA = a.id;
    tenantB = b.id;
    const ctxA: TenantContext = {
      tenantId: tenantA,
      userId: SUPER_ID,
      role: "TENANT_ADMIN",
    };
    tenantToken = (
      await realKeys.createApiKey(ctxA, { displayName: "tenant A key" }, app)
    ).token;
    fleetToken = (
      await realKeys.createFleetApiKey(
        { tenantId: null, userId: SUPER_ID, role: "SUPER_ADMIN" },
        { displayName: "fleet key" },
        app,
      )
    ).token;
    agentByKey = (
      await realAgents.createAgent(
        ctxA,
        { name: `by-key-${process.pid}`, systemPrompt: "x" },
        app,
      )
    ).id;
    agentBySession = (
      await realAgents.createAgent(
        ctxA,
        { name: `by-session-${process.pid}`, systemPrompt: "x" },
        app,
      )
    ).id;
    // NOTE: a legacy key row, with no `step_up_at` on record. Its creator is the session's user,
    // whose password is below.
    legacyToken = `fazerai_${"L".repeat(43)}${process.pid}`;
    await su.apiKey.create({
      data: {
        tenantId: tenantA,
        displayName: "tenant A legacy key",
        keyHash: realVerify.hashApiKey(legacyToken),
        keyPrefix: legacyToken.slice(0, 14),
        role: "TENANT_ADMIN",
        createdByUserId: SUPER_ID,
      },
    });
    agentByLegacy = (
      await realAgents.createAgent(
        ctxA,
        { name: `by-legacy-${process.pid}`, systemPrompt: "x" },
        app,
      )
    ).id;
    // The cookie session: a SUPER_ADMIN with a password, re-resolved from the (mocked) users table
    // on every request, and read again with its hash by the step-up.
    const passwordHash = await Bun.password.hash(PASSWORD);
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: SUPER_ID,
        tenantId: null,
        email: "fleet@example.com",
        passwordHash,
        googleId: null,
        name: null,
        role: "SUPER_ADMIN" as const,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const jwt = await new SignJWT({
      userId: SUPER_ID.toString(),
      email: "fleet@example.com",
      role: "SUPER_ADMIN",
      tenantId: null,
      pwd: (await import("@/api/lib/auth")).passwordFingerprint(passwordHash),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret));
    cookie = `fazerai_auth_token=${jwt}`;
  });

  afterAll(async () => {
    if (dbUp && su) {
      for (const id of [tenantA, tenantB]) {
        if (!id) continue;
        for (const table of ["api_keys", "audit_logs", "agents"]) {
          await su.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${id}`,
          );
        }
        await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
      }
      await su.$executeRawUnsafe(
        `DELETE FROM api_keys WHERE tenant_id IS NULL AND created_by_user_id = ${SUPER_ID}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id IS NULL AND actor_id = ${SUPER_ID}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // NOTE: the control: a tenant key's reach, which a fleet key exceeds.
  test("a tenant key sees one tenant on /v1/tenants", async () => {
    const res = await send("GET", "/api/v1/tenants", bearer(tenantToken));
    expect(res.status).toBe(200);
    const { tenants: rows } = (await res.json()) as {
      tenants: { id: string }[];
    };
    expect(rows.map((t) => t.id)).toEqual([tenantA.toString()]);
  });

  test("a fleet key sees the whole roster on /v1/tenants, with no session anywhere", async () => {
    const res = await send("GET", "/api/v1/tenants", bearer(fleetToken));
    expect(res.status).toBe(200);
    const { tenants: rows } = (await res.json()) as {
      tenants: { id: string }[];
    };
    const ids = rows.map((t) => t.id);
    expect(ids).toContain(tenantA.toString());
    expect(ids).toContain(tenantB.toString());
  });

  // A fleet key has no home tenant: a per-tenant route needs a target, chosen the way a SUPER_ADMIN
  // session chooses one. Without it the answer is the refusal a session gets, never an empty list
  // that reads as "no keys".
  test("a per-tenant route takes the tenant from X-Tenant-Id, and refuses without one", async () => {
    const none = await send("GET", "/api/v1/api-keys", bearer(fleetToken));
    expect(none.status).toBe(400);
    const selected = await send("GET", "/api/v1/api-keys", {
      ...bearer(fleetToken),
      "x-tenant-id": tenantA.toString(),
    });
    expect(selected.status).toBe(200);
    const { apiKeys } = (await selected.json()) as {
      apiKeys: { displayName: string; role: string }[];
    };
    expect(apiKeys.map((k) => k.displayName)).toContain("tenant A key");
    // The fleet key itself is not tenant A's, and is not in tenant A's list.
    expect(apiKeys.some((k) => k.role === "SUPER_ADMIN")).toBe(false);
  });

  // Minting a fleet key is minting SUPER_ADMIN authority: a person, with their password. A key
  // cannot mint one (a leaked key would otherwise outlive its own revocation), and a session cannot
  // mint one with the wrong password.
  test("a fleet key is minted by a session under step-up, listed and revoked on the fleet routes", async () => {
    const byKey = await send(
      "POST",
      "/api/v1/api-keys/fleet",
      bearer(fleetToken),
      { displayName: "minted by a key", password: "anything" },
    );
    expect(byKey.status).toBe(403);
    expect(((await byKey.json()) as { error: string }).error).toBe(
      "This is done from a signed-in session, not with an API key",
    );
    const wrongPw = await send(
      "POST",
      "/api/v1/api-keys/fleet",
      { cookie },
      { displayName: "wrong pw", password: "nope" },
    );
    expect(wrongPw.status).toBe(403);
    const minted = await send(
      "POST",
      "/api/v1/api-keys/fleet",
      { cookie },
      { displayName: "minted by a person", password: PASSWORD },
    );
    expect(minted.status).toBe(200);
    const { apiKey, token } = (await minted.json()) as {
      apiKey: { id: string; role: string };
      token: string;
    };
    expect(apiKey.role).toBe("SUPER_ADMIN");
    const principal = await realVerify.verifyApiKey(token, app);
    expect(principal?.tenantId).toBeNull();
    expect(principal?.role).toBe("SUPER_ADMIN");

    const listed = await send("GET", "/api/v1/api-keys/fleet", bearer(token));
    expect(listed.status).toBe(200);
    const { apiKeys } = (await listed.json()) as {
      apiKeys: { id: string; role: string }[];
    };
    expect(apiKeys.map((k) => k.id)).toContain(apiKey.id);
    expect(apiKeys.every((k) => k.role === "SUPER_ADMIN")).toBe(true);

    const revoked = await send(
      "DELETE",
      `/api/v1/api-keys/fleet/${apiKey.id}`,
      bearer(fleetToken),
    );
    expect(revoked.status).toBe(200);
    expect(await realVerify.verifyApiKey(token, app)).toBeNull();
  });

  // NOTE: a key answers every later step-up by itself, so a stolen session must not be able to mint
  // one without the password, or the key would carry the session past the rule. And a key never
  // mints a credential at all: a tenant key minted by a fleet key under
  // X-Tenant-Id, or by another tenant key, would keep working after the minter is revoked.
  test("a tenant key is minted by a session under step-up, and by no key", async () => {
    const sessionHeaders = { cookie, "x-tenant-id": tenantA.toString() };
    // The field is REQUIRED on the two minting routes (no principal may omit it, since a key is
    // refused), so an omitted password is the schema's 422 naming the field, not the helper's 400.
    const noPw = await send("POST", "/api/v1/api-keys", sessionHeaders, {
      displayName: "session no pw",
    });
    expect(noPw.status).toBe(422);
    expect(((await noPw.json()) as { field?: string }).field).toBe("password");
    const wrongPw = await send("POST", "/api/v1/api-keys", sessionHeaders, {
      displayName: "session wrong pw",
      password: "nope",
    });
    expect(wrongPw.status).toBe(403);
    const withPw = await send("POST", "/api/v1/api-keys", sessionHeaders, {
      displayName: "session with pw",
      password: PASSWORD,
    });
    expect(withPw.status).toBe(200);
    const byTenantKey = await send(
      "POST",
      "/api/v1/api-keys",
      bearer(tenantToken),
      { displayName: "minted by a tenant key", password: "anything" },
    );
    expect(byTenantKey.status).toBe(403);
    const byFleetKey = await send(
      "POST",
      "/api/v1/api-keys",
      { ...bearer(fleetToken), "x-tenant-id": tenantA.toString() },
      { displayName: "minted by a fleet key", password: "anything" },
    );
    expect(byFleetKey.status).toBe(403);
    expect(((await byFleetKey.json()) as { error: string }).error).toBe(
      "This is done from a signed-in session, not with an API key",
    );
    expect(
      await su?.apiKey.count({
        where: { tenantId: tenantA, displayName: { startsWith: "minted by" } },
      }),
    ).toBe(0);
    expect(
      await su?.apiKey.count({
        where: { tenantId: tenantA, displayName: { startsWith: "session " } },
      }),
    ).toBe(1);
  });

  // NOTE: the other credential a key could mint: an MCP grant. `/authorize` treats any authenticated
  // principal as the app session, and a first-party client skips consent, so a Bearer would get a
  // code, and a grant that outlives the key. The refusal sits before the client lookup, so no
  // client has to exist for the probe to reach it, and a key cannot probe client ids either.
  test("a key cannot drive the OAuth authorize or consent routes", async () => {
    const authorize = await send(
      "GET",
      "/api/v1/mcp/oauth/authorize?client_id=x&redirect_uri=https%3A%2F%2Fx%2Fcb&response_type=code&code_challenge=abc&code_challenge_method=S256",
      bearer(fleetToken),
    );
    expect(authorize.status).toBe(403);
    const consent = await send(
      "GET",
      "/api/v1/mcp/oauth/consent/some-req",
      bearer(tenantToken),
    );
    expect(consent.status).toBe(403);
    const decide = await send(
      "POST",
      "/api/v1/mcp/oauth/consent/some-req",
      bearer(tenantToken),
      { decision: "approve", csrfToken: "x" },
    );
    expect(decide.status).toBe(403);
  });

  // The creator id a key carries is for audit: a key that could set its creator's password would
  // mint the one credential its revocation does not end, and one that renames the creator acts as a
  // person on their own account.
  test("a key cannot change its creator's password or profile", async () => {
    for (const token of [tenantToken, fleetToken]) {
      const password = await send(
        "PATCH",
        "/api/auth/password",
        bearer(token),
        {
          currentPassword: PASSWORD,
          newPassword: "another-password",
        },
      );
      expect(password.status).toBe(403);
      const profile = await send("PATCH", "/api/auth/me", bearer(token), {
        name: "Renamed by a key",
      });
      expect(profile.status).toBe(403);
    }
    const row = await su?.user.findUnique({ where: { id: SUPER_ID } });
    expect(row?.name).not.toBe("Renamed by a key");
  });

  test("the tenant key cannot reach the fleet routes", async () => {
    const res = await send(
      "GET",
      "/api/v1/api-keys/fleet",
      bearer(tenantToken),
    );
    expect(res.status).toBe(403);
  });

  // The step-up rule, on the route. The same shape gates the tenant delete (Pro tree, exercised
  // live), the Chatwoot teardowns and the user delete.
  test("a Bearer key answers the password step-up by itself; a session still has to", async () => {
    const name = `by-key-${process.pid}`;
    const byKey = await send(
      "DELETE",
      `/api/v1/agents/${agentByKey}`,
      bearer(tenantToken),
      { confirmName: name },
    );
    expect(byKey.status).toBe(200);
    expect(await su?.agent.count({ where: { id: BigInt(agentByKey) } })).toBe(
      0,
    );

    const sessionName = `by-session-${process.pid}`;
    const sessionHeaders = { cookie, "x-tenant-id": tenantA.toString() };
    const noPw = await send(
      "DELETE",
      `/api/v1/agents/${agentBySession}`,
      sessionHeaders,
      { confirmName: sessionName },
    );
    expect(noPw.status).toBe(400);
    expect(((await noPw.json()) as { error: string }).error).toBe(
      "Your password is required to confirm this action",
    );
    expect(
      await su?.agent.count({ where: { id: BigInt(agentBySession) } }),
    ).toBe(1);
    const withPw = await send(
      "DELETE",
      `/api/v1/agents/${agentBySession}`,
      sessionHeaders,
      { confirmName: sessionName, password: PASSWORD },
    );
    expect(withPw.status).toBe(200);
    expect(
      await su?.agent.count({ where: { id: BigInt(agentBySession) } }),
    ).toBe(0);
  });

  // NOTE: a legacy key (no `step_up_at`) has no step-up to carry, so it answers with its creator's
  // password. The rule widens nothing for a key that already exists.
  test("a key minted before the rule still answers with its creator's password", async () => {
    const name = `by-legacy-${process.pid}`;
    const path = `/api/v1/agents/${agentByLegacy}`;
    const left = () =>
      su?.agent.count({ where: { id: BigInt(agentByLegacy) } });
    const noPw = await send("DELETE", path, bearer(legacyToken), {
      confirmName: name,
    });
    expect(noPw.status).toBe(400);
    expect(((await noPw.json()) as { error: string }).error).toBe(
      "Your password is required to confirm this action",
    );
    const wrongPw = await send("DELETE", path, bearer(legacyToken), {
      confirmName: name,
      password: "not-it",
    });
    expect(wrongPw.status).toBe(403);
    expect(await left()).toBe(1);
    const withPw = await send("DELETE", path, bearer(legacyToken), {
      confirmName: name,
      password: PASSWORD,
    });
    expect(withPw.status).toBe(200);
    expect(await left()).toBe(0);
  });
});
