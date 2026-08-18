import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  createMcpConnection,
  deleteMcpConnection,
  discoverMcpTools,
  getMcpConnection,
  listMcpConnections,
  type McpConnectionCreate,
  type McpConnectionUpdate,
  mcpReferences,
  updateMcpConnection,
} from "@/modules/mcp-connections/service";

// Consumed MCP server connections (per-tenant). TENANT_ADMIN. Mounted at /v1/mcp-connections, NOT
// /v1/mcp (that prefix is the MCP transport this app EXPOSES). `discover` connects to the server to
// list its tool names for the per-agent allowlist UI.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const idParams = t.Object({
  id: t.String({
    description: "MCP connection id (BigInt serialized as a decimal string).",
  }),
});

const writeBody = t.Object({
  name: t.Optional(
    t.String({ description: "Display name for the MCP server connection." }),
  ),
  transport: t.Optional(
    t.Union(
      [t.Literal("streamableHttp"), t.Literal("sse"), t.Literal("stdio")],
      {
        description:
          "Transport used to reach the MCP server: streamableHttp, sse or stdio.",
      },
    ),
  ),
  url: t.Optional(
    t.Union([t.String(), t.Null()], {
      description:
        "Server URL for the streamableHttp and sse transports; null for stdio.",
    }),
  ),
  command: t.Optional(
    t.Union([t.String(), t.Null()], {
      description: "Launch command for the stdio transport; null otherwise.",
    }),
  ),
  credentialRef: t.Optional(
    t.Union([t.String(), t.Null()], {
      description:
        "Vault reference (`vault:<id>`, from GET /v1/vault) for the credential used to authenticate to the server; never an entry name, null if none.",
    }),
  ),
  enabled: t.Optional(
    t.Boolean({ description: "Whether the connection is active." }),
  ),
});

export const mcpConnectionsController = new Elysia({
  prefix: "/v1/mcp-connections",
  tags: ["MCP"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      connections: await listMcpConnections(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List MCP connections",
        "Returns the tenant's consumed MCP server connections.",
      ),
      response: errors(401, 403),
    },
  )
  .get(
    "/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      connection: await getMcpConnection(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get MCP connection",
        "Returns a single consumed MCP server connection by id.",
      ),
      params: idParams,
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/:id/references",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      references: await mcpReferences(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List MCP connection references",
        "Returns which agents have granted this MCP connection, so the UI can warn before deletion.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      connection: await createMcpConnection(
        ctxOrThrow(tenantContext),
        body as McpConnectionCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create MCP connection",
        "Registers a new consumed MCP server connection for the tenant.",
      ),
      body: writeBody,
      response: errors(400, 401, 403),
    },
  )
  .patch(
    "/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      connection: await updateMcpConnection(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
        body as McpConnectionUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update MCP connection",
        "Updates a consumed MCP server connection of the tenant.",
      ),
      params: idParams,
      body: writeBody,
      response: errors(400, 401, 403, 404),
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await deleteMcpConnection(ctxOrThrow(tenantContext), BigInt(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Delete MCP connection",
        "Removes a consumed MCP server connection from the tenant.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/:id/discover",
    async ({ tenantContext, params }) => {
      const discovered = await discoverMcpTools(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      );
      return {
        instance: instanceIdentity,
        tools: discovered.tools,
        instructions: discovered.instructions,
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Discover MCP tools",
        "Connects to the MCP server behind the connection and lists the tools and instructions it exposes.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404),
    },
  );
