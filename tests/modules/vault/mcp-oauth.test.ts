import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import {
  buildMcpAuthorizeUrl,
  buildMcpState,
  decryptMcpState,
  discoverOAuthServer,
  encryptOAuthState,
  ensureFreshMcpAccessToken,
  exchangeMcpCode,
  type McpOAuthCredential,
  type OAuthNetOpts,
  projectMcpStatus,
  registerClient,
} from "@/modules/vault/mcp-oauth";
import { createVaultEntry } from "@/modules/vault/service";

const OPTS: OAuthNetOpts = { allowPrivate: true, allowHttp: true };

// Routes outbound fetches by URL to a canned Response and records each call (url + raw body). The
// mcp-oauth module calls fetch directly, so we swap globalThis.fetch.
function withStubbedFetch<T>(
  route: (url: string, body: string) => Response,
  fn: (calls: { url: string; body: string }[]) => Promise<T>,
): Promise<T> {
  const calls: { url: string; body: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = (init?.body as string) ?? "";
    calls.push({ url: String(url), body });
    return route(String(url), body);
  }) as unknown as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

const PRM = {
  resource: "http://hub.test/api/mcp",
  authorization_servers: ["http://hub.test"],
};
const ASM = {
  issuer: "http://hub.test",
  authorization_endpoint: "http://hub.test/authorize",
  token_endpoint: "http://hub.test/token",
  registration_endpoint: "http://hub.test/register",
  scopes_supported: ["mcp:read", "mcp:write"],
  code_challenge_methods_supported: ["S256"],
};

function discoveryRoute(url: string): Response {
  if (url.endsWith("/.well-known/oauth-protected-resource"))
    return Response.json(PRM);
  if (url.endsWith("/.well-known/oauth-authorization-server"))
    return Response.json(ASM);
  return new Response("not found", { status: 404 });
}

describe("mcp-oauth: discovery", () => {
  test("resolves resource + issuer + endpoints from the two well-known docs", async () => {
    const disco = await withStubbedFetch(discoveryRoute, () =>
      discoverOAuthServer("http://hub.test/api/mcp", OPTS),
    );
    expect(disco.resource).toBe("http://hub.test/api/mcp");
    expect(disco.issuer).toBe("http://hub.test");
    expect(disco.authorizationEndpoint).toBe("http://hub.test/authorize");
    expect(disco.tokenEndpoint).toBe("http://hub.test/token");
    expect(disco.registrationEndpoint).toBe("http://hub.test/register");
    expect(disco.scopesSupported).toEqual(["mcp:read", "mcp:write"]);
  });

  test("rejects when the protected-resource metadata is missing (404)", async () => {
    await withStubbedFetch(
      () => new Response("nope", { status: 404 }),
      async () => {
        await expect(
          discoverOAuthServer("http://hub.test/api/mcp", OPTS),
        ).rejects.toThrow();
      },
    );
  });

  test("rejects when the server does not advertise PKCE S256", async () => {
    await withStubbedFetch(
      (url) => {
        if (url.endsWith("/.well-known/oauth-protected-resource"))
          return Response.json(PRM);
        return Response.json({
          ...ASM,
          code_challenge_methods_supported: ["plain"],
        });
      },
      async () => {
        await expect(
          discoverOAuthServer("http://hub.test/api/mcp", OPTS),
        ).rejects.toThrow();
      },
    );
  });
});

describe("mcp-oauth: DCR", () => {
  test("registers a public client and returns the client_id", async () => {
    const reg = await withStubbedFetch(
      () =>
        Response.json(
          { client_id: "abc123", token_endpoint_auth_method: "none" },
          { status: 201 },
        ),
      () =>
        registerClient({
          registrationEndpoint: "http://hub.test/register",
          redirectUri: "http://app.test/api/v1/oauth/mcp/callback",
          scopes: ["mcp:read"],
          opts: OPTS,
        }),
    );
    expect(reg.clientId).toBe("abc123");
    expect(reg.tokenEndpointAuthMethod).toBe("none");
  });

  test("throws when the server has no registration endpoint (DCR disabled)", async () => {
    await expect(
      registerClient({
        registrationEndpoint: undefined,
        redirectUri: "http://app.test/cb",
        opts: OPTS,
      }),
    ).rejects.toThrow();
  });
});

describe("mcp-oauth: authorize URL", () => {
  test("carries PKCE + RFC 8707 resource and omits Google-only params", () => {
    const url = new URL(
      buildMcpAuthorizeUrl({
        authorizationEndpoint: "http://hub.test/authorize",
        clientId: "client-123",
        redirectUri: "http://app.test/api/v1/oauth/mcp/callback",
        scopes: ["mcp:read", "mcp:write"],
        state: "STATE",
        codeChallenge: "CHALLENGE",
        resource: "http://hub.test/api/mcp",
      }),
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("http://hub.test/api/mcp");
    expect(url.searchParams.get("scope")).toBe("mcp:read mcp:write");
    expect(url.searchParams.get("state")).toBe("STATE");
    // Google-only knobs must NOT be present.
    expect(url.searchParams.get("access_type")).toBeNull();
    expect(url.searchParams.get("prompt")).toBeNull();
  });
});

describe("mcp-oauth: state", () => {
  function sample() {
    return buildMcpState({
      entryId: "42",
      tenantId: "7",
      userId: "3",
      codeVerifier: "verifier-abc",
      tokenEndpoint: "http://hub.test/token",
      issuer: "http://hub.test",
      resource: "http://hub.test/api/mcp",
      clientId: "client-1",
      redirectUri: "http://app.test/cb",
      scopes: ["mcp:read"],
    });
  }

  test("binds the discovered server context and round-trips", () => {
    const back = decryptMcpState(encryptOAuthState(sample()));
    expect(back.entryId).toBe("42");
    expect(back.tokenEndpoint).toBe("http://hub.test/token");
    expect(back.issuer).toBe("http://hub.test");
    expect(back.resource).toBe("http://hub.test/api/mcp");
    expect(back.clientId).toBe("client-1");
    expect(back.exp).toBeGreaterThan(Date.now());
  });
});

describe("mcp-oauth: code exchange", () => {
  test("public client sends client_id + verifier + resource, no client_secret", async () => {
    const tokens = await withStubbedFetch(
      () =>
        Response.json({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          scope: "mcp:read mcp:write",
        }),
      async (calls) => {
        const r = await exchangeMcpCode({
          tokenEndpoint: "http://hub.test/token",
          code: "code-1",
          clientId: "client-1",
          redirectUri: "http://app.test/cb",
          codeVerifier: "verifier",
          resource: "http://hub.test/api/mcp",
          opts: OPTS,
        });
        const body = new URLSearchParams(calls[0]?.body ?? "");
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code_verifier")).toBe("verifier");
        expect(body.get("resource")).toBe("http://hub.test/api/mcp");
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("client_secret")).toBeNull();
        return r;
      },
    );
    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.scopes).toEqual(["mcp:read", "mcp:write"]);
  });

  test("confidential client adds client_secret (client_secret_post)", async () => {
    await withStubbedFetch(
      () => Response.json({ access_token: "at", expires_in: 3600 }),
      async (calls) => {
        await exchangeMcpCode({
          tokenEndpoint: "http://hub.test/token",
          code: "c",
          clientId: "client-1",
          clientSecret: "shh",
          redirectUri: "http://app.test/cb",
          codeVerifier: "v",
          resource: "http://hub.test/api/mcp",
          opts: OPTS,
        });
        const body = new URLSearchParams(calls[0]?.body ?? "");
        expect(body.get("client_secret")).toBe("shh");
      },
    );
  });
});

describe("mcp-oauth: projectMcpStatus", () => {
  test("connected projection never exposes tokens or the client secret", () => {
    const status = projectMcpStatus({
      resource: "http://hub.test/api/mcp",
      issuer: "http://hub.test",
      tokenEndpoint: "http://hub.test/token",
      clientId: "c",
      clientSecret: "s",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1_700_000_000_000,
      scopes: ["mcp:read"],
    });
    expect(status.connected).toBe(true);
    expect(status.registered).toBe(true);
    expect(status.issuer).toBe("http://hub.test");
    expect(JSON.stringify(status)).not.toContain('"at"');
    expect(JSON.stringify(status)).not.toContain('"rt"');
    expect(JSON.stringify(status)).not.toContain('"s"');
  });

  test("a credential without tokens is reported disconnected", () => {
    expect(projectMcpStatus({ clientId: "c" }).connected).toBe(false);
  });
});

// ── DB-gated tests (real Postgres under a tenant-scoped tx) ──

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
let tenantId = 0n;
let savedAllowPrivate = false;

describe.skipIf(!dbUp)("mcp-oauth: DB-backed", () => {
  const ctx = (): TenantContext => ({
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "McpOAuth", slug: `mcpoauth-${process.pid}` },
    });
    tenantId = t.id;
    // The refresh path uses defaultNetOpts() (config-driven); allow the http://hub.test stub target.
    savedAllowPrivate = config.ssrf.allowPrivateTargets;
    config.ssrf.allowPrivateTargets = true;
  });

  afterAll(async () => {
    config.ssrf.allowPrivateTargets = savedAllowPrivate;
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("createVaultEntry: mcp_oauth requires baseUrl, accepts an empty value object", async () => {
    // Missing baseUrl → rejected (requiresBaseUrl).
    await expect(
      createVaultEntry(
        ctx(),
        { name: "m-nobase", value: {}, kind: "mcp_oauth" },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow();

    // Empty value object + baseUrl → accepted (managed blob).
    const { id } = await createVaultEntry(
      ctx(),
      {
        name: "m-ok",
        value: {},
        kind: "mcp_oauth",
        baseUrl: "http://hub.test/api/mcp",
      },
      undefined,
      undefined,
      appDb,
    );
    expect(id).toBeGreaterThan(0n);
  });

  async function seedConnected(cred: McpOAuthCredential): Promise<bigint> {
    const row = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: `m-seed-${Math.random().toString(36).slice(2)}`,
        kind: "mcp_oauth",
        baseUrl: "http://hub.test/api/mcp",
        secret: encryptJson(cred),
      },
      select: { id: true },
    });
    return row.id;
  }

  const base = (): McpOAuthCredential => ({
    resource: "http://hub.test/api/mcp",
    issuer: "http://hub.test",
    tokenEndpoint: "http://hub.test/token",
    clientId: "c",
    scopes: ["mcp:read"],
  });

  test("ensureFreshMcpAccessToken: returns the existing token when still fresh", async () => {
    const id = await seedConnected({
      ...base(),
      accessToken: "still-fresh",
      refreshToken: "rt",
      expiresAt: Date.now() + 10 * 60_000,
    });
    const token = await ensureFreshMcpAccessToken(ctx(), id, appDb);
    expect(token).toBe("still-fresh");
  });

  test("ensureFreshMcpAccessToken: refreshes when expired and persists the ROTATED refresh token", async () => {
    const id = await seedConnected({
      ...base(),
      accessToken: "old",
      refreshToken: "rt-old",
      expiresAt: Date.now() - 1000,
    });
    const token = await withStubbedFetch(
      () =>
        Response.json({
          access_token: "new-token",
          refresh_token: "rt-new",
          expires_in: 3600,
        }),
      async (calls) => {
        const t = await ensureFreshMcpAccessToken(ctx(), id, appDb);
        const body = new URLSearchParams(calls[0]?.body ?? "");
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("rt-old");
        expect(body.get("resource")).toBe("http://hub.test/api/mcp");
        return t;
      },
    );
    expect(token).toBe("new-token");

    const persisted = decryptJson<McpOAuthCredential>(
      (
        await suDb.vaultEntry.findUniqueOrThrow({
          where: { id },
          select: { secret: true },
        })
      ).secret,
    );
    expect(persisted.accessToken).toBe("new-token");
    // Rotation: the NEW refresh token replaces the old one.
    expect(persisted.refreshToken).toBe("rt-new");
  });

  test("ensureFreshMcpAccessToken: throws when never connected", async () => {
    const id = await seedConnected(base());
    await expect(ensureFreshMcpAccessToken(ctx(), id, appDb)).rejects.toThrow();
  });

  test("single-flight: two concurrent refreshes spend the rotating token exactly once", async () => {
    const id = await seedConnected({
      ...base(),
      accessToken: "old",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 1000,
    });
    const [a, b] = await withStubbedFetch(
      () =>
        Response.json({
          access_token: "shared-new",
          refresh_token: "rt-2",
          expires_in: 3600,
        }),
      async (calls) => {
        const pair = await Promise.all([
          ensureFreshMcpAccessToken(ctx(), id, appDb),
          ensureFreshMcpAccessToken(ctx(), id, appDb),
        ]);
        // Exactly ONE token-endpoint call despite two concurrent callers.
        expect(calls.length).toBe(1);
        return pair;
      },
    );
    expect(a).toBe("shared-new");
    expect(b).toBe("shared-new");
  });
});
