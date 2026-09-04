import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  type CodeToolCreate,
  type CodeToolUpdate,
  codeToolReferences,
  createCodeTool,
  deleteCodeTool,
  getCodeTool,
  listCodeTools,
  updateCodeTool,
} from "@/modules/code-tools/service";
import {
  type CodeToolTestInput,
  runCodeToolTest,
} from "@/modules/code-tools/test-run";

// The error catalog this controller's routes answer with (tools.controller.ts explains the
// mechanism). The reserved-name refusal is the HTTP tool's own key: one namespace, one sentence.
// translate('errors.codeToolNotFound', 'Code tool not found.')
// translate('errors.codeToolNameTaken', 'That tool name is already in use by another tool.')

// Operator-authored code tools (per-tenant): a JavaScript function body the agent calls with typed
// arguments, run in the sandbox (issue #363). TENANT_ADMIN; the scoped service is the hard
// boundary. A body that does not parse is SAVED and answered with `warnings`; it fails at call
// time as the operator's failure.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// Exported for the schema-drift guard in tests: every field the service create/update schema accepts
// must appear here, or Elysia's normalize silently strips it from the request body.
export const writeBody = t.Object({
  name: t.Optional(
    t.String({
      description:
        "Identifier the agent calls; the console derives it from the label. Shares one namespace with HTTP tools and the built-in tools.",
    }),
  ),
  label: t.Optional(
    t.String({
      description:
        "Human-friendly display name; the identifier (name) is derived from it.",
    }),
  ),
  description: t.Optional(
    t.String({
      description:
        "What the tool answers and when to call it, read by the agent to decide. Required on create.",
    }),
  ),
  // `t.Unknown`, not `t.Record`: the record schema REBUILDS the map, and a field named `__proto__`
  // becomes the object's prototype on the way in — the service's refusal (code-tools/service.ts)
  // would then judge a schema the caller never sent, and the tool would save with the declared
  // argument missing. Measured: `t.Record` answers own keys `["cpf"]` for a body that also sent
  // `__proto__`; `t.Unknown` keeps both. The shape is still described here and validated by the
  // service's own zod.
  inputSchema: t.Optional(
    t.Unknown({
      description:
        'The arguments the agent supplies, as the compact map an HTTP tool uses: {"field": {"type": "string"|"integer"|"number"|"boolean"|"enum"|"array"|"object", "required"?, "description"?, "enumValues"?, "itemType"?}}. Standard JSON Schema ({"properties", "required"}) is accepted and converted to this shape on write. The body receives them as `input`.',
    }),
  ),
  code: t.Optional(
    t.String({
      description:
        "The body of `function (input, context) { … }`, plain JavaScript (ES2023): `input` holds the arguments, `context` the conversation variables (conversation_id, message_id, contact_id, contact_name, contact_email, contact_phone, inbox_id, inbox_name, company_name, agent_name, conversationAttributes, contactAttributes), and the result is what the body `return`s (rendered as JSON for the agent; console.log output is returned with it). Available inside: TIMEZONE, NOW_LOCAL, and Date in the agent's zone. No network, no imports, no async. Limits: 1000 ms of CPU, 32 MB. A `throw` or a limit is an integration failure (alerted); a business outcome is a returned value. Code that does not parse is saved and reported in `warnings`; it fails at call time.",
    }),
  ),
  enabled: t.Optional(
    t.Boolean({ description: "Whether the tool is available to agents." }),
  ),
});

const CREATE_REQUIRED = ["name", "label", "description", "code"] as const;
const createBody = t.Composite([
  t.Omit(writeBody, CREATE_REQUIRED),
  t.Required(t.Pick(writeBody, CREATE_REQUIRED)),
]);

const warningsResponse =
  "Static syntax warnings for the saved body (a syntax error with its line and column, or a body with no `return`). Advisory: the tool is saved either way and fails at call time if the body does not parse.";

export const codeToolsController = new Elysia({
  prefix: "/v1/code-tools",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      tools: await listCodeTools(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List code tools",
        "List all operator-authored code tools for the current tenant.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      tool: await getCodeTool(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc("Get code tool", "Fetch a single code tool by id."),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Code tool id (BigInt as a string)." }),
      }),
    },
  )
  .get(
    "/:id/references",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      references: await codeToolReferences(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List code tool references",
        "Returns which agents have granted this code tool, so the UI can warn before deletion.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Code tool id (BigInt as a string)." }),
      }),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => {
      const { tool, warnings } = await createCodeTool(
        ctxOrThrow(tenantContext),
        body as CodeToolCreate,
      );
      return { instance: instanceIdentity, tool, warnings };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create code tool",
        `Create an operator-authored code tool for the current tenant. The response carries \`warnings\`: ${warningsResponse}`,
      ),
      response: errors(400, 401, 403, 404, 409, 422),
      body: createBody,
    },
  )
  // Run the body on screen, unsaved, with typed arguments — the operator's "test step" — through
  // the same code path a turn uses (modules/code-tools/test-run.ts).
  .post(
    "/test",
    async ({ body }) => ({
      instance: instanceIdentity,
      result: await runCodeToolTest(body as unknown as CodeToolTestInput),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Test a code tool",
        "Runs the supplied (unsaved) body once in the sandbox with the given arguments and returns the exact text the agent would receive, whether it failed, the raw outcome (value, error, limit) and the static syntax warnings. Adds no capability over saving the tool and calling it: the same sandbox, limits and clock apply.",
      ),
      response: errors(400, 401, 403, 404, 422),
      body: t.Object({
        definition: t.Object({
          name: t.Optional(t.String()),
          // `t.Unknown` for the reason writeBody gives: the record schema rebuilds the map and a
          // `__proto__` field would be gone before the run can refuse it.
          inputSchema: t.Optional(t.Unknown()),
          code: t.String({
            description: "The body of `function (input, context) { … }`.",
          }),
        }),
        args: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              "Values for the declared fields, as the agent would have supplied them; validated by the same schema.",
          }),
        ),
        context: t.Optional(
          t.Record(t.String(), t.String(), {
            description:
              "Values for the conversation/contact variables. Names outside the runtime's own list are ignored; the attribute bags are empty in a test.",
          }),
        ),
        timezone: t.Optional(
          t.String({
            description:
              "IANA zone for Date, TIMEZONE and NOW_LOCAL inside the body; an unknown one falls back to UTC.",
          }),
        ),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ tenantContext, params, body }) => {
      const { tool, warnings } = await updateCodeTool(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as CodeToolUpdate,
      );
      return { instance: instanceIdentity, tool, warnings };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update code tool",
        `Update fields of a code tool. When \`code\` is in the patch the response carries \`warnings\`: ${warningsResponse}`,
      ),
      response: errors(400, 401, 403, 404, 409, 422),
      params: t.Object({
        id: t.String({ description: "Code tool id (BigInt as a string)." }),
      }),
      body: writeBody,
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await deleteCodeTool(ctxOrThrow(tenantContext), requireDbId(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc("Delete code tool", "Delete a code tool."),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Code tool id (BigInt as a string)." }),
      }),
    },
  );
