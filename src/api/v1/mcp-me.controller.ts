import { Elysia, t } from "elysia";
import type { UserRole } from "@/../generated/prisma/client";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { ForbiddenError } from "@/lib/errors";
import { roleAtLeast, type TenantContext } from "@/lib/tenancy";
import {
  disconnectClient,
  listMyConnections,
} from "@/modules/mcp/oauth/connections";
import { mcpResourceId } from "@/modules/mcp/oauth/metadata";
import { MCP_SCOPES, type McpScope } from "@/modules/mcp/oauth/tokens";

// Self-service MCP surface for the LOGGED-IN user (any role): list the apps they connected via OAuth,
// disconnect one (forget the approval + revoke its live tokens), and read the connection info (server
// URL, the scopes their role can hold, whether DCR self-registration is open). Everything is fenced to
// tenantContext.userId; admin-wide management is the SUPER_ADMIN-only /v1/mcp/admin surface. Handlers
// THROW (never set.status+return) so the Eden client's data type stays clean (see docs/eden-treaty.md).

function userOrThrow(
  ctx: TenantContext | null,
): TenantContext & { userId: bigint } {
  if (!ctx?.userId) throw new ForbiddenError();
  return ctx as TenantContext & { userId: bigint };
}

// The MCP scopes a given role can be granted (mirrors filterScopes in mcp-oauth.controller and
// scopesForRole in tokens.ts). Kept as a small local copy so this read-only controller stays
// decoupled from the API-key token module.
function scopesForRole(role: UserRole): McpScope[] {
  const out: McpScope[] = ["mcp:read"];
  if (roleAtLeast(role, "TENANT_ADMIN")) out.push("mcp:write");
  if (role === "SUPER_ADMIN") out.push("mcp:admin");
  return out.filter((s): s is McpScope =>
    (MCP_SCOPES as readonly string[]).includes(s),
  );
}

export const mcpMeController = new Elysia({
  prefix: "/v1/mcp/me",
  tags: ["MCP"],
})
  .use(tenancyPlugin)
  .get(
    "/connections",
    async ({ tenantContext }) => {
      const ctx = userOrThrow(tenantContext);
      return { connections: await listMyConnections(ctx.userId) };
    },
    {
      requireAuth: true,
      detail: doc(
        "List my MCP connections",
        "Returns the apps the logged-in user has connected via OAuth (client name, granted scopes, trust/provenance flags, live-token count), newest first. Strictly scoped to the caller.",
      ),
      response: errors(401, 403),
    },
  )
  .delete(
    "/connections/:clientId",
    async ({ tenantContext, params }) => {
      const ctx = userOrThrow(tenantContext);
      const result = await disconnectClient(ctx, params.clientId);
      return { success: true, ...result };
    },
    {
      requireAuth: true,
      detail: doc(
        "Disconnect an MCP app",
        "Disconnects an app for the logged-in user: forgets the remembered approval and revokes the user's live access + refresh tokens for that client (existing sessions die immediately). Idempotent and scoped to the caller; another user's connection is unaffected.",
      ),
      params: t.Object({
        clientId: t.String({
          minLength: 1,
          description: "The OAuth client id to disconnect.",
        }),
      }),
      response: errors(401, 403),
    },
  )
  .get(
    "/info",
    async ({ tenantContext }) => {
      const ctx = userOrThrow(tenantContext);
      return {
        url: mcpResourceId(),
        scopes: scopesForRole(ctx.role),
        dcrEnabled: config.mcpDcrEnabled,
      };
    },
    {
      requireAuth: true,
      detail: doc(
        "MCP connection info",
        "Returns how to connect this account to an MCP client: the server URL, the scopes the caller's role can be granted, and whether dynamic client registration (self-registration) is open.",
      ),
      response: errors(401, 403),
    },
  );
