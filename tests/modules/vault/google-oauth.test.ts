import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";
import type { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  buildAuthorizeUrl,
  buildCallbackHtml,
  buildState,
  computeCodeChallenge,
  decryptOAuthState,
  encryptOAuthState,
  ensureFreshGoogleAccessToken,
  exchangeCodeForTokens,
  GOOGLE_OAUTH_CALLBACK_SCRIPT,
  type GoogleOAuthCredential,
  generateCodeVerifier,
  projectStatus,
  validateScopes,
} from "@/modules/vault/google-oauth";
import { createVaultEntry } from "@/modules/vault/service";

// Stubs the global fetch for the Google token endpoint and records the form body of each call. The
// google-oauth module calls fetch directly (no fetchImpl injection), so we swap globalThis.fetch.
function withStubbedFetch<T>(
  responder: (url: string, body: URLSearchParams) => Response,
  fn: (calls: URLSearchParams[]) => Promise<T>,
): Promise<T> {
  const calls: URLSearchParams[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = new URLSearchParams((init?.body as string) ?? "");
    calls.push(body);
    return responder(String(url), body);
  }) as unknown as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

// Minimal valid id_token: header.payload.signature with the email claim in the (base64url) payload.
function idTokenWithEmail(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

describe("google-oauth: PKCE + scopes + state (pure)", () => {
  test("code verifier/challenge: S256 round trips and verifier length is in range", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // URL-safe base64 (no +/=).
    expect(verifier).not.toMatch(/[+/=]/);
    const challenge = computeCodeChallenge(verifier);
    // Deterministic for a fixed verifier.
    expect(computeCodeChallenge(verifier)).toBe(challenge);
    expect(challenge).not.toMatch(/[+/=]/);
  });

  test("validateScopes: accepts known scopes, always adds openid+email, dedupes", () => {
    const scopes = validateScopes([
      "https://www.googleapis.com/auth/calendar",
      "profile",
      "profile",
    ]);
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar");
    expect(scopes).toContain("openid");
    expect(scopes).toContain("email");
    expect(scopes).toContain("profile");
    // deduped
    expect(scopes.filter((s) => s === "profile").length).toBe(1);
  });

  test("validateScopes: rejects an invalid scope", () => {
    expect(() => validateScopes(["https://evil.example.com/auth/x"])).toThrow();
    expect(() => validateScopes(["not-a-scope"])).toThrow();
  });

  test("validateScopes: rejects more than 20 scopes", () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `https://www.googleapis.com/auth/scope${i}`,
    );
    expect(() => validateScopes(many)).toThrow();
  });

  test("state encrypts/decrypts and exposes the bound fields", () => {
    const state = buildState({
      entryId: "42",
      tenantId: "7",
      userId: "3",
      scopes: ["openid", "email"],
      codeVerifier: "verifier-abc",
    });
    const blob = encryptOAuthState(state);
    const back = decryptOAuthState(blob);
    expect(back.entryId).toBe("42");
    expect(back.tenantId).toBe("7");
    expect(back.userId).toBe("3");
    expect(back.codeVerifier).toBe("verifier-abc");
    expect(back.exp).toBeGreaterThan(Date.now());
  });

  test("decryptOAuthState: a tampered blob is rejected", () => {
    const blob = encryptOAuthState(
      buildState({
        entryId: "1",
        tenantId: "1",
        userId: "1",
        scopes: [],
        codeVerifier: "v",
      }),
    );
    const tampered = `${blob.slice(0, -4)}XXXX`;
    expect(() => decryptOAuthState(tampered)).toThrow();
  });

  test("decryptOAuthState: a blob of the wrong shape is rejected", () => {
    const bogus = encryptJson({ hello: "world" });
    expect(() => decryptOAuthState(bogus)).toThrow();
  });
});

describe("google-oauth: authorize URL", () => {
  test("contains every required OAuth param", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client-123",
        redirectUri: "https://app.example.com/api/v1/oauth/google/callback",
        scopes: ["openid", "email"],
        state: "STATE",
        codeChallenge: "CHALLENGE",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("scope")).toBe("openid email");
  });
});

describe("google-oauth: callback HTML (CSP-safe)", () => {
  test("embeds the config JSON and the FIXED script; pinned-hash script is unchanged", () => {
    const html = buildCallbackHtml(
      true,
      "connected",
      "https://app.example.com",
    );
    expect(html).toContain('id="cfg"');
    expect(html).toContain('"origin":"https://app.example.com"');
    expect(html).toContain('"ok":true');
    // The executable script must be exactly the pinned constant (whose sha256 is in csp.ts).
    expect(html).toContain(`<script>${GOOGLE_OAUTH_CALLBACK_SCRIPT}</script>`);
  });

  test("escapes a hostile message so it cannot break out of the JSON block", () => {
    const html = buildCallbackHtml(false, "</script><b>x", "https://app");
    // The literal closing tag inside the JSON is escaped.
    expect(html).not.toContain("</script><b>x");
  });
});

describe("google-oauth: token exchange (stubbed fetch)", () => {
  test("exchangeCodeForTokens returns tokens + email from the id_token", async () => {
    const result = await withStubbedFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "at-1",
            refresh_token: "rt-1",
            expires_in: 3600,
            scope: "openid email",
            id_token: idTokenWithEmail("user@example.com"),
          }),
          { status: 200 },
        ),
      async (calls) => {
        const r = await exchangeCodeForTokens({
          code: "code-1",
          clientId: "c",
          clientSecret: "s",
          redirectUri: "https://app/callback",
          codeVerifier: "verifier",
        });
        expect(calls[0]?.get("grant_type")).toBe("authorization_code");
        expect(calls[0]?.get("code_verifier")).toBe("verifier");
        return r;
      },
    );
    expect(result.accessToken).toBe("at-1");
    expect(result.refreshToken).toBe("rt-1");
    expect(result.email).toBe("user@example.com");
    expect(result.scopes).toEqual(["openid", "email"]);
  });

  test("exchangeCodeForTokens throws when no refresh_token is returned", async () => {
    await withStubbedFetch(
      () =>
        new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
          status: 200,
        }),
      async () => {
        await expect(
          exchangeCodeForTokens({
            code: "c",
            clientId: "c",
            clientSecret: "s",
            redirectUri: "r",
            codeVerifier: "v",
          }),
        ).rejects.toThrow();
      },
    );
  });
});

describe("google-oauth: projectStatus", () => {
  test("connected projection never exposes tokens or the client secret", () => {
    const status = projectStatus({
      clientId: "c",
      clientSecret: "s",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1_700_000_000_000,
      scopes: ["openid", "email"],
      email: "u@e.com",
    });
    expect(status.connected).toBe(true);
    expect(status.email).toBe("u@e.com");
    expect(status.scopes).toEqual(["openid", "email"]);
    // tokens / secret are not present on the projection at all.
    expect(JSON.stringify(status)).not.toContain("at");
    expect(JSON.stringify(status)).not.toContain("rt");
    expect(JSON.stringify(status)).not.toContain('"s"');
  });

  test("a credential without tokens is reported disconnected", () => {
    expect(projectStatus({ clientId: "c", clientSecret: "s" })).toEqual({
      connected: false,
    });
  });
});

describe("google-oauth: HTTP bearer injection", () => {
  test("a resolved google_oauth access token is injected as Authorization: Bearer", async () => {
    let capturedHeaders: Record<string, string> = {};
    const def: HttpToolDef = {
      name: "gcal",
      method: "GET",
      urlTemplate: "https://8.8.8.8/calendar/v3/calendars",
      allowedHosts: ["8.8.8.8"],
      headers: {},
      inputSchema: {},
      credentialRef: "vault:1",
      credentialKind: "google_oauth",
    };
    const tool = buildHttpTool(def, {
      // The runtime resolves the fresh access token string for a google_oauth credential.
      resolveCredential: async () => "FRESH_ACCESS_TOKEN",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await tool.invoke({});
    expect(capturedHeaders.Authorization).toBe("Bearer FRESH_ACCESS_TOKEN");
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

describe.skipIf(!dbUp)("google-oauth: DB-backed", () => {
  const ctx = (): TenantContext => ({
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "GOAuth", slug: `goauth-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("createVaultEntry validates google_oauth fields (clientId + clientSecret)", async () => {
    // Missing clientSecret → rejected, NAMING the field: the credential form renders one input per
    // declared field and keys it by exactly this string, so a refusal that only says it in prose
    // leaves the console with nowhere to put the message (issue #231).
    const refused = await createVaultEntry(
      ctx(),
      {
        name: "g-bad",
        value: { clientId: "c" } as Record<string, string>,
        kind: "google_oauth",
      },
      undefined,
      undefined,
      appDb,
    ).then(
      () => null,
      (e: unknown) => e as AppError,
    );
    expect(refused).not.toBeNull();
    expect(refused?.field).toBe("clientSecret");

    // Both fields present → accepted.
    const { id } = await createVaultEntry(
      ctx(),
      {
        name: "g-ok",
        value: { clientId: "client-1", clientSecret: "secret-1" },
        kind: "google_oauth",
      },
      undefined,
      undefined,
      appDb,
    );
    expect(id).toBeGreaterThan(0n);
  });

  // Seeds a google_oauth entry with tokens directly (bypassing validateVaultValue, which the merge
  // path also bypasses) so the refresh logic has something to read.
  async function seedConnected(cred: GoogleOAuthCredential): Promise<bigint> {
    const row = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: `g-seed-${Math.random().toString(36).slice(2)}`,
        kind: "google_oauth",
        secret: encryptJson(cred),
      },
      select: { id: true },
    });
    return row.id;
  }

  test("ensureFreshGoogleAccessToken: returns the existing token when still fresh", async () => {
    const id = await seedConnected({
      clientId: "c",
      clientSecret: "s",
      accessToken: "still-fresh",
      refreshToken: "rt",
      expiresAt: Date.now() + 10 * 60_000,
    });
    // No fetch should happen; if it does, the stub would change the token.
    const token = await ensureFreshGoogleAccessToken(ctx(), id, appDb);
    expect(token).toBe("still-fresh");
  });

  test("ensureFreshGoogleAccessToken: refreshes when expired and preserves the refresh token", async () => {
    const id = await seedConnected({
      clientId: "c",
      clientSecret: "s",
      accessToken: "old",
      refreshToken: "rt-keep",
      expiresAt: Date.now() - 1000,
    });
    const token = await withStubbedFetch(
      () =>
        new Response(
          // Note: no refresh_token in the response → the existing one must be preserved.
          JSON.stringify({ access_token: "new-token", expires_in: 3600 }),
          { status: 200 },
        ),
      async (calls) => {
        const t = await ensureFreshGoogleAccessToken(ctx(), id, appDb);
        expect(calls[0]?.get("grant_type")).toBe("refresh_token");
        expect(calls[0]?.get("refresh_token")).toBe("rt-keep");
        return t;
      },
    );
    expect(token).toBe("new-token");

    // Persisted: new access token + preserved refresh token.
    const persisted = decryptJson<GoogleOAuthCredential>(
      (
        await suDb.vaultEntry.findUniqueOrThrow({
          where: { id },
          select: { secret: true },
        })
      ).secret,
    );
    expect(persisted.accessToken).toBe("new-token");
    expect(persisted.refreshToken).toBe("rt-keep");
    expect(persisted.expiresAt).toBeGreaterThan(Date.now());
  });

  test("ensureFreshGoogleAccessToken: throws when never connected", async () => {
    const id = await seedConnected({ clientId: "c", clientSecret: "s" });
    await expect(
      ensureFreshGoogleAccessToken(ctx(), id, appDb),
    ).rejects.toThrow();
  });
});
