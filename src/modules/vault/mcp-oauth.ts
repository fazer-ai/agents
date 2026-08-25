import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  decryptOAuthStateRaw,
  encryptOAuthState,
  newNonce,
} from "./oauth-core";
import { vaultRefWhere } from "./service";

// Generic OAuth 2.1 client mechanics for the `mcp_oauth` vault kind: discovery (RFC 8414 / 9728) +
// Dynamic Client Registration (RFC 7591) + Authorization Code + PKCE (RFC 7636) + RFC 8707
// `resource` binding + refresh-token rotation. The operator stores ONLY the MCP server URL
// (VaultEntry.baseUrl); the consent flow (oauth-mcp.controller.ts) discovers + registers + MERGES
// the issued tokens into the encrypted blob. At consumption the runtime calls
// ensureFreshMcpAccessToken (auto-refresh + single-flight) and injects the access token as a bearer
// header. Every outbound URL is operator-derived, so each fetch passes the SSRF guard (unlike the
// google_oauth path, whose endpoints are fixed Google constants). All network happens OUTSIDE any
// Prisma transaction.

const TOKEN_TIMEOUT_MS = 10_000;
// Refresh when the access token would expire within this window so it never goes stale mid-request.
const REFRESH_BUFFER_MS = 60_000;
// OAuth state only has to survive the consent round-trip.
export const STATE_TTL_MS = 10 * 60 * 1000;

// The stored credential blob. Discovery + clientId are persisted at Connect time; tokens are merged
// by the callback. A future `manual` override (operator-supplied endpoints/client) slots in here.
export interface McpOAuthCredential {
  // ── discovered ──
  resource?: string; // RFC 8707 aud (protected-resource metadata `resource`)
  issuer?: string; // authorization-server issuer (RFC 9207 `iss`)
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  // ── client (DCR; or future manual) ──
  clientId?: string;
  clientSecret?: string; // confidential clients only; absent for public PKCE
  scopes?: string[];
  // ── tokens (after consent) ──
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // ms since epoch
}

// The encrypted, browser-opaque `state`. Binds the flow to the issuing tenant/user/entry AND to the
// discovered token endpoint / resource / issuer / client, so the callback exchanges the code against
// exactly the server the authorize step used (mix-up / target-confusion defense, complements the
// RFC 9207 `iss` check) without re-reading the blob.
export interface McpOAuthState {
  v: 1;
  entryId: string;
  tenantId: string;
  userId: string;
  codeVerifier: string;
  tokenEndpoint: string;
  issuer: string;
  resource: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
  exp: number;
  nonce: string;
}

// SSRF posture for the operator-derived OAuth fetches. Mirrors the MCP tool loader: in dev
// (allowPrivateTargets auto-true) localhost/http is reachable; in prod only public https.
export interface OAuthNetOpts {
  allowPrivate: boolean;
  allowHttp: boolean;
}

export function defaultNetOpts(): OAuthNetOpts {
  const allow = config.ssrf.allowPrivateTargets;
  return { allowPrivate: allow, allowHttp: allow };
}

// ── low-level fetch helpers (SSRF-guarded, timed out) ──

async function timedFetch(
  url: string,
  init: RequestInit,
  opts: OAuthNetOpts,
): Promise<Response> {
  await assertSafeOutboundUrl(url, {
    allowHttp: opts.allowHttp,
    allowPrivate: opts.allowPrivate,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string, opts: OAuthNetOpts): Promise<T> {
  const res = await timedFetch(url, { method: "GET" }, opts);
  if (!res.ok) {
    throw new AppError(
      `oauth discovery GET ${url} failed: ${res.status}`,
      502,
      "errors.mcpOAuthDiscoveryFailed",
      { url, status: res.status },
    );
  }
  return (await res.json()) as T;
}

// ── discovery (RFC 9728 protected-resource → RFC 8414 authorization-server) ──

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
}

interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface DiscoveredOAuthServer {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported: string[];
}

function originOf(url: string): string {
  return new URL(url).origin;
}

// Discovers the authorization server for an MCP base URL: the protected-resource metadata at the
// base's origin gives the canonical `resource` + the authorization server; the auth-server metadata
// gives the endpoints. Every discovered URL is SSRF-guarded; S256 PKCE support is required.
export async function discoverOAuthServer(
  baseUrl: string,
  opts: OAuthNetOpts,
): Promise<DiscoveredOAuthServer> {
  await assertSafeOutboundUrl(baseUrl, {
    allowHttp: opts.allowHttp,
    allowPrivate: opts.allowPrivate,
  });
  const origin = originOf(baseUrl);

  const prm = await getJson<ProtectedResourceMetadata>(
    `${origin}/.well-known/oauth-protected-resource`,
    opts,
  );
  const resource = prm.resource ?? baseUrl;
  const issuer = prm.authorization_servers?.[0];
  if (!issuer) {
    throw new AppError(
      "protected-resource metadata has no authorization_servers",
      502,
      "errors.mcpOAuthNoAuthorizationServer",
    );
  }

  const asm = await getJson<AuthServerMetadata>(
    `${originOf(issuer)}/.well-known/oauth-authorization-server`,
    opts,
  );
  if (!asm.authorization_endpoint || !asm.token_endpoint) {
    throw new AppError(
      "authorization-server metadata is missing endpoints",
      502,
      "errors.mcpOAuthMetadataIncomplete",
    );
  }
  if (
    asm.code_challenge_methods_supported &&
    !asm.code_challenge_methods_supported.includes("S256")
  ) {
    throw new AppError(
      "authorization server does not support PKCE S256",
      400,
      "errors.mcpOAuthPkceUnsupported",
    );
  }

  for (const u of [
    asm.authorization_endpoint,
    asm.token_endpoint,
    ...(asm.registration_endpoint ? [asm.registration_endpoint] : []),
  ]) {
    await assertSafeOutboundUrl(u, {
      allowHttp: opts.allowHttp,
      allowPrivate: opts.allowPrivate,
    });
  }

  return {
    resource,
    issuer: asm.issuer ?? issuer,
    authorizationEndpoint: asm.authorization_endpoint,
    tokenEndpoint: asm.token_endpoint,
    registrationEndpoint: asm.registration_endpoint,
    scopesSupported: asm.scopes_supported ?? [],
  };
}

// ── Dynamic Client Registration (RFC 7591) ──

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: string;
}

interface DcrResponse {
  client_id?: string;
  client_secret?: string;
  token_endpoint_auth_method?: string;
  error?: string;
  error_description?: string;
}

// Registers a public PKCE client at the server's registration endpoint. A server WITHOUT DCR (no
// registration_endpoint advertised) throws mcpOAuthDcrDisabled — manual client config is a future
// extension.
export async function registerClient(params: {
  registrationEndpoint?: string;
  redirectUri: string;
  clientName?: string;
  scopes?: string[];
  opts: OAuthNetOpts;
}): Promise<RegisteredClient> {
  if (!params.registrationEndpoint) {
    throw new AppError(
      "the MCP server does not support Dynamic Client Registration; manual client config is required",
      400,
      "errors.mcpOAuthDcrDisabled",
    );
  }
  const res = await timedFetch(
    params.registrationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [params.redirectUri],
        client_name: params.clientName ?? "fazer.ai agents",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(params.scopes && params.scopes.length > 0
          ? { scope: params.scopes.join(" ") }
          : {}),
      }),
    },
    params.opts,
  );
  const json = (await res.json().catch(() => ({}))) as DcrResponse;
  if (!res.ok || !json.client_id) {
    throw new AppError(
      `dynamic client registration failed: ${json.error ?? res.status}`,
      502,
      "errors.mcpOAuthDcrFailed",
      { reason: json.error ?? res.status },
    );
  }
  return {
    clientId: json.client_id,
    clientSecret: json.client_secret,
    tokenEndpointAuthMethod: json.token_endpoint_auth_method ?? "none",
  };
}

// ── authorize URL ──

export function buildMcpAuthorizeUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  resource: string;
}): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  if (params.scopes.length > 0)
    url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // RFC 8707: bind the request to the MCP resource so the issued token's `aud` matches.
  url.searchParams.set("resource", params.resource);
  return url.toString();
}

// ── state ──

export function buildMcpState(params: {
  entryId: string;
  tenantId: string;
  userId: string;
  codeVerifier: string;
  tokenEndpoint: string;
  issuer: string;
  resource: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
}): McpOAuthState {
  return {
    v: 1,
    ...params,
    exp: Date.now() + STATE_TTL_MS,
    nonce: newNonce(),
  };
}

export { encryptOAuthState };

export function decryptMcpState(blob: string): McpOAuthState {
  const state = decryptOAuthStateRaw<McpOAuthState>(blob);
  if (
    state?.v !== 1 ||
    typeof state.entryId !== "string" ||
    typeof state.tenantId !== "string" ||
    typeof state.userId !== "string" ||
    typeof state.codeVerifier !== "string" ||
    typeof state.tokenEndpoint !== "string" ||
    typeof state.issuer !== "string" ||
    typeof state.resource !== "string" ||
    typeof state.clientId !== "string" ||
    typeof state.redirectUri !== "string" ||
    typeof state.exp !== "number" ||
    typeof state.nonce !== "string"
  ) {
    throw new AppError(
      "invalid oauth state",
      400,
      "errors.mcpOAuthInvalidState",
    );
  }
  return state;
}

// ── token endpoint (exchange / refresh) ──

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

// token_endpoint_auth_method: a confidential client (clientSecret present) authenticates via
// client_secret_post; a public PKCE client sends only client_id.
function clientAuthFields(
  clientId: string,
  clientSecret?: string,
): Record<string, string> {
  return clientSecret
    ? { client_id: clientId, client_secret: clientSecret }
    : { client_id: clientId };
}

async function postToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  opts: OAuthNetOpts,
): Promise<TokenResponse> {
  const res = await timedFetch(
    tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    },
    opts,
  );
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new AppError(
      `mcp token endpoint error: ${json.error ?? res.status}`,
      json.error === "invalid_grant" ? 400 : 502,
      "errors.mcpOAuthTokenEndpointError",
      { reason: String(json.error ?? res.status) },
    );
  }
  return json;
}

export interface ExchangedMcpTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scopes: string[];
}

export async function exchangeMcpCode(params: {
  tokenEndpoint: string;
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
  opts: OAuthNetOpts;
}): Promise<ExchangedMcpTokens> {
  const json = await postToken(
    params.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      resource: params.resource,
      ...clientAuthFields(params.clientId, params.clientSecret),
    },
    params.opts,
  );
  if (!json.access_token) {
    throw new AppError(
      "mcp token response missing access_token",
      502,
      "errors.mcpOAuthTokenExchangeFailed",
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in ?? 3600,
    scopes: (json.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

// ── refresh on consumption (single-flight) ──

// In-process single-flight per credential (entryId): a rotating refresh token spent twice trips the
// server's family-wide reuse detection and revokes the whole family, so two concurrent turns must
// NOT both refresh. The read + expiry-check + refresh + write all live inside one coalesced promise
// resolving to the access-token string; a second caller awaits it and gets the first caller's fresh
// token. Single-replica is a deploy invariant, so an in-process Map suffices (no Redis/DB lock).
const refreshInFlight = new Map<string, Promise<string>>();

async function refreshNow(
  ctx: TenantContext,
  entryId: bigint,
  base: PrismaClient,
): Promise<string> {
  const ref = `vault:${entryId}`;
  const cred = await runScopedOn(base, ctx, async (db) => {
    const entry = await db.vaultEntry.findFirst({
      where: vaultRefWhere(ref),
      select: { secret: true, kind: true },
    });
    if (!entry)
      throw new AppError(
        "mcp_oauth credential not found",
        404,
        "errors.mcpOAuthCredentialNotFound",
      );
    if (entry.kind !== "mcp_oauth")
      throw new AppError(
        `credential ${entryId} is not an mcp_oauth credential`,
        400,
      );
    return decryptJson<McpOAuthCredential>(entry.secret);
  });

  if (
    !cred.accessToken ||
    !cred.refreshToken ||
    !cred.tokenEndpoint ||
    !cred.clientId ||
    !cred.resource
  ) {
    throw new AppError(
      "mcp_oauth credential is not connected",
      400,
      "errors.mcpOAuthNotConnected",
    );
  }

  // Still fresh: nothing to do.
  if (cred.expiresAt && cred.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return cred.accessToken;
  }

  // Refresh (network, OUTSIDE any tx).
  const json = await postToken(
    cred.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: cred.refreshToken,
      resource: cred.resource,
      ...clientAuthFields(cred.clientId, cred.clientSecret),
    },
    defaultNetOpts(),
  );
  if (!json.access_token) {
    throw new AppError(
      "mcp refresh response missing access_token",
      502,
      "errors.mcpOAuthRefreshFailed",
    );
  }

  const refreshed: McpOAuthCredential = {
    ...cred,
    accessToken: json.access_token,
    // Rotation: persist the NEW refresh token; keep the old only if the server did not rotate.
    refreshToken: json.refresh_token ?? cred.refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    scopes: json.scope ? json.scope.split(/\s+/).filter(Boolean) : cred.scopes,
  };

  await runScopedOn(base, ctx, async (db) => {
    await db.vaultEntry.updateMany({
      where: vaultRefWhere(ref),
      data: { secret: encryptJson(refreshed) },
    });
  });

  return refreshed.accessToken as string;
}

export async function ensureFreshMcpAccessToken(
  ctx: TenantContext,
  entryId: bigint,
  base: PrismaClient = basePrisma,
): Promise<string> {
  const key = String(entryId);
  const existing = refreshInFlight.get(key);
  if (existing) return existing;
  const p = refreshNow(ctx, entryId, base).finally(() => {
    refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, p);
  return p;
}

// ── status projection (never exposes tokens or the client secret) ──

export interface McpOAuthStatus {
  connected: boolean;
  registered: boolean;
  issuer?: string;
  resource?: string;
  scopes?: string[];
  expiresAt?: string;
}

export function projectMcpStatus(cred: McpOAuthCredential): McpOAuthStatus {
  const registered = !!(cred.clientId && cred.tokenEndpoint);
  // Connected = we hold a usable access token. A server that issues no refresh_token still connects
  // (it just cannot auto-refresh; consumption throws once the token expires).
  const connected = !!cred.accessToken;
  return {
    connected,
    registered,
    issuer: cred.issuer,
    resource: cred.resource,
    scopes: cred.scopes,
    expiresAt:
      connected && cred.expiresAt
        ? new Date(cred.expiresAt).toISOString()
        : undefined,
  };
}
