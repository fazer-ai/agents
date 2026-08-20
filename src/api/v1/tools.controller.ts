import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  createToolDefinition,
  deleteToolDefinition,
  getToolDefinition,
  listToolDefinitions,
  type ToolDefinitionCreate,
  type ToolDefinitionUpdate,
  toolReferences,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";

// Custom HTTP tool definitions (per-tenant). TENANT_ADMIN; the scoped service is the hard
// boundary. The deeper field validation lives in the service zod schema; the credential is a vault
// reference (never the secret itself).

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// Exported for the schema-drift guard in tests: every field the service create/update schema accepts
// must appear here, or Elysia's normalize silently strips it from the request body (this is exactly
// how `label` once got dropped, leaving the saved label stuck at the backfilled identifier).
export const writeBody = t.Object({
  name: t.Optional(
    t.String({ description: "Tool name the agent sees when selecting tools." }),
  ),
  label: t.Optional(
    t.String({
      description:
        "Human-friendly display name; the identifier (name) is derived from it.",
    }),
  ),
  description: t.Optional(
    t.Union([t.String(), t.Null()], {
      description: "Tool description shown to the agent, or null to clear it.",
    }),
  ),
  method: t.Optional(
    t.Union(
      [
        t.Literal("GET"),
        t.Literal("POST"),
        t.Literal("PUT"),
        t.Literal("PATCH"),
        t.Literal("DELETE"),
      ],
      { description: "HTTP method used when the tool calls its endpoint." },
    ),
  ),
  urlTemplate: t.Optional(
    t.String({
      description:
        "Request URL template; {{param}}, {{context}} and {{secret}} placeholders are interpolated at call time. Single-brace {param} is accepted and normalized when it matches a declared input field or context variable.",
    }),
  ),
  allowedHosts: t.Optional(
    t.Array(t.String(), {
      description: "Hostnames the tool is permitted to call (SSRF allowlist).",
    }),
  ),
  headers: t.Optional(
    t.Record(t.String(), t.Unknown(), {
      description:
        "Static request headers; values may contain {{secret}} placeholders.",
    }),
  ),
  inputSchema: t.Optional(
    t.Record(t.String(), t.Unknown(), {
      description:
        'Input fields the agent supplies, as a compact map: {"field": {"type": "string"|"integer"|"number"|"boolean"|"enum"|"array"|"object", "required"?, "description"?, "enumValues"?, "itemType"?}}. Standard JSON Schema ({"properties", "required"}) is accepted and converted to this shape on write.',
    }),
  ),
  outputSchema: t.Optional(
    t.Record(t.String(), t.Unknown(), {
      description: "JSON Schema describing the tool response shape.",
    }),
  ),
  query: t.Optional(
    t.Record(t.String(), t.Unknown(), {
      description:
        "Query-string params (any method); values may contain {{param}}/{{context}}/{{secret}} placeholders.",
    }),
  ),
  body: t.Optional(
    t.Record(t.String(), t.Unknown(), {
      description:
        "Request body template; {{param}}, {{context}} and {{secret}} placeholders are interpolated at call time. Single-brace {param} is accepted and normalized when it matches a declared input field or context variable.",
    }),
  ),
  credentialRef: t.Optional(
    t.Union([t.String(), t.Null()], {
      description:
        "Vault reference (`vault:<id>`, from GET /v1/vault) for the credential. Never the secret itself, and never an entry name; null for none.",
    }),
  ),
  enabled: t.Optional(
    t.Boolean({ description: "Whether the tool is available to agents." }),
  ),
  expectedStatuses: t.Optional(
    t.Array(t.Integer(), {
      description:
        "HTTP statuses this tool treats as ordinary results instead of integration failures (e.g. [404] for a lookup where 'not found' is data). The model receives the same 'HTTP <status>' text either way; only the log level and the alert dispatch change. Empty (the default) keeps every non-2xx a failure. 2xx entries and values outside 100-599 are dropped on save.",
    }),
  ),
  ackEnabled: t.Optional(
    t.Boolean({
      description:
        "Whether the tool sends an acknowledgement message before executing.",
    }),
  ),
  ackMessage: t.Optional(
    t.Union([t.String(), t.Null()], {
      description:
        "Acknowledgement message shown before the call, or null for the default.",
    }),
  ),
});

export const toolsController = new Elysia({
  prefix: "/v1/tools",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      tools: await listToolDefinitions(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List tools",
        "List all custom HTTP tool definitions for the current tenant.",
      ),
      response: errors(401, 403),
    },
  )
  .get(
    "/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      tool: await getToolDefinition(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get tool",
        "Fetch a single custom HTTP tool definition by id.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({
          description: "Tool definition id (BigInt as a string).",
        }),
      }),
    },
  )
  .get(
    "/:id/references",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      references: await toolReferences(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List tool references",
        "Returns which agents have granted this tool, so the UI can warn before deletion.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({
          description: "Tool definition id (BigInt as a string).",
        }),
      }),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      tool: await createToolDefinition(
        ctxOrThrow(tenantContext),
        body as ToolDefinitionCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create tool",
        "Create a custom HTTP tool definition for the current tenant.",
      ),
      response: errors(400, 401, 403, 409),
      body: writeBody,
    },
  )
  .patch(
    "/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      tool: await updateToolDefinition(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
        body as ToolDefinitionUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update tool",
        "Update fields of a custom HTTP tool definition.",
      ),
      response: errors(400, 401, 403, 404, 409),
      params: t.Object({
        id: t.String({
          description: "Tool definition id (BigInt as a string).",
        }),
      }),
      body: writeBody,
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await deleteToolDefinition(ctxOrThrow(tenantContext), BigInt(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc("Delete tool", "Delete a custom HTTP tool definition."),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({
          description: "Tool definition id (BigInt as a string).",
        }),
      }),
    },
  );
