import { Elysia, t } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { doc, errors, htmlResponse } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import {
  asSuperAdmin,
  roleAtLeast,
  runScopedOn,
  type TenantContext,
} from "@/lib/tenancy";
import {
  buildAuthorizeUrl,
  buildCallbackHtml,
  buildState,
  computeCodeChallenge,
  decryptOAuthState,
  encryptOAuthState,
  exchangeCodeForTokens,
  type GoogleOAuthCredential,
  generateCodeVerifier,
  projectStatus,
  revokeGoogleToken,
  validateScopes,
} from "@/modules/vault/google-oauth";
import { vaultRefWhere } from "@/modules/vault/service";

// Google OAuth consent flow for the `google_oauth` vault kind. Two controllers:
//   - oauthGoogleVaultController: authorize / status / disconnect, mounted alongside vault under the
//     tenancy plugin (TENANT_ADMIN).
//   - oauthGoogleCallbackController: the popup redirect target, mounted OUTSIDE the tenancy plugin
//     (Google's redirect carries no X-Tenant-Id), cookie-auth only. Always returns HTML so the popup
//     can postMessage the result to its opener and self-close.

// NOTE: these AppError translationKeys are localized centrally in `onError`; declared here for the
// i18n extractor (keepRemoved: false). Keep in sync with src/api/locales/*.json.
// translate('errors.googleOAuthInvalidScope', 'Invalid Google OAuth scope: {{scope}}')
// translate('errors.googleOAuthTooManyScopes', 'Too many Google OAuth scopes (at most {{max}})')
// translate('errors.googleOAuthTokenExchangeFailed', 'Failed to exchange the Google authorization code')
// translate('errors.googleOAuthNoRefreshToken', 'Google did not return a refresh token; re-consent is required')
// translate('errors.googleOAuthNotConnected', 'This Google credential is not connected')
// translate('errors.googleOAuthCredentialNotFound', 'This Google credential no longer exists')
// translate('errors.googleOAuthTokenEndpointError', 'Google refused the token request: {{reason}}')
// translate('errors.googleOAuthRefreshFailed', 'Could not refresh the Google credential: the answer carried no access token. Reconnect it.')
// translate('errors.googleOAuthWrongKind', 'This credential is not a Google OAuth credential')

const idParams = t.Object({
  id: t.String({
    description: "Vault entry id (BigInt serialized as a decimal string).",
  }),
});

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new ForbiddenError();
  return ctx;
}

const REDIRECT_PATH = "/api/v1/oauth/google/callback";

function callbackRedirectUri(): string {
  return `${config.publicUrl.replace(/\/$/, "")}${REDIRECT_PATH}`;
}

// Loads + decrypts a google_oauth credential within the tenant scope. Throws if missing or the wrong
// kind.
async function loadGoogleCredential(
  ctx: TenantContext,
  id: bigint,
): Promise<GoogleOAuthCredential> {
  return runScopedOn(basePrisma, ctx, async (db) => {
    const entry = await db.vaultEntry.findFirst({
      where: { id },
      select: { secret: true, kind: true },
    });
    if (!entry) throw new NotFoundError(`vault entry ${id} not found`);
    if (entry.kind !== "google_oauth") {
      throw new ForbiddenError(
        "not a google_oauth credential",
        "errors.googleOAuthWrongKind",
      );
    }
    return decryptJson<GoogleOAuthCredential>(entry.secret);
  });
}

export const oauthGoogleVaultController = new Elysia({
  prefix: "/v1/vault",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  // Begin the consent flow: build the Google authorization URL + state for entry :id.
  .post(
    "/:id/oauth/google/authorize",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = requireDbId(params.id);
      const cred = await loadGoogleCredential(ctx, id);
      const scopes = validateScopes((body as { scopes: string[] }).scopes);
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = computeCodeChallenge(codeVerifier);
      const state = encryptOAuthState(
        buildState({
          entryId: String(id),
          tenantId: String(ctx.tenantId),
          userId: String(ctx.userId),
          scopes,
          codeVerifier,
        }),
      );
      const redirectUri = callbackRedirectUri();
      const url = buildAuthorizeUrl({
        clientId: cred.clientId,
        redirectUri,
        scopes,
        state,
        codeChallenge,
      });
      return { instance: instanceIdentity, url, redirectUri };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Begin Google OAuth consent",
        "Builds the Google authorization URL and signed state to start the consent flow for a google_oauth vault entry.",
      ),
      params: idParams,
      body: t.Object({
        scopes: t.Array(
          t.String({ description: "Google OAuth scope to request." }),
          { description: "Google OAuth scopes to request during consent." },
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  // Connection status (never returns tokens or the client secret).
  .get(
    "/:id/oauth/google/status",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const cred = await loadGoogleCredential(ctx, requireDbId(params.id));
      return { instance: instanceIdentity, ...projectStatus(cred) };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Google OAuth connection status",
        "Returns the connection state of a google_oauth vault entry; never returns tokens or the client secret.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404),
    },
  )
  // Disconnect: best-effort revoke the refresh token, then drop the tokens (keep clientId/secret).
  .post(
    "/:id/oauth/google/disconnect",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = requireDbId(params.id);
      const cred = await loadGoogleCredential(ctx, id);
      if (cred.refreshToken) await revokeGoogleToken(cred.refreshToken);
      const stripped: GoogleOAuthCredential = {
        clientId: cred.clientId,
        clientSecret: cred.clientSecret,
      };
      await runScopedOn(basePrisma, ctx, async (db) => {
        await db.vaultEntry.updateMany({
          where: { id },
          data: { secret: encryptJson(stripped) },
        });
      });
      return { instance: instanceIdentity, ...projectStatus(stripped) };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Disconnect Google OAuth",
        "Best-effort revokes the refresh token and drops the stored tokens for a google_oauth vault entry, keeping the client id and secret.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404),
    },
  );

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;

// HTML response helpers. The popup always receives HTML so it can postMessage + self-close; error
// responses carry 400/401 status without leaking internals into the message.
function htmlError(status: number, message: string, origin: string): Response {
  return new Response(buildCallbackHtml(false, message, origin), {
    status,
    headers: HTML_HEADERS,
  });
}

function htmlSuccess(origin: string): Response {
  return new Response(buildCallbackHtml(true, "connected", origin), {
    status: 200,
    headers: HTML_HEADERS,
  });
}

export const oauthGoogleCallbackController = new Elysia({
  prefix: "/v1/oauth/google",
  tags: ["Settings"],
})
  .use(authPlugin)
  // The popup redirect target. Cookie-auth (no tenancy header); state binds the flow to the issuing
  // user/tenant/entry. ALWAYS returns HTML (never leaks internals into the message).
  .get(
    "/callback",
    async ({ getAuthUser, query, request }) => {
      // The opener's origin for postMessage. The configured public URL is authoritative; the Origin
      // header is only a fallback when publicUrl is unparseable, and never the literal "null" that
      // browsers send on cross-site redirect navigations (it would break the postMessage fallback).
      let origin = "";
      try {
        origin = new URL(config.publicUrl).origin;
      } catch {
        const headerOrigin = request.headers.get("origin");
        if (headerOrigin && headerOrigin !== "null") origin = headerOrigin;
      }

      if (query.error) {
        return htmlError(400, query.error, origin);
      }
      if (!query.code || !query.state) {
        return htmlError(400, "missing_code_or_state", origin);
      }

      const user = await getAuthUser();
      if (!user) {
        return htmlError(401, "unauthenticated", origin);
      }

      try {
        const state = decryptOAuthState(query.state);
        if (state.exp <= Date.now()) {
          return htmlError(400, "state_expired", origin);
        }
        if (state.userId !== String(user.id)) {
          return htmlError(401, "state_user_mismatch", origin);
        }
        // The user must be TENANT_ADMIN of the state's tenant (or SUPER_ADMIN).
        const sameTenant =
          user.tenantId !== null && String(user.tenantId) === state.tenantId;
        const authorized =
          user.role === "SUPER_ADMIN" ||
          (sameTenant && roleAtLeast(user.role, "TENANT_ADMIN"));
        if (!authorized) {
          return htmlError(401, "not_authorized", origin);
        }

        const entryId = BigInt(state.entryId);
        // Load by id directly (we have the exact id from signed state). asSuperAdmin so the read is
        // tenant-agnostic; the cred is rebound to the state's tenant on write below.
        const cred = await asSuperAdmin(async (db) => {
          const entry = await db.vaultEntry.findFirst({
            where: {
              ...vaultRefWhere(`vault:${entryId}`),
              kind: "google_oauth",
            },
            select: { secret: true },
          });
          if (!entry) return null;
          return decryptJson<GoogleOAuthCredential>(entry.secret);
        });
        if (!cred) {
          return htmlError(400, "credential_not_found", origin);
        }

        const tokens = await exchangeCodeForTokens({
          code: query.code,
          clientId: cred.clientId,
          clientSecret: cred.clientSecret,
          redirectUri: callbackRedirectUri(),
          codeVerifier: state.codeVerifier,
        });

        const merged: GoogleOAuthCredential = {
          clientId: cred.clientId,
          clientSecret: cred.clientSecret,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: Date.now() + tokens.expiresIn * 1000,
          scopes: tokens.scopes.length > 0 ? tokens.scopes : state.scopes,
          email: tokens.email || undefined,
        };
        await asSuperAdmin(async (db) => {
          await db.vaultEntry.updateMany({
            where: vaultRefWhere(`vault:${entryId}`),
            data: { secret: encryptJson(merged) },
          });
        });

        return htmlSuccess(origin);
      } catch (err) {
        logger.warn({ err }, "google oauth callback failed");
        return htmlError(400, "callback_failed", origin);
      }
    },
    {
      detail: {
        ...doc(
          "Google OAuth callback",
          "Public popup redirect target for the Google consent flow; cookie-authenticated in-handler and bound by the signed state, it always returns HTML so the popup can postMessage the result to its opener and self-close.",
        ),
        security: [],
        responses: {
          200: htmlResponse(
            "HTML page that posts the successful result to the opener window and self-closes.",
          ),
          400: htmlResponse(
            "HTML page reporting a failed flow (provider error, missing or expired state, token exchange failure) without leaking internals.",
          ),
          401: htmlResponse(
            "HTML page reporting an unauthenticated caller or a state/user mismatch.",
          ),
        },
      },
      query: t.Object({
        code: t.Optional(
          t.String({
            description:
              "Google OAuth authorization code to exchange for tokens.",
          }),
        ),
        state: t.Optional(
          t.String({
            description:
              "Opaque encrypted state that binds the flow to the issuing user, tenant and vault entry.",
          }),
        ),
        error: t.Optional(
          t.String({
            description:
              "OAuth error code returned by Google when consent fails.",
          }),
        ),
        scope: t.Optional(
          t.String({
            description: "Space-delimited scopes Google actually granted.",
          }),
        ),
        authuser: t.Optional(
          t.String({
            description: "Google account index selected during consent.",
          }),
        ),
        prompt: t.Optional(
          t.String({
            description:
              "Google consent prompt behavior echoed back in the redirect.",
          }),
        ),
      }),
    },
  );
