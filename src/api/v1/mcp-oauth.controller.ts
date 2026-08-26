import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import type { UserRole } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { doc, errors, OAuthErrorResponse } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { NotFoundError, UnauthorizedError } from "@/lib/errors";
import {
  asSuperAdmin,
  roleAtLeast,
  runScoped,
  type TenantContext,
} from "@/lib/tenancy";
import { recordAudit } from "@/modules/audit/service";
import {
  consumePendingAuthorization,
  createPendingAuthorization,
  findApproval,
  getPendingAuthorization,
  isApprovalSufficient,
  issueConsentCsrf,
  upsertApproval,
} from "@/modules/mcp/oauth/consent";
import { validateRedirectUris } from "@/modules/mcp/oauth/dcr";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  type TokenResponse,
} from "@/modules/mcp/oauth/grant";
import { issuerUrl, mcpResourceId } from "@/modules/mcp/oauth/metadata";
import { MCP_SCOPES, type McpScope } from "@/modules/mcp/oauth/tokens";

// MCP OAuth 2.1 grant endpoints. /authorize is behind the APP session (the user is already logged
// in) and issues a code only for scopes the principal may hold + a redirect_uri in the client's
// EXACT allowlist (no open redirect). /token (public; PKCE is the public-client proof) exchanges a
// code or rotates a refresh token. Clients are pre-registered (DCR is off by default).

// A requested scope is granted only if the principal's role is high enough.
function filterScopes(requested: string[], role: UserRole): McpScope[] {
  const out: McpScope[] = [];
  for (const s of requested) {
    if (!(MCP_SCOPES as readonly string[]).includes(s)) continue;
    if (s === "mcp:admin" && role !== "SUPER_ADMIN") continue;
    if (s === "mcp:write" && !roleAtLeast(role, "TENANT_ADMIN")) continue;
    out.push(s as McpScope);
  }
  return out;
}

// RFC 8707 §2.2: if the client sends a `resource` indicator, it must designate our canonical MCP
// resource id (trailing-slash insensitive). Absent → tolerated and assumed canonical (older clients);
// a mismatch is rejected with invalid_target. The token's `aud` is bound to the canonical id either way.
function resourceOk(resource: string | undefined): boolean {
  if (!resource) return true;
  const norm = (s: string) => s.replace(/\/$/, "");
  return norm(resource) === norm(mcpResourceId());
}

function toTokenBody(r: TokenResponse) {
  return {
    access_token: r.accessToken,
    token_type: r.tokenType,
    expires_in: r.expiresIn,
    refresh_token: r.refreshToken,
    scope: r.scopes.join(" "),
  };
}

// Builds an authorization-response redirect back to the client. RFC 9207: `iss` is always added so
// the client can verify which authorization server answered (mix-up defense).
function authorizeRedirect(
  redirectUri: string,
  params: { code?: string; error?: string; state?: string | null },
): string {
  const url = new URL(redirectUri);
  if (params.code) url.searchParams.set("code", params.code);
  if (params.error) url.searchParams.set("error", params.error);
  if (params.state) url.searchParams.set("state", params.state);
  url.searchParams.set("iss", issuerUrl());
  return url.toString();
}

// Best-effort audit of a consent decision; a failure here never blocks the user flow. SUPER_ADMIN
// writes via the audited fleet path (any tenantId, incl. null); a tenant user writes scoped to their
// tenant (the pending's tenantId always equals their own).
async function auditConsentDecision(
  user: { id: bigint; role: UserRole },
  tenantId: bigint | null,
  action: string,
  clientId: string,
  scopes: string[],
): Promise<void> {
  const entry = {
    actorId: user.id,
    actorType: "user" as const,
    action,
    target: `client:${clientId}`,
    after: { scopes },
  };
  try {
    if (user.role === "SUPER_ADMIN") {
      await asSuperAdmin((db) => recordAudit(db, tenantId, entry));
    } else if (tenantId !== null) {
      await runScoped({ tenantId, userId: user.id, role: user.role }, (db) =>
        recordAudit(db, tenantId, entry),
      );
    }
  } catch (err) {
    logger.warn({ err }, "MCP consent audit failed");
  }
}

export const mcpOAuthController = new Elysia({
  prefix: "/v1/mcp/oauth",
  tags: ["MCP"],
})
  .use(tenancyPlugin)
  // NOTE: RFC 7591 Dynamic Client Registration. OPEN by default (every supported MCP client self-registers
  // and none has a fallback); MCP_DCR_ENABLED=false closes it and the route then returns 404 (no
  // signal that it exists). It registers a PUBLIC PKCE client (token_endpoint_auth_method "none");
  // redirect_uris pass the strict allowlist; requested scopes are intersected with MCP_SCOPES (the
  // effective grant is still role-gated at /authorize).
  .post(
    "/register",
    async ({ body, set }) => {
      if (!config.mcpDcrEnabled) {
        set.status = 404;
        return { error: "not_found" };
      }
      const reason = validateRedirectUris(body.redirect_uris);
      if (reason) {
        set.status = 400;
        return { error: "invalid_redirect_uri", error_description: reason };
      }
      const requested = (body.scope ?? "")
        .split(/\s+/)
        .filter((s): s is McpScope =>
          (MCP_SCOPES as readonly string[]).includes(s),
        );
      const scopes: McpScope[] = requested.length ? requested : ["mcp:read"];
      const clientId = randomBytes(16).toString("hex");
      await basePrisma.mcpOAuthClient.create({
        data: {
          clientId,
          name: body.client_name ?? "Dynamically Registered Client",
          redirectUris: body.redirect_uris,
          grantTypes: ["authorization_code", "refresh_token"],
          scopes,
          // Provenance, not trust: a self-registered client is shown as "unverified" on the consent
          // screen and never skips it (firstParty stays false until an admin explicitly promotes it).
          dynamicallyRegistered: true,
        },
      });
      set.status = 201;
      return {
        client_id: clientId,
        redirect_uris: body.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: scopes.join(" "),
      };
    },
    {
      detail: {
        ...doc(
          "Register an MCP OAuth client",
          "RFC 7591 Dynamic Client Registration for a public PKCE client. Enabled by default: registers the redirect URIs (strict allowlist) and intersects scopes with the supported set. With MCP_DCR_ENABLED=false it returns 404, with no signal the route exists.",
        ),
        security: [],
      },
      response: {
        400: OAuthErrorResponse,
        404: OAuthErrorResponse,
        ...errors(422),
      },
      body: t.Object({
        redirect_uris: t.Array(
          t.String({ minLength: 1, description: "An allowed redirect URI." }),
          {
            minItems: 1,
            description:
              "Exact redirect URIs the client may use (no wildcards).",
          },
        ),
        client_name: t.Optional(
          t.String({ description: "Human-readable client name." }),
        ),
        scope: t.Optional(
          t.String({
            description:
              'Space-separated requested scopes (e.g. "mcp:read mcp:write"); intersected with the supported set.',
          }),
        ),
        grant_types: t.Optional(
          t.Array(t.String(), {
            description:
              "Ignored; the server always grants authorization_code + refresh_token.",
          }),
        ),
        response_types: t.Optional(
          t.Array(t.String(), { description: 'Ignored; always ["code"].' }),
        ),
        token_endpoint_auth_method: t.Optional(
          t.String({ description: 'Ignored; public clients use "none".' }),
        ),
      }),
    },
  )
  .get(
    "/authorize",
    async ({ tenantContext, query, set, request }) => {
      const ctx: TenantContext | null = tenantContext;
      // NOTE: this endpoint is reached by a BROWSER NAVIGATION (the MCP client opens it), so an
      // anonymous visitor must get the login screen, not the API's 401/403 JSON — which is what the
      // user would otherwise stare at while the MCP client waits forever for a callback. `redirect`
      // is our own path, and LoginPage only honors single-leading-slash local paths.
      // The client/redirect_uri checks stay BELOW this gate on purpose: validating first would let an
      // anonymous caller probe which client_ids and redirect URIs are registered. The cost is that a
      // bogus client_id reaches the login screen before its 400, and the open-redirect guarantee is
      // untouched — the only redirect an anonymous request can get is this local /login one, never
      // the supplied redirect_uri.
      if (!ctx?.userId) {
        const here = new URL(request.url);
        return new Response(null, {
          status: 302,
          headers: {
            location: `/login?redirect=${encodeURIComponent(`${here.pathname}${here.search}`)}`,
          },
        });
      }

      const client = await basePrisma.mcpOAuthClient.findUnique({
        where: { clientId: query.client_id },
      });
      // Invalid client / unregistered redirect_uri → DO NOT redirect (anti open-redirect); 400.
      if (!client?.redirectUris.includes(query.redirect_uri)) {
        set.status = 400;
        return { error: "invalid_client" };
      }
      if (query.response_type !== "code") {
        set.status = 400;
        return { error: "unsupported_response_type" };
      }
      if (query.code_challenge_method !== "S256" || !query.code_challenge) {
        set.status = 400;
        return { error: "invalid_request" };
      }
      // RFC 8707: a divergent resource indicator is a protocol error → 400, never a redirect.
      if (!resourceOk(query.resource)) {
        set.status = 400;
        return { error: "invalid_target" };
      }

      const requested = (query.scope ?? "").split(/\s+/).filter(Boolean);
      const granted = filterScopes(requested, ctx.role);

      // Decide whether the consent screen can be skipped: a first-party (trusted) client, or a
      // remembered approval that already covers every scope we would grant (escalation re-prompts).
      let skipConsent = client.firstParty;
      if (!skipConsent) {
        const approval = await findApproval(ctx.userId, query.client_id);
        skipConsent =
          !!approval && isApprovalSufficient(approval.scopes, granted);
      }

      if (skipConsent) {
        const code = await createAuthorizationCode({
          clientId: query.client_id,
          userId: ctx.userId,
          // A SUPER_ADMIN token is fleet-level (tenant-agnostic): it picks the target tenant per MCP
          // call, so it is minted tenant-LESS regardless of which tenant the browser session was on
          // (the /authorize nav carries no x-tenant-id anyway). Tenant users stay bound to their tenant.
          tenantId: ctx.role === "SUPER_ADMIN" ? null : ctx.tenantId,
          redirectUri: query.redirect_uri,
          scopes: granted,
          codeChallenge: query.code_challenge,
          codeChallengeMethod: "S256",
          resource: query.resource ?? null,
        });
        return new Response(null, {
          status: 302,
          headers: {
            location: authorizeRedirect(query.redirect_uri, {
              code,
              state: query.state ?? null,
            }),
          },
        });
      }

      // Otherwise park a pending authorization and hand the user to the SPA consent screen. The code
      // is minted later, FROM THIS stored record, only on explicit approval (see POST /consent).
      const { requestId } = await createPendingAuthorization({
        clientId: query.client_id,
        userId: ctx.userId,
        // Tenant-less for a fleet-level SUPER_ADMIN (per-call tenant targeting); see the skip-consent
        // branch above. The consent screen shows no tenant for such a token (tenantName stays null).
        tenantId: ctx.role === "SUPER_ADMIN" ? null : ctx.tenantId,
        redirectUri: query.redirect_uri,
        scopes: granted,
        codeChallenge: query.code_challenge,
        codeChallengeMethod: "S256",
        resource: query.resource ?? null,
        state: query.state ?? null,
      });
      return new Response(null, {
        status: 302,
        headers: {
          location: `/oauth/consent?req=${encodeURIComponent(requestId)}`,
        },
      });
    },
    {
      detail: doc(
        "Authorization endpoint",
        "OAuth 2.1 authorization endpoint, behind the app session. An anonymous visitor is 302-redirected to the login screen with this URL as the return destination (it is opened by a browser, so an API 401 would dead-end the flow); the client and redirect_uri are only validated after that, on the authenticated pass, so an anonymous request carrying a bogus client_id also lands on the login screen rather than a 400. Once authenticated, for the scopes the principal may hold and a redirect_uri in the client's exact allowlist, it either redirects to the consent screen (default) or, when the client is first-party or a sufficient prior approval exists, mints a single-use code and 302-redirects back with code + state + iss. An invalid client/redirect is rejected with 400 and is never redirected TO THE SUPPLIED redirect_uri, which is what prevents open redirects — the only pre-authentication redirect is the local /login one.",
      ),
      // NOTE: every success path here is a redirect (login, consent, or the client callback), so the
      // 302 is the operation's real contract and belongs in the spec — `errors()` alone would
      // document only the rejections. Body is empty; the destination travels in `Location`.
      response: {
        302: t.Void({
          description:
            "Redirect to the login screen, the consent screen, or the client's registered callback (with code + state + iss). Destination in the `Location` header.",
        }),
        ...errors(400, 403, 422),
      },
      query: t.Object({
        client_id: t.String({
          minLength: 1,
          description: "The registered OAuth client id.",
        }),
        redirect_uri: t.String({
          minLength: 1,
          description:
            "Must exactly match one of the client's registered redirect URIs.",
        }),
        response_type: t.String({
          description: 'Must be "code" (authorization-code flow).',
        }),
        code_challenge: t.Optional(
          t.String({ description: "PKCE code challenge (required; S256)." }),
        ),
        code_challenge_method: t.Optional(
          t.String({ description: 'PKCE method; must be "S256".' }),
        ),
        scope: t.Optional(
          t.String({
            description:
              "Space-separated requested scopes; granted scopes are role-gated.",
          }),
        ),
        state: t.Optional(
          t.String({
            description:
              "Opaque value echoed back on the redirect (CSRF binding).",
          }),
        ),
        resource: t.Optional(
          t.String({
            description: "RFC 8707 resource indicator the token is bound to.",
          }),
        ),
      }),
    },
  )
  // Consent screen data. The SPA fetches this for a pending authorization (parked by /authorize) and
  // renders the approve/deny card. 404 for an unknown/expired/consumed request or one owned by a
  // different user. Also mints the one-time CSRF token the approve/deny POST must echo back.
  .get(
    "/consent/:req",
    async ({ getAuthUser, params }) => {
      // requireAuth already gated; this is defensive (and narrows the type).
      const user = await getAuthUser();
      if (!user) throw new UnauthorizedError();
      const pending = await getPendingAuthorization(params.req, user.id);
      if (!pending) throw new NotFoundError();
      const csrfToken = await issueConsentCsrf(params.req, user.id);
      if (!csrfToken) throw new NotFoundError();
      const client = await basePrisma.mcpOAuthClient.findUnique({
        where: { clientId: pending.clientId },
        select: { name: true, firstParty: true, dynamicallyRegistered: true },
      });
      let tenantName: string | null = null;
      if (pending.tenantId !== null) {
        try {
          const tenant = await runScoped(
            { tenantId: pending.tenantId, userId: user.id, role: user.role },
            (db) => db.tenant.findFirst({ select: { name: true } }),
          );
          tenantName = tenant?.name ?? null;
        } catch {
          tenantName = null;
        }
      }
      let redirectHost = pending.redirectUri;
      try {
        redirectHost = new URL(pending.redirectUri).host;
      } catch {
        // keep the raw string if it does not parse
      }
      return {
        clientName: client?.name ?? pending.clientId,
        firstParty: client?.firstParty ?? false,
        // "Unverified" ⟺ self-registered AND not promoted to trusted: drives the consent warning.
        unverified:
          (client?.dynamicallyRegistered ?? false) &&
          !(client?.firstParty ?? false),
        redirectUri: pending.redirectUri,
        redirectHost,
        scopes: pending.scopes,
        tenantName,
        accountEmail: user.email,
        csrfToken,
      };
    },
    {
      detail: doc(
        "Consent screen data",
        "Returns the details of a pending authorization (client, redirect destination, scopes, tenant, account) for the SPA consent screen, plus a one-time CSRF token. 404 if the request is unknown, expired, already consumed, or owned by a different user.",
      ),
      requireAuth: true,
      response: errors(401, 404),
      params: t.Object({
        req: t.String({
          minLength: 1,
          description: "The opaque pending-authorization id from /authorize.",
        }),
      }),
    },
  )
  // Records the user's consent decision. Verifies the CSRF token and single-use-consumes the pending
  // record; on approve, mints the authorization code FROM THE STORED RECORD (never from this body)
  // and remembers the approval. Returns the redirect URL for the SPA to navigate to.
  .post(
    "/consent/:req",
    async ({ getAuthUser, params, body }) => {
      const user = await getAuthUser();
      if (!user) throw new UnauthorizedError();
      const pending = await consumePendingAuthorization(
        params.req,
        user.id,
        body.csrfToken,
      );
      if (!pending) throw new NotFoundError();

      if (body.decision === "deny") {
        await auditConsentDecision(
          user,
          pending.tenantId,
          "mcp_oauth_consent_denied",
          pending.clientId,
          pending.scopes,
        );
        return {
          redirect: authorizeRedirect(pending.redirectUri, {
            error: "access_denied",
            state: pending.state,
          }),
        };
      }

      const code = await createAuthorizationCode({
        clientId: pending.clientId,
        userId: pending.userId,
        tenantId: pending.tenantId,
        redirectUri: pending.redirectUri,
        scopes: pending.scopes,
        codeChallenge: pending.codeChallenge,
        codeChallengeMethod: pending.codeChallengeMethod,
        resource: pending.resource,
      });
      await upsertApproval(pending.userId, pending.clientId, pending.scopes);
      await auditConsentDecision(
        user,
        pending.tenantId,
        "mcp_oauth_consent_granted",
        pending.clientId,
        pending.scopes,
      );
      return {
        redirect: authorizeRedirect(pending.redirectUri, {
          code,
          state: pending.state,
        }),
      };
    },
    {
      detail: doc(
        "Record a consent decision",
        "Approves or denies a pending authorization. Verifies the CSRF token and single-use-consumes the request; on approve, mints the authorization code from the stored record and remembers the approval (revocable). Returns { redirect } for the SPA to navigate to.",
      ),
      requireAuth: true,
      response: errors(400, 401, 404, 422),
      params: t.Object({
        req: t.String({
          minLength: 1,
          description: "The opaque pending-authorization id from /authorize.",
        }),
      }),
      body: t.Object({
        decision: t.Union([t.Literal("approve"), t.Literal("deny")], {
          description: "Whether to approve or deny the authorization.",
        }),
        csrfToken: t.String({
          minLength: 1,
          description: "The CSRF token returned by GET /consent/:req.",
        }),
      }),
    },
  )
  .post(
    "/token",
    async ({ body, set }) => {
      // RFC 8707: reject a resource indicator that is not our canonical MCP resource id.
      if (!resourceOk(body.resource)) {
        set.status = 400;
        return { error: "invalid_target" };
      }
      if (body.grant_type === "authorization_code") {
        if (!body.code || !body.redirect_uri || !body.code_verifier) {
          set.status = 400;
          return { error: "invalid_request" };
        }
        const r = await exchangeAuthorizationCode({
          code: body.code,
          clientId: body.client_id,
          redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier,
          resource: body.resource ?? null,
        });
        return toTokenBody(r);
      }
      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token) {
          set.status = 400;
          return { error: "invalid_request" };
        }
        const r = await refreshAccessToken({
          refreshToken: body.refresh_token,
          clientId: body.client_id,
        });
        return toTokenBody(r);
      }
      set.status = 400;
      return { error: "unsupported_grant_type" };
    },
    {
      detail: {
        ...doc(
          "Token endpoint",
          "OAuth 2.1 token endpoint (public; PKCE is the public-client proof). Exchanges an authorization code or rotates a refresh token (refresh rotation with family-wide reuse detection).",
        ),
        security: [],
      },
      response: { 400: OAuthErrorResponse, ...errors(422) },
      body: t.Object({
        grant_type: t.String({
          description: 'Either "authorization_code" or "refresh_token".',
        }),
        client_id: t.String({
          minLength: 1,
          description: "The registered OAuth client id.",
        }),
        code: t.Optional(
          t.String({
            description: "Authorization code (authorization_code grant).",
          }),
        ),
        redirect_uri: t.Optional(
          t.String({
            description:
              "Must match the one used at /authorize (authorization_code grant).",
          }),
        ),
        code_verifier: t.Optional(
          t.String({
            description:
              "PKCE verifier for the code_challenge (authorization_code grant).",
          }),
        ),
        refresh_token: t.Optional(
          t.String({
            description: "The refresh token to rotate (refresh_token grant).",
          }),
        ),
        resource: t.Optional(
          t.String({
            description: "RFC 8707 resource indicator the token is bound to.",
          }),
        ),
      }),
    },
  );
