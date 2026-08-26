import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  buildOAuthCallbackHtml,
  newNonce,
  OAUTH_CALLBACK_SCRIPT,
} from "./oauth-core";
import { vaultRefWhere } from "./service";

// Re-export the shared OAuth primitives under their existing names so callers of this module
// (oauth-google.controller.ts, tests) keep importing them from here.
export {
  computeCodeChallenge,
  encryptOAuthState,
  generateCodeVerifier,
} from "./oauth-core";

// Back-compat alias: the CSP pin (csp.ts) and tests reference this name. One FIXED script serves
// every OAuth consent popup (google + mcp); the channel/type ride in the non-executable cfg block.
export const GOOGLE_OAUTH_CALLBACK_SCRIPT = OAUTH_CALLBACK_SCRIPT;

// Google OAuth 2.1 credential mechanics for the `google_oauth` vault kind. The operator stores
// { clientId, clientSecret }; the consent popup (oauth-google.controller.ts) runs Authorization
// Code + PKCE and MERGES the issued tokens into the same encrypted blob. At consumption the runtime
// calls ensureFreshGoogleAccessToken (auto-refresh, 1-minute buffer) and injects the access token as
// a bearer header. Network only touches Google's fixed OAuth endpoints (no SSRF surface) and always
// happens OUTSIDE any Prisma transaction.

// Fixed Google OAuth endpoints. No operator-supplied URL ever reaches fetch here (no SSRF guard
// needed): every call targets one of these constants.
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

const TOKEN_TIMEOUT_MS = 10_000;
// Refresh when the current access token would expire within this window, so a token never goes stale
// mid-request.
const REFRESH_BUFFER_MS = 60_000;
// OAuth state is short-lived: it only has to survive the consent round-trip.
export const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_SCOPES = 20;

export interface GoogleOAuthCredential {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  // ms since epoch.
  expiresAt?: number;
  scopes?: string[];
  email?: string;
}

export interface GoogleOAuthState {
  v: 1;
  entryId: string;
  tenantId: string;
  userId: string;
  scopes: string[];
  codeVerifier: string;
  // ms since epoch.
  exp: number;
  nonce: string;
}

// ── scope validation ──

const SCOPE_URL_RE = /^https:\/\/www\.googleapis\.com\/auth\/[\w.-]+$/;
const SHORT_SCOPES = new Set(["openid", "email", "profile"]);

// Validates the requested scopes against the closed Google set, dedupes, always ensures openid+email
// (we need the id_token's verified email), and caps the count. Throws on any invalid scope so a
// malformed grant fails loudly instead of silently dropping scopes.
export function validateScopes(requested: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const scope = raw.trim();
    if (!scope) continue;
    if (!SHORT_SCOPES.has(scope) && !SCOPE_URL_RE.test(scope)) {
      throw new AppError(
        `invalid Google OAuth scope: ${scope}`,
        400,
        "errors.googleOAuthInvalidScope",
        { scope },
      );
    }
    if (!seen.has(scope)) {
      seen.add(scope);
      out.push(scope);
    }
  }
  for (const required of ["openid", "email"]) {
    if (!seen.has(required)) {
      seen.add(required);
      out.push(required);
    }
  }
  if (out.length > MAX_SCOPES) {
    throw new AppError(
      `too many Google OAuth scopes (max ${MAX_SCOPES})`,
      400,
      "errors.googleOAuthTooManyScopes",
      { max: MAX_SCOPES },
    );
  }
  return out;
}

// ── state (encrypted, opaque to the browser) ──
// encryptOAuthState is re-exported from oauth-core (above); decrypt keeps the Google shape check.

export function decryptOAuthState(blob: string): GoogleOAuthState {
  const state = decryptJson<GoogleOAuthState>(blob);
  if (
    state?.v !== 1 ||
    typeof state.entryId !== "string" ||
    typeof state.tenantId !== "string" ||
    typeof state.userId !== "string" ||
    typeof state.codeVerifier !== "string" ||
    typeof state.exp !== "number" ||
    typeof state.nonce !== "string" ||
    !Array.isArray(state.scopes)
  ) {
    throw new AppError("invalid oauth state", 400);
  }
  return state;
}

export function buildState(params: {
  entryId: string;
  tenantId: string;
  userId: string;
  scopes: string[];
  codeVerifier: string;
}): GoogleOAuthState {
  return {
    v: 1,
    entryId: params.entryId,
    tenantId: params.tenantId,
    userId: params.userId,
    scopes: params.scopes,
    codeVerifier: params.codeVerifier,
    exp: Date.now() + STATE_TTL_MS,
    nonce: newNonce(),
  };
}

// ── authorize URL ──

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // access_type=offline + prompt=consent so Google returns a refresh_token (it omits it on repeat
  // consents otherwise, which would break unattended refresh).
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

// ── token exchange / refresh ──

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

// Decodes the email claim from the id_token. NOTE: signature verification is intentionally skipped —
// the id_token arrives in the token-endpoint response over TLS directly from Google (not relayed by
// the browser), so its integrity is already established by the transport; we only read the email.
function emailFromIdToken(idToken: string | undefined): string {
  if (!idToken) return "";
  const parts = idToken.split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8"),
    ) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

async function postToken(
  body: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!res.ok || json.error) {
    throw new AppError(
      `google token endpoint error: ${json.error ?? res.status}`,
      json.error === "invalid_grant" ? 400 : 502,
      "errors.googleOAuthTokenEndpointError",
      { reason: String(json.error ?? res.status) },
    );
  }
  return json;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
  email: string;
}

export async function exchangeCodeForTokens(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ExchangedTokens> {
  const json = await postToken({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  if (!json.access_token) {
    throw new AppError(
      "google token response missing access_token",
      502,
      "errors.googleOAuthTokenExchangeFailed",
    );
  }
  // A missing refresh_token would leave the credential unable to refresh unattended; fail loudly.
  if (!json.refresh_token) {
    throw new AppError(
      "google token response missing refresh_token (re-consent with access_type=offline)",
      400,
      "errors.googleOAuthNoRefreshToken",
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in ?? 3600,
    scopes: (json.scope ?? "").split(/\s+/).filter(Boolean),
    email: emailFromIdToken(json.id_token),
  };
}

// ── revocation ──

// Best-effort: a failed revoke must never block disconnect (the credential is removed regardless).
export async function revokeGoogleToken(refreshToken: string): Promise<void> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
    try {
      await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // swallow — disconnect proceeds regardless.
  }
}

// ── refresh on consumption ──

// Returns a fresh access token for a stored google_oauth entry, refreshing via Google when the
// current one is within REFRESH_BUFFER_MS of expiry. The DB reads/writes are short scoped
// transactions; the Google refresh call happens BETWEEN them (never inside a tx). The new token is
// persisted (preserving the refresh_token when Google does not return a new one).
export async function ensureFreshGoogleAccessToken(
  ctx: TenantContext,
  entryId: bigint,
  base: PrismaClient = basePrisma,
): Promise<string> {
  const ref = `vault:${entryId}`;
  const cred = await runScopedOn(base, ctx, async (db) => {
    const entry = await db.vaultEntry.findFirst({
      where: vaultRefWhere(ref),
      select: { secret: true, kind: true },
    });
    if (!entry) {
      throw new AppError(
        "google_oauth credential not found",
        404,
        "errors.googleOAuthCredentialNotFound",
      );
    }
    if (entry.kind !== "google_oauth") {
      throw new AppError(
        `credential ${entryId} is not a google_oauth credential`,
        400,
      );
    }
    return decryptJson<GoogleOAuthCredential>(entry.secret);
  });

  if (!cred.accessToken || !cred.refreshToken) {
    throw new AppError(
      "google_oauth credential is not connected",
      400,
      "errors.googleOAuthNotConnected",
    );
  }

  // Still fresh: nothing to do.
  if (cred.expiresAt && cred.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return cred.accessToken;
  }

  // Refresh (network, OUTSIDE any tx).
  const json = await postToken({
    grant_type: "refresh_token",
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
    refresh_token: cred.refreshToken,
  });
  if (!json.access_token) {
    throw new AppError(
      "google refresh response missing access_token",
      502,
      "errors.googleOAuthRefreshFailed",
    );
  }

  const refreshed: GoogleOAuthCredential = {
    ...cred,
    accessToken: json.access_token,
    // Google usually omits refresh_token on refresh; preserve the existing one.
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

// ── callback HTML (CSP-safe) ──

// Renders the shared CSP-safe consent-popup callback (buildOAuthCallbackHtml), bound to the Google
// channel/type the SPA's GoogleOAuthSection listens on. `targetOrigin` is the parent window's origin
// for the postMessage; an empty origin disables the opener postMessage (the BroadcastChannel still
// works for same-origin popups).
export function buildCallbackHtml(
  ok: boolean,
  message: string,
  targetOrigin: string,
): string {
  return buildOAuthCallbackHtml({
    ok,
    message,
    targetOrigin,
    channel: "oauth-google",
    type: "google-oauth",
    title: "Google OAuth",
  });
}

// Status projection for the operator UI: connection state without ever exposing tokens or the
// client secret.
export interface GoogleOAuthStatus {
  connected: boolean;
  email?: string;
  scopes?: string[];
  expiresAt?: string;
}

export function projectStatus(cred: GoogleOAuthCredential): GoogleOAuthStatus {
  const connected = !!(cred.accessToken && cred.refreshToken);
  if (!connected) return { connected: false };
  return {
    connected: true,
    email: cred.email,
    scopes: cred.scopes,
    expiresAt: cred.expiresAt
      ? new Date(cred.expiresAt).toISOString()
      : undefined,
  };
}
