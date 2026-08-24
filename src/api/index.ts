import { openapi } from "@elysiajs/openapi";
import Elysia from "elysia";
import { adminController } from "@/api/features/admin/admin.controller";
import { authController } from "@/api/features/auth/auth.controller";
import { brandingController } from "@/api/features/branding/branding.controller";
import { healthController } from "@/api/features/health/health.controller";
import { i18nController } from "@/api/features/i18n/i18n.controller";
import { realtimeController } from "@/api/features/realtime/realtime.controller";
import { updatesController } from "@/api/features/updates/updates.controller";
import { agentsController } from "@/api/v1/agents.controller";
import { alertChannelsController } from "@/api/v1/alert-channels.controller";
import { apiKeysController } from "@/api/v1/api-keys.controller";
import { auditController } from "@/api/v1/audit.controller";
import { businessHoursController } from "@/api/v1/business-hours.controller";
import { chatwootController } from "@/api/v1/chatwoot.controller";
import { chatwootAdminController } from "@/api/v1/chatwoot-admin.controller";
import { documentTemplatesController } from "@/api/v1/document-templates.controller";
import { documentsController } from "@/api/v1/documents.controller";
import { experimentsController } from "@/api/v1/experiments.controller";
import { integrationsController } from "@/api/v1/integrations.controller";
import { integrationsAdminController } from "@/api/v1/integrations-admin.controller";
import { knowledgeController } from "@/api/v1/knowledge.controller";
import { logsController } from "@/api/v1/logs.controller";
import { mcpController } from "@/api/v1/mcp.controller";
import { mcpAdminController } from "@/api/v1/mcp-admin.controller";
import { mcpConnectionsController } from "@/api/v1/mcp-connections.controller";
import { mcpMeController } from "@/api/v1/mcp-me.controller";
import { mcpOAuthController } from "@/api/v1/mcp-oauth.controller";
import { n8nExportController } from "@/api/v1/n8n-export.controller";
import {
  oauthGoogleCallbackController,
  oauthGoogleVaultController,
} from "@/api/v1/oauth-google.controller";
import {
  oauthMcpCallbackController,
  oauthMcpVaultController,
} from "@/api/v1/oauth-mcp.controller";
import { tenantSettingsController } from "@/api/v1/tenant-settings.controller";
import { toolsController } from "@/api/v1/tools.controller";
import { v1Controller } from "@/api/v1/v1.controller";
import { vaultController } from "@/api/v1/vault.controller";
import { webhooksController } from "@/api/v1/webhooks.controller";
import config from "@/config";

// DEV docs (Scalar): the x-tenant-id header is the SUPER_ADMIN tenant selector, read only on
// tenant-scoped requests (tenancyPlugin) and ignored for non-super-admin principals (who are pinned
// to their own tenant). It lives in no route schema, so it would never show in "Try it". We inject it
// into every authenticated operation of the generated spec, prefilled with "1", purely as a docs
// convenience. The default is not a grant — auth still decides whether the header is honored.
//
// `required: true` is DISPLAY-ONLY: Scalar pre-enables (checks) required params and skips optional
// ones, so this is the only lever to have x-tenant-id sent by default. It is injected only into the
// dev spec, never into a route's runtime validation schema, so it imposes no real requirement.
const TENANT_HEADER_PARAM = {
  name: "x-tenant-id",
  in: "header",
  required: true,
  description:
    "SUPER_ADMIN tenant selector (tenant id as a string). Picks the target tenant for this request; ignored for non-super-admin principals, who are pinned to their own tenant. Not truly required — prefilled and marked required here only so Scalar sends it by default.",
  schema: { type: "string", default: "1" },
  example: "1",
} as const;

const OPENAPI_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);

type SpecOperation = {
  security?: unknown[];
  parameters?: Array<{ name?: string; in?: string }>;
};

// Add TENANT_HEADER_PARAM to every authenticated operation of a generated OpenAPI document. Public
// operations opt out of auth with `security: []` (the global default is the bearer/cookie pair), so
// they are skipped. Idempotent: the openapi plugin caches the document by reference, so later
// requests re-run this over an already-injected object; the name+in check makes those a no-op.
function injectTenantHeaderParam(spec: unknown): void {
  const paths = (
    spec as { paths?: Record<string, Record<string, SpecOperation>> } | null
  )?.paths;
  if (!paths) return;
  for (const item of Object.values(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!OPENAPI_METHODS.has(method) || !op || typeof op !== "object") {
        continue;
      }
      if (Array.isArray(op.security) && op.security.length === 0) continue;
      op.parameters ??= [];
      const already = op.parameters.some(
        (p) => p?.name === "x-tenant-id" && p?.in === "header",
      );
      if (!already) op.parameters.push({ ...TENANT_HEADER_PARAM });
    }
  }
}

const api = new Elysia()
  // DEV-only: post-process the OpenAPI document served at /docs/json to prefill x-tenant-id (see
  // injectTenantHeaderParam). Registered before the openapi plugin so this global hook also wraps the
  // plugin's own spec route; a no-op outside dev or off the spec path.
  .onAfterHandle({ as: "global" }, ({ path, response }) => {
    if (config.env === "production" || !path.endsWith("/docs/json")) return;
    injectTenantHeaderParam(response);
  })
  // API docs (Scalar) — DEV ONLY (enabled:false in prod skips the routes + spec entirely). Mounted
  // on the API instance so the OpenAPI spec is generated ONLY from the API route schemas (enums,
  // descriptions, tags), never the SPA/static/catch-all routes. Served at /api/docs (+ /api/docs/json).
  .use(
    openapi({
      enabled: config.env !== "production",
      path: "/docs",
      // Scalar "Send" prefills the bearer scheme (the primary programmatic auth) instead of the
      // session cookie, which the browser already holds and which can't be pasted anyway.
      scalar: {
        authentication: { preferredSecurityScheme: "bearerToken" },
      },
      documentation: {
        info: {
          title: `${config.packageInfo.name} API`,
          version: config.packageInfo.version,
          description:
            "REST surface for the fazer.ai agents operator console. Dev-only documentation, auto-generated from the route schemas.",
        },
        // The whole API instance is mounted under /api (app.ts `.group("/api", …)`), so every path
        // in this spec is relative to /api. Without this `servers` entry Scalar would send "Try it"
        // requests to the origin root (e.g. /v1/agents), which falls through to the SPA catch-all and
        // returns index.html (text/html) instead of the API. publicUrl is the canonical app URL.
        servers: [
          { url: `${config.publicUrl}/api`, description: "This server" },
        ],
        // Auth schemes. Most endpoints accept EITHER the session cookie (browser console) OR a bearer
        // token (API/MCP). The global `security` lists both as alternatives; public endpoints
        // (`/auth/*`, `/health`, `/i18n/locales`, the inbound receptors) override with `security: []`.
        components: {
          securitySchemes: {
            sessionCookie: {
              type: "apiKey",
              in: "cookie",
              name: "fazerai_auth_token",
              description:
                "Session JWT set by /api/auth/login (HttpOnly cookie).",
            },
            bearerToken: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
              description:
                "Bearer token for the API / MCP transport: an MCP OAuth access token, or a per-tenant API key (`fazerai_…`) created at /api-keys.",
            },
          },
        },
        security: [{ bearerToken: [] }, { sessionCookie: [] }],
        // NOTE: every controller assigns a matching instance-level `tags` (or per-route
        // `detail.tags` for the mixed v1 controller). Keep this list in sync — a tag declared
        // here with no operations shows as an empty group; an operation with no tag shows loose.
        tags: [
          {
            name: "Auth",
            description: "Authentication, account linking & first-run setup.",
          },
          { name: "Tenants", description: "Tenant provisioning & metadata." },
          {
            name: "Conversations",
            description: "Live conversations: read, reply, handoff, status.",
          },
          {
            name: "Dashboard",
            description: "KPIs, time series & cost metrics.",
          },
          { name: "Agents", description: "Agent config, tools, playground." },
          {
            name: "Resources",
            description:
              "Tools, knowledge bases, document templates, schedules, vault credentials, experiments.",
          },
          {
            name: "Channels",
            description: "Chatwoot instances, inboxes & the webhook receiver.",
          },
          {
            name: "Integrations",
            description: "Integration catalog, inbound receptor & n8n export.",
          },
          {
            name: "MCP",
            description: "MCP server, client connections & OAuth 2.1.",
          },
          {
            name: "Webhooks",
            description: "Outbound webhook subscriptions & event catalog.",
          },
          {
            name: "API keys",
            description:
              "Per-tenant Bearer API keys for the REST v1 API & MCP transport.",
          },
          { name: "Audit", description: "Audit log." },
          {
            name: "Logs",
            description: "Execution-flow logs & external alert channels.",
          },
          { name: "Admin", description: "User & tenant administration." },
          {
            name: "Settings",
            description: "Tenant settings, branding & Google OAuth.",
          },
          { name: "System", description: "Health, i18n & realtime." },
        ],
      },
    }),
  )
  .use(authController)
  .use(healthController)
  .use(i18nController)
  .use(updatesController)
  .use(adminController)
  .use(realtimeController)
  .use(brandingController)
  .use(v1Controller)
  .use(agentsController)
  .use(toolsController)
  .use(mcpConnectionsController)
  .use(businessHoursController)
  .use(experimentsController)
  .use(vaultController)
  .use(oauthGoogleVaultController)
  .use(oauthGoogleCallbackController)
  .use(oauthMcpVaultController)
  .use(oauthMcpCallbackController)
  .use(tenantSettingsController)
  .use(webhooksController)
  .use(apiKeysController)
  .use(auditController)
  .use(logsController)
  .use(alertChannelsController)
  .use(integrationsController)
  .use(integrationsAdminController)
  .use(knowledgeController)
  .use(n8nExportController)
  .use(documentTemplatesController)
  .use(documentsController)
  .use(mcpOAuthController)
  .use(mcpController)
  .use(mcpMeController)
  .use(mcpAdminController)
  .use(chatwootController)
  .use(chatwootAdminController);

export default api;
