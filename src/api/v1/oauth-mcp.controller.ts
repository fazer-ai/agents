import { Elysia, t } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { doc, errors, htmlResponse } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import {
  asSuperAdmin,
  roleAtLeast,
  runScopedOn,
  type TenantContext,
} from "@/lib/tenancy";
import {
  buildMcpAuthorizeUrl,
  buildMcpState,
  decryptMcpState,
  defaultNetOpts,
  discoverOAuthServer,
  encryptOAuthState,
  exchangeMcpCode,
  type McpOAuthCredential,
  projectMcpStatus,
  registerClient,
} from "@/modules/vault/mcp-oauth";
import {
  buildOAuthCallbackHtml,
  computeCodeChallenge,
  generateCodeVerifier,
} from "@/modules/vault/oauth-core";
import { vaultRefWhere } from "@/modules/vault/service";

// Generic MCP OAuth 2.1 *consumer* flow for the `mcp_oauth` vault kind (this app acting as an OAuth
// client of an external MCP server — distinct from the PROVIDER-side mcpOAuthController under
// src/modules/mcp/oauth/*, which makes this app an OAuth server). Two controllers:
//   - oauthMcpVaultController: authorize / status / disconnect, mounted alongside vault under the
//     tenancy plugin (TENANT_ADMIN).
//   - oauthMcpCallbackController: the popup redirect target, mounted OUTSIDE the tenancy plugin (the
//     provider's redirect carries no X-Tenant-Id), cookie-auth only. Always returns HTML so the
//     popup can postMessage the result to its opener and self-close.

// NOTE: these AppError translationKeys are localized centrally in `onError`; declared here for the
// i18n extractor (keepRemoved: false). Keep in sync with src/api/locales/*.json.
// translate('errors.mcpOAuthDiscoveryFailed', 'Could not read the MCP server OAuth configuration: {{url}} answered {{status}}')
// translate('errors.mcpOAuthNoAuthorizationServer', 'The MCP server metadata names no authorization server, so there is nothing to connect to')
// translate('errors.mcpOAuthMetadataIncomplete', 'The MCP authorization server metadata is missing the authorization or token endpoint')
// translate('errors.mcpOAuthPkceUnsupported', 'The MCP authorization server does not support PKCE (S256), which is required to connect')
// translate('errors.mcpOAuthDcrDisabled', 'The MCP server does not support dynamic client registration')
// translate('errors.mcpOAuthDcrFailed', 'Dynamic client registration with the MCP server failed: {{reason}}')
// translate('errors.mcpOAuthTokenExchangeFailed', 'Failed to exchange the MCP authorization code')
// translate('errors.mcpOAuthNotConnected', 'This MCP credential is not connected')
// translate('errors.mcpOAuthNoServerUrl', 'This MCP credential has no server URL, so there is nothing to authorize')
// translate('errors.mcpOAuthCredentialNotFound', 'This MCP credential no longer exists')
// translate('errors.mcpOAuthTokenEndpointError', 'The MCP server refused the token request: {{reason}}')
// translate('errors.mcpOAuthRefreshFailed', 'Could not refresh the MCP credential: the answer carried no access token. Reconnect it.')
// translate('errors.mcpOAuthInvalidState', 'Invalid MCP OAuth state')
// translate('errors.mcpOAuthWrongKind', 'This credential is not an MCP OAuth credential')

const idParams = t.Object({
  id: t.String({
    pattern: "^\\d+$",
    description: "Vault entry id (BigInt serialized as a decimal string).",
  }),
});

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new ForbiddenError();
  return ctx;
}

const REDIRECT_PATH = "/api/v1/oauth/mcp/callback";

function callbackRedirectUri(): string {
  return `${config.publicUrl.replace(/\/$/, "")}${REDIRECT_PATH}`;
}

// The DCR client name the external MCP provider shows on its consent screen and registered-clients
// list. Includes our host so an operator with several environments can tell them apart.
function dcrClientName(): string {
  let host = config.publicUrl;
  try {
    host = new URL(config.publicUrl).host;
  } catch {
    // keep the raw publicUrl if it does not parse
  }
  return `fazer.ai agents (${host})`;
}

// Loads + decrypts an mcp_oauth credential (with its baseUrl) within the tenant scope. Throws if
// missing or the wrong kind.
async function loadMcpCredential(
  ctx: TenantContext,
  id: bigint,
): Promise<{ cred: McpOAuthCredential; baseUrl: string | null }> {
  return runScopedOn(basePrisma, ctx, async (db) => {
    const entry = await db.vaultEntry.findFirst({
      where: { id },
      select: { secret: true, kind: true, baseUrl: true },
    });
    if (!entry) throw new NotFoundError(`vault entry ${id} not found`);
    if (entry.kind !== "mcp_oauth") {
      throw new ForbiddenError(
        "not an mcp_oauth credential",
        "errors.mcpOAuthWrongKind",
      );
    }
    return {
      cred: decryptJson<McpOAuthCredential>(entry.secret),
      baseUrl: entry.baseUrl,
    };
  });
}

export const oauthMcpVaultController = new Elysia({
  prefix: "/v1/vault",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  // Begin the consent flow: discover the MCP server's OAuth config, register a client (DCR) if we
  // have none yet, persist that into the credential, then build the authorization URL + state.
  .post(
    "/:id/oauth/mcp/authorize",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = BigInt(params.id);
      const { cred, baseUrl } = await loadMcpCredential(ctx, id);
      if (!baseUrl) {
        throw new NotFoundError(
          "mcp_oauth credential has no MCP server URL (baseUrl)",
          "errors.mcpOAuthNoServerUrl",
        );
      }

      const opts = defaultNetOpts();
      const redirectUri = callbackRedirectUri();

      // Discover (network, outside tx).
      const disco = await discoverOAuthServer(baseUrl, opts);
      const requestedScopes =
        cred.scopes && cred.scopes.length > 0
          ? cred.scopes
          : disco.scopesSupported;

      // Register a client if we don't have one (DCR), else reuse the persisted one.
      let clientId = cred.clientId;
      let clientSecret = cred.clientSecret;
      if (!clientId) {
        const reg = await registerClient({
          registrationEndpoint: disco.registrationEndpoint,
          redirectUri,
          clientName: dcrClientName(),
          scopes: requestedScopes,
          opts,
        });
        clientId = reg.clientId;
        clientSecret = reg.clientSecret;
      }

      // Persist the discovered config + client into the credential blob (so the callback + the
      // runtime refresh have everything they need).
      const persisted: McpOAuthCredential = {
        ...cred,
        resource: disco.resource,
        issuer: disco.issuer,
        authorizationEndpoint: disco.authorizationEndpoint,
        tokenEndpoint: disco.tokenEndpoint,
        registrationEndpoint: disco.registrationEndpoint,
        clientId,
        clientSecret,
        scopes: requestedScopes,
      };
      await runScopedOn(basePrisma, ctx, async (db) => {
        await db.vaultEntry.updateMany({
          where: { id },
          data: { secret: encryptJson(persisted) },
        });
      });

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = computeCodeChallenge(codeVerifier);
      const state = encryptOAuthState(
        buildMcpState({
          entryId: String(id),
          tenantId: String(ctx.tenantId),
          userId: String(ctx.userId),
          codeVerifier,
          tokenEndpoint: disco.tokenEndpoint,
          issuer: disco.issuer,
          resource: disco.resource,
          clientId,
          clientSecret,
          redirectUri,
          scopes: requestedScopes,
        }),
      );
      const url = buildMcpAuthorizeUrl({
        authorizationEndpoint: disco.authorizationEndpoint,
        clientId,
        redirectUri,
        scopes: requestedScopes,
        state,
        codeChallenge,
        resource: disco.resource,
      });
      return { instance: instanceIdentity, url, redirectUri };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Begin MCP OAuth consent",
        "Discovers the MCP server OAuth configuration, registers a client via DCR if needed, and builds the authorization URL and signed state to start the consent flow for an mcp_oauth vault entry.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404, 422, 502),
    },
  )
  // Connection status (never returns tokens or the client secret).
  .get(
    "/:id/oauth/mcp/status",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const { cred } = await loadMcpCredential(ctx, BigInt(params.id));
      return { instance: instanceIdentity, ...projectMcpStatus(cred) };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "MCP OAuth connection status",
        "Returns the connection state of an mcp_oauth vault entry; never returns tokens or the client secret.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404, 422),
    },
  )
  // Disconnect: drop the tokens but keep the discovered config + registered client so a reconnect
  // skips discovery/DCR.
  .post(
    "/:id/oauth/mcp/disconnect",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = BigInt(params.id);
      const { cred } = await loadMcpCredential(ctx, id);
      const stripped: McpOAuthCredential = {
        resource: cred.resource,
        issuer: cred.issuer,
        authorizationEndpoint: cred.authorizationEndpoint,
        tokenEndpoint: cred.tokenEndpoint,
        registrationEndpoint: cred.registrationEndpoint,
        clientId: cred.clientId,
        clientSecret: cred.clientSecret,
        scopes: cred.scopes,
      };
      await runScopedOn(basePrisma, ctx, async (db) => {
        await db.vaultEntry.updateMany({
          where: { id },
          data: { secret: encryptJson(stripped) },
        });
      });
      return { instance: instanceIdentity, ...projectMcpStatus(stripped) };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Disconnect MCP OAuth",
        "Drops the stored tokens for an mcp_oauth vault entry, keeping the discovered OAuth config and registered client.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404, 422),
    },
  );

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;

function mcpCallbackHtml(ok: boolean, message: string, origin: string): string {
  return buildOAuthCallbackHtml({
    ok,
    message,
    targetOrigin: origin,
    channel: "oauth-mcp",
    type: "mcp-oauth",
    title: "MCP OAuth",
  });
}

function htmlError(status: number, message: string, origin: string): Response {
  return new Response(mcpCallbackHtml(false, message, origin), {
    status,
    headers: HTML_HEADERS,
  });
}

function htmlSuccess(origin: string): Response {
  return new Response(mcpCallbackHtml(true, "connected", origin), {
    status: 200,
    headers: HTML_HEADERS,
  });
}

export const oauthMcpCallbackController = new Elysia({
  prefix: "/v1/oauth/mcp",
  tags: ["Settings"],
})
  .use(authPlugin)
  // The popup redirect target. Cookie-auth (no tenancy header); the signed state binds the flow to
  // the issuing user/tenant/entry and to the discovered token endpoint/resource/issuer/client.
  // ALWAYS returns HTML (never leaks internals into the message).
  .get(
    "/callback",
    async ({ getAuthUser, query, request }) => {
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
        const state = decryptMcpState(query.state);
        if (state.exp <= Date.now()) {
          return htmlError(400, "state_expired", origin);
        }
        if (state.userId !== String(user.id)) {
          return htmlError(401, "state_user_mismatch", origin);
        }
        const sameTenant =
          user.tenantId !== null && String(user.tenantId) === state.tenantId;
        const authorized =
          user.role === "SUPER_ADMIN" ||
          (sameTenant && roleAtLeast(user.role, "TENANT_ADMIN"));
        if (!authorized) {
          return htmlError(401, "not_authorized", origin);
        }
        // RFC 9207 mix-up defense: when the provider echoes `iss`, it must match the authorization
        // server bound in the state. Absent iss is tolerated (older servers).
        if (query.iss && query.iss !== state.issuer) {
          return htmlError(400, "iss_mismatch", origin);
        }

        const tokens = await exchangeMcpCode({
          tokenEndpoint: state.tokenEndpoint,
          code: query.code,
          clientId: state.clientId,
          clientSecret: state.clientSecret,
          redirectUri: state.redirectUri,
          codeVerifier: state.codeVerifier,
          resource: state.resource,
          opts: defaultNetOpts(),
        });

        const entryId = BigInt(state.entryId);
        // Load by id directly (we have the exact id from signed state). asSuperAdmin so the read is
        // tenant-agnostic; the cred is rebound to the state's tenant on write below.
        const cred = await asSuperAdmin(async (db) => {
          const entry = await db.vaultEntry.findFirst({
            where: { ...vaultRefWhere(`vault:${entryId}`), kind: "mcp_oauth" },
            select: { secret: true },
          });
          if (!entry) return null;
          return decryptJson<McpOAuthCredential>(entry.secret);
        });
        if (!cred) {
          return htmlError(400, "credential_not_found", origin);
        }

        const merged: McpOAuthCredential = {
          ...cred,
          resource: state.resource,
          issuer: state.issuer,
          tokenEndpoint: state.tokenEndpoint,
          clientId: state.clientId,
          clientSecret: state.clientSecret ?? cred.clientSecret,
          scopes:
            tokens.scopes.length > 0
              ? tokens.scopes
              : state.scopes.length > 0
                ? state.scopes
                : cred.scopes,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? cred.refreshToken,
          expiresAt: Date.now() + tokens.expiresIn * 1000,
        };
        await asSuperAdmin(async (db) => {
          await db.vaultEntry.updateMany({
            where: vaultRefWhere(`vault:${entryId}`),
            data: { secret: encryptJson(merged) },
          });
        });

        return htmlSuccess(origin);
      } catch (err) {
        logger.warn({ err }, "mcp oauth callback failed");
        return htmlError(400, "callback_failed", origin);
      }
    },
    {
      detail: {
        ...doc(
          "MCP OAuth callback",
          "Public popup redirect target for the MCP consent flow; cookie-authenticated in-handler and bound by the signed state, it always returns HTML so the popup can postMessage the result to its opener and self-close.",
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
            description: "OAuth authorization code to exchange for tokens.",
          }),
        ),
        state: t.Optional(
          t.String({
            description:
              "Opaque encrypted state binding the flow to the issuing user, tenant, vault entry and discovered server.",
          }),
        ),
        iss: t.Optional(
          t.String({
            description: "RFC 9207 issuer identifier echoed by the provider.",
          }),
        ),
        error: t.Optional(
          t.String({
            description:
              "OAuth error code returned by the provider on failure.",
          }),
        ),
      }),
    },
  );
