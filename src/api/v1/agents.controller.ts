import { Elysia, t } from "elysia";
import { getUserById, verifyPassword } from "@/api/features/auth/auth.service";
import { doc, errors } from "@/api/lib/openapi";
import { parseQueryText } from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { requireDbId } from "@/lib/db-id";
import {
  AppError,
  ForbiddenError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  type AgentCreate,
  type AgentUpdate,
  cloneAgent,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentToolSelections,
  listAgentsPaged,
  replaceAgentToolSelections,
  type ToolGrantInput,
  updateAgent,
} from "@/modules/agents/service";
import { exportAgent, importAgent } from "@/modules/agents/transfer";
import { listOutOfOfficeInboxes } from "@/modules/chatwoot/management";
import {
  GUARDRAIL_HEALTH_WINDOW_HOURS,
  guardrailHealthWindowStart,
  readGuardrailHealth,
} from "@/modules/guardrails/health";
import { listProviderModels } from "@/modules/models/service";
import { getPlaygroundMedia } from "@/modules/playground/media";
import {
  listPlaygroundTools,
  runPlaygroundAudioTurn,
  runPlaygroundExtract,
  runPlaygroundFileTurn,
  runPlaygroundFollowup,
  runPlaygroundTranscribe,
  runPlaygroundTurn,
} from "@/modules/playground/service";
import {
  deletePlaygroundSession,
  getPlaygroundSessionTurns,
  listPlaygroundSessions,
} from "@/modules/playground/sessions";
import { listTtsOptions } from "@/modules/tts/listing";

// translate('errors.agentConfirmMismatch', 'The agent name does not match')
// translate('errors.agentModifiedElsewhere', 'This agent was changed somewhere else. Reload it and try again.')
// translate('errors.agentNotRunnable', 'This agent has no runnable model configured.')
// translate('errors.audioTooLarge', 'Audio file is too large')
// translate('errors.baseUrlRequired', 'A base URL is required for this provider.')
// translate('errors.credentialRequired', 'A credential is required to list provider models.')
// translate('errors.credentialNotUsable', 'This credential did not provide an API key: it may be missing, empty, or of a type this provider cannot use.')
// translate('errors.emptyMessage', 'The message is empty.')
// translate('errors.fileTooLarge', 'File is too large')
// translate('errors.invalidAgentExport', 'This file is not a valid agent export.')
// translate('errors.invalidModelConfig', 'The model configuration must be an object.')
// translate('errors.invalidModelConfigDetail', 'The model configuration is not valid: {{reason}}')
// translate('errors.promptTooLong', 'System prompt is too long: {{len}} characters (limit {{max}}).')
// translate('errors.providerModelsFailed', '{{provider}} refused the list request (status {{status}}).')
// translate('errors.providerListUnexpectedResponse', '{{provider}} answered the list request in an unexpected format.')
// translate('errors.providerListUnreachable', 'Could not reach {{provider}} to list the options')
// translate('errors.sessionNotFound', 'Playground session not found.')
// translate('errors.settingsTextTooLong', 'The text in {{field}} is too long: {{len}} characters (limit {{max}}).')
// translate('errors.debugWindowTooLong', 'The log debug mode can be armed for at most {{hours}}h at a time.')
// translate('errors.invalidToolPrecondition', '`{{tool}}` has an invalid precondition: it must name an attribute scope and key.')
// translate('errors.halfConfiguredFallback', 'The fallback provider is only half configured: {{missing}} is missing.')
// translate('errors.sttCredentialMissing', 'The transcription credential was not found.')
// translate('errors.sttFailed', 'Transcription failed: {{detail}}')
// translate('errors.sttNotConfigured', 'Speech-to-text is not configured for this workspace.')
// translate('errors.toolGrantDuplicate', 'This agent already has a {{source}} tool grant.')
// translate('errors.toolGrantIdInvalid', '{{field}} must be a numeric id.')
// translate('errors.toolGrantIdRequired', '{{field}} is required.')
// translate('errors.toolGrantToolNotInIntegration', 'The tool {{tool}} is not available for the {{integration}} integration.')
// translate('errors.toolGrantUnknownSource', 'Unknown tool source: {{source}}.')
// translate('errors.toolGrantUnknownTool', 'Unknown {{source}} tool: {{tool}}.')
// translate('errors.unknownProvider', 'Unknown {{capability}} provider: {{provider}}.')
// translate('errors.unsupportedAudioType', 'Unsupported audio type')
// translate('errors.visionCredentialMissing', 'Vision credential not found')
// translate('errors.visionFailed', 'Image/document extraction failed')
// translate('errors.visionNotConfigured', 'Image/document reading is not configured')

// Agent config REST surface (one of the three transports; MCP prompt_get/set + UI project over
// the same service). Config management is TENANT_ADMIN; the scoped service is the hard boundary.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// Parses the optional optimistic-concurrency precondition from the request body. Exported for direct
// unit testing of the boundary contract: a missing/blank/UNPARSEABLE value yields `undefined`, which
// the service treats as "no precondition" (last-write-wins). That degrade-on-garbage is deliberate —
// the precondition is opt-in (REST/MCP omit it) — but it means a client that serializes a malformed
// timestamp silently loses the overwrite protection, so the editor must always send a real ISO date.
export function parseExpectedUpdatedAt(
  s: string | undefined,
): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Splits the optimistic-concurrency precondition out of the PATCH body BEFORE it reaches the service.
// `agentUpdateSchema` is a strict zod object (rejects unknown keys), so forwarding the raw body with
// `expectedUpdatedAt` still on it fails with `unrecognized_keys` — the precondition must travel as an
// opt, never as a patch field. Exported so the split is unit-tested directly.
export function splitAgentUpdateBody(
  body: AgentUpdate & { expectedUpdatedAt?: string },
): { patch: AgentUpdate; expectedUpdatedAt: Date | undefined } {
  const { expectedUpdatedAt, ...patch } = body;
  return {
    patch: patch as AgentUpdate,
    expectedUpdatedAt: parseExpectedUpdatedAt(expectedUpdatedAt),
  };
}

// Live, non-persisted playground override (the "edit live" popup): the unsaved prompt/model/settings
// draft. The secret never travels — modelConfig carries only a credentialRef, resolved server-side.
// NOTE: Elysia normalizes `draft` against this schema, so a field that is missing HERE is stripped
// from the request before the handler ever sees it — silently, with the turn then running against
// the saved config. The type below is derived from this object precisely so the two cannot drift:
// declaring a draft field in TypeScript alone does not carry it over the wire.
export const playgroundDraftSchema = t.Object({
  systemPrompt: t.Optional(
    t.String({ maxLength: config.agent.promptMaxChars }),
  ),
  // The Availability picker's current value ("" = none). Semantic validation lives at the one place
  // that resolves it (prepare.ts: digits only, scoped read, anything else reads as no schedule).
  businessHoursId: t.Optional(t.String({ maxLength: 20 })),
  modelConfig: t.Optional(t.Record(t.String(), t.Unknown())),
  settings: t.Optional(t.Record(t.String(), t.Unknown())),
  // Playground tool-simulation: tool name → canned result (overrides any real/simulated execution).
  toolMocks: t.Optional(t.Record(t.String(), t.String({ maxLength: 10_000 }))),
  // Playground prompt-variable simulation: context-var name → value ({{nome_contato}} etc., which
  // resolve empty without a real conversation). Resolved server-side into the prompt interpolation.
  promptVars: t.Optional(t.Record(t.String(), t.String({ maxLength: 500 }))),
  // Playground time simulation: an offset-less wall-clock ("YYYY-MM-DDTHH:mm") that overrides the
  // current time for every {{hora_atual}}/{{data_atual}}/… variable, in the agent's timezone.
  promptNow: t.Optional(t.String({ maxLength: 40 })),
});

type PlaygroundDraft = typeof playgroundDraftSchema.static;

// The playground turn/follow-up request bodies, exported so the wire contract is TESTED rather than
// mirrored: a field that exists in TypeScript but not here is stripped by Elysia's normalize before
// the handler runs, and a test that copies the schema validates its own copy (issue #170).
export const playgroundTurnBodySchema = t.Object({
  message: t.String({
    minLength: 1,
    maxLength: 10_000,
    description: "The user message to send to the agent.",
  }),
  threadId: t.Optional(
    t.String({
      description:
        "Playground thread id, shaped tenantId:playground:agentId:uuid. Honored only when it matches this tenant and agent; otherwise a fresh thread is started.",
    }),
  ),
  draft: t.Optional(playgroundDraftSchema),
  forceAudio: t.Optional(
    t.Boolean({
      description:
        "Force an audio (TTS) reply for this turn regardless of the saved mode.",
    }),
  ),
  guardrails: t.Optional(
    t.Boolean({
      description:
        "Run the agent's guardrails over this turn (default true). Off skips the screening model call entirely.",
    }),
  ),
});

export const playgroundFollowupBodySchema = t.Object({
  threadId: t.Optional(
    t.String({
      description:
        "Playground thread id, shaped tenantId:playground:agentId:uuid, on which to simulate the follow-up.",
    }),
  ),
  context: t.Optional(
    t.String({
      maxLength: 1000,
      description: "Optional extra context to pass to the follow-up turn.",
    }),
  ),
  draft: t.Optional(playgroundDraftSchema),
  guardrails: t.Optional(
    t.Boolean({
      description:
        "Run the agent's guardrails over the simulated follow-up (default true).",
    }),
  ),
});

// `draft` rides the multipart request as a JSON string. Elysia's multipart parser auto-parses any
// field whose value starts with `{`/`[` and is valid JSON (see adapter/web-standard formData), so a
// well-formed draft arrives already as an object; a malformed one stays a string. Accept both and
// degrade to "no override" on bad input (the turn then runs against the saved config).
function parseDraft(
  raw: string | PlaygroundDraft | undefined,
): PlaygroundDraft | undefined {
  if (!raw) return undefined;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as PlaygroundDraft;
  } catch {
    return undefined;
  }
}

// Arbitrary text (a transcription / extraction) that might start with `{`/`[`, which Elysia's
// multipart parser would auto-parse into an object (see parseDraft). The client sends it JSON-encoded
// — always a quoted string, so it is never auto-parsed — and we decode it back here. Malformed ⇒
// undefined (the turn then re-derives the value server-side instead of reusing it).
function decodeMultipartText(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

// A boolean that rides multipart as a string. ABSENT stays absent: the default for this flag lives
// in the service (`screensThisTurn`), and coercing an omitted field to `true` here would put a
// second copy of it on the two endpoints that happen to use multipart, where a change to the real
// one would never reach. Only an explicit "false" is a decision.
export function decodeMultipartFlag(raw: unknown): boolean | undefined {
  return raw === undefined ? undefined : raw !== "false";
}

// The extract-only step reports one of three kinds; only these are honored as a precomputed value.
function decodeExtractKind(
  raw: unknown,
): "image" | "document" | "unsupported" | undefined {
  return raw === "image" || raw === "document" || raw === "unsupported"
    ? raw
    : undefined;
}

export const agentsController = new Elysia({
  prefix: "/v1/agents",
  tags: ["Agents"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext, query }) => {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const { agents, total } = await listAgentsPaged(
        ctxOrThrow(tenantContext),
        {
          q: parseQueryText(query.q, "q"),
          orderBy: query.orderBy,
          order: query.order,
          enabled: query.enabled,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      );
      return { instance: instanceIdentity, agents, total, page, pageSize };
    },
    {
      detail: doc(
        "List agents",
        "Returns a paginated list of agents for the tenant.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        q: t.Optional(
          t.String({
            description:
              "Free-text search filter matched against the agent name.",
          }),
        ),
        orderBy: t.Optional(
          t.Union(
            [t.Literal("name"), t.Literal("createdAt"), t.Literal("updatedAt")],
            {
              description:
                "Sort field. Defaults to the service ordering when omitted.",
            },
          ),
        ),
        order: t.Optional(
          t.Union([t.Literal("asc"), t.Literal("desc")], {
            description: "Sort direction, ascending or descending.",
          }),
        ),
        enabled: t.Optional(
          t.Boolean({
            description: "Filter by enabled state. Omit to include both.",
          }),
        ),
        page: t.Optional(
          t.Numeric({
            minimum: 1,
            description: "1-based page number. Defaults to 1.",
          }),
        ),
        pageSize: t.Optional(
          t.Numeric({
            minimum: 1,
            maximum: 100,
            description: "Items per page, 1 to 100. Defaults to 20.",
          }),
        ),
      }),
    },
  )
  .get(
    "/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      agent: await getAgent(ctxOrThrow(tenantContext), requireDbId(params.id)),
    }),
    {
      detail: doc("Get agent", "Returns a single agent by id."),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
    },
  )
  // Whether this agent's guardrail screen is actually running, from what it recorded. The editor's
  // configuration-warning panel needs it because configuration cannot answer the question: analysis
  // is fail-open, so a screen that can never run reads as one that ran and approved everywhere else.
  .get(
    "/:id/guardrails/health",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      windowHours: GUARDRAIL_HEALTH_WINDOW_HOURS,
      ...(await readGuardrailHealth(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        guardrailHealthWindowStart(),
      )),
    }),
    {
      detail: doc(
        "Get guardrail health",
        "Counts the guardrail analyses that could not run for this agent in the recent window, with the most recent one and the error it carried. Analysis is fail-open, so a check counted here caught nothing and held nothing back. It does not follow that the turn went out unscreened: the other direction may still have screened it, and a split output analysis can carry an error from one half and a violation from the other.",
      ),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
    },
  )
  // Which of this agent's bound inboxes ALREADY answer out of hours from Chatwoot's side. The editor's
  // warning panel needs it for the same reason it needs guardrail health: the answer is not in this
  // product's configuration at all, and the collision it warns about is invisible from either console.
  .get(
    "/:id/inboxes/out-of-office",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      inboxes: await listOutOfOfficeInboxes(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      detail: doc(
        "List inboxes that answer out of hours",
        'The agent\'s bound inboxes whose Chatwoot inbox-level out-of-office reply is configured (working hours enabled AND a message set), read live from Chatwoot. Chatwoot\'s schedule is keyed on the day of the week alone, so it cannot express the dated closures this product\'s business hours can: the two calendars disagree on holidays by construction. An inbox on an unreachable Chatwoot account is omitted rather than reported, so an empty list means "nothing found", not "nothing to find".',
      ),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      agent: await createAgent(ctxOrThrow(tenantContext), body as AgentCreate),
    }),
    {
      detail: doc("Create agent", "Creates a new agent for the tenant."),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        name: t.String({
          minLength: 1,
          maxLength: 200,
          description: "Display name of the agent.",
        }),
        systemPrompt: t.Optional(
          t.String({
            // NOTE: no maxLength here — the service enforces the (env-configurable) cap and
            // raises the localized error; a TypeBox cap would 422 first with a raw message.
            description: `System prompt template, may contain {{variable}} placeholders (up to ${config.agent.promptMaxChars} characters).`,
          }),
        ),
        enabled: t.Optional(
          t.Boolean({
            description:
              "Whether the agent is active and may handle conversations.",
          }),
        ),
        mode: t.Optional(
          t.Union([t.Literal("test"), t.Literal("production")], {
            description:
              "Operating mode: 'test' stays silent in a conversation until the customer sends /teste; 'production' answers normally.",
          }),
        ),
        transferWithSummary: t.Optional(
          t.Boolean({
            description:
              "When true, a handoff to a human includes an auto-generated summary.",
          }),
        ),
        modelConfig: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              "Model settings (provider, model, credentialRef, temperature, reasoningEffort, etc.). `credentialRef` is a vault reference (`vault:<id>`, from GET /v1/vault): never the secret itself, and never an entry name.",
          }),
        ),
        settings: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              "Behavior settings bag (debounce, stt, tts, split, serviceWindow, and similar). Every `credentialRef` in it is a vault reference (`vault:<id>`, from GET /v1/vault): never the secret itself, and never an entry name.",
          }),
        ),
        businessHoursId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Business-hours schedule id (BigInt string), or null for none.",
          }),
        ),
        followUpHoursId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Follow-up schedule id (BigInt string), or null for none.",
          }),
        ),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ tenantContext, params, body }) => {
      const { patch, expectedUpdatedAt } = splitAgentUpdateBody(
        body as AgentUpdate & { expectedUpdatedAt?: string },
      );
      return {
        instance: instanceIdentity,
        agent: await updateAgent(
          ctxOrThrow(tenantContext),
          requireDbId(params.id),
          patch,
          undefined,
          { expectedUpdatedAt },
        ),
      };
    },
    {
      detail: doc("Update agent", "Partially updates an existing agent."),
      response: errors(400, 401, 403, 404, 409, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: t.Object({
        name: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 200,
            description: "Display name of the agent.",
          }),
        ),
        systemPrompt: t.Optional(
          t.String({
            // NOTE: no maxLength here — the service enforces the (env-configurable) cap and
            // raises the localized error; a TypeBox cap would 422 first with a raw message.
            description: `System prompt template, may contain {{variable}} placeholders (up to ${config.agent.promptMaxChars} characters).`,
          }),
        ),
        enabled: t.Optional(
          t.Boolean({
            description:
              "Whether the agent is active and may handle conversations.",
          }),
        ),
        mode: t.Optional(
          t.Union([t.Literal("test"), t.Literal("production")], {
            description:
              "Operating mode: 'test' stays silent in a conversation until the customer sends /teste; 'production' answers normally.",
          }),
        ),
        transferWithSummary: t.Optional(
          t.Boolean({
            description:
              "When true, a handoff to a human includes an auto-generated summary.",
          }),
        ),
        modelConfig: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              "Model settings (provider, model, credentialRef, temperature, reasoningEffort, etc.). `credentialRef` is a vault reference (`vault:<id>`, from GET /v1/vault): never the secret itself, and never an entry name.",
          }),
        ),
        settings: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              "Behavior settings bag (debounce, stt, tts, split, serviceWindow, and similar). Every `credentialRef` in it is a vault reference (`vault:<id>`, from GET /v1/vault): never the secret itself, and never an entry name.",
          }),
        ),
        businessHoursId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Business-hours schedule id (BigInt string), or null for none.",
          }),
        ),
        followUpHoursId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Follow-up schedule id (BigInt string), or null for none.",
          }),
        ),
        expectedUpdatedAt: t.Optional(
          t.String({
            description:
              "Optimistic-concurrency precondition: the agent's updatedAt the client loaded (ISO). When it no longer matches, the update is rejected with 409 instead of overwriting a change made elsewhere. Omit for last-write-wins.",
          }),
        ),
      }),
    },
  )
  // Deleting an agent destroys its brain (prompt, grants, behavior) and detaches its inboxes — HARD
  // gated like the Chatwoot teardown: the operator re-types the agent's name AND confirms with their
  // password (step-up). The bundled components (tools/KB/integrations) are tenant-level and survive.
  .delete(
    "/:id",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as { confirmName: string; password: string };
      const agent = await getAgent(ctx, requireDbId(params.id));
      if (b.confirmName.trim() !== agent.name) {
        throw new AppError(
          "name confirmation does not match",
          400,
          "errors.agentConfirmMismatch",
        );
      }
      const user = ctx.userId ? await getUserById(ctx.userId) : null;
      if (
        !user?.passwordHash ||
        !(await verifyPassword(b.password, user.passwordHash))
      ) {
        throw new AppError("Incorrect password", 403, "errors.invalidPassword");
      }
      await deleteAgent(ctx, requireDbId(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      detail: doc(
        "Delete agent",
        "Deletes an agent by id. Requires re-typing the agent name and the current password (step-up).",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: t.Object({
        confirmName: t.String({
          description: "The agent's name, re-typed to confirm.",
        }),
        password: t.String({
          minLength: 1,
          description: "The acting user's password (step-up confirmation).",
        }),
      }),
    },
  )
  .post(
    "/:id/clone",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      agent: await cloneAgent(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        (body as { name?: string }).name,
      ),
    }),
    {
      detail: doc("Clone agent", "Creates a copy of an existing agent."),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Source agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: t.Object({
        name: t.Optional(
          t.String({
            maxLength: 200,
            description:
              "Name for the clone. Defaults to a derived name when omitted.",
          }),
        ),
      }),
    },
  )
  // Export an agent's full config as a portable, secret-free JSON (references by name).
  .get(
    "/:id/export",
    async ({ tenantContext, params, query }) => ({
      instance: instanceIdentity,
      export: await exportAgent(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        undefined,
        {
          // `?components=true` bundles the full HTTP-tool / MCP / integration defs + KB metadata so
          // the agent imports self-sufficiently (still secret-free; credentials by name only).
          includeComponents: query.components === "true",
          // `?documents=true` additionally bundles the KB documents' source text (re-indexed at the
          // destination). Data-bearing; only meaningful alongside components.
          includeDocuments: query.documents === "true",
        },
      ),
    }),
    {
      detail: doc(
        "Export agent config",
        "Exports the agent's full configuration as a portable, secret-free JSON.",
      ),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      query: t.Object({
        components: t.Optional(
          t.String({
            description:
              "When 'true', include full component definitions (HTTP tools, MCP servers, integrations, KB metadata).",
          }),
        ),
        documents: t.Optional(
          t.String({
            description:
              "When 'true' (with components), also bundle the source text of every knowledge-base document so it can be re-indexed at the destination. The file becomes data-bearing.",
          }),
        ),
      }),
    },
  )
  // Import an exported config: recreates the agent DISABLED, resolving references by name; missing
  // references come back as warnings (the agent is incomplete, never broken).
  .post(
    "/import",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      ...(await importAgent(
        ctxOrThrow(tenantContext),
        (body as { export: unknown }).export,
      )),
    }),
    {
      detail: doc(
        "Import agent config",
        "Recreates an agent (disabled) from an exported config, resolving references by name.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        export: t.Unknown({
          description: "The previously exported agent-config JSON object.",
        }),
      }),
    },
  )
  .get(
    "/:id/tool-selections",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      ...(await getAgentToolSelections(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      )),
    }),
    {
      detail: doc(
        "Get tool selections",
        "Returns the agent's current tool grants across all sources.",
      ),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
    },
  )
  // Playground: chat with the agent directly (no Chatwoot). Tenant-scoped; the thread is fenced to
  // this tenant+agent inside the service so a forged threadId can't read another conversation.
  .post(
    "/:id/playground",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as {
        message: string;
        threadId?: string;
        draft?: PlaygroundDraft;
        forceAudio?: boolean;
        guardrails?: boolean;
      };
      return {
        instance: instanceIdentity,
        ...(await runPlaygroundTurn({
          ctx,
          agentId: requireDbId(params.id),
          message: b.message,
          threadId: b.threadId,
          overrides: b.draft,
          forceAudio: b.forceAudio,
          guardrails: b.guardrails,
        })),
      };
    },
    {
      detail: doc(
        "Run playground turn",
        "Runs one chat turn against the agent in the playground, with no Chatwoot side effects.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: playgroundTurnBodySchema,
    },
  )
  // Lists the agent's tools (name/description/category + which are auto-simulated) so the
  // playground can render the simulate-a-return UI without the operator typing tool names by hand.
  .get(
    "/:id/playground/tools",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      return {
        instance: instanceIdentity,
        tools: await listPlaygroundTools({
          ctx,
          agentId: requireDbId(params.id),
        }),
      };
    },
    {
      detail: doc(
        "List playground tools",
        "Returns the agent's tools (name, description, category, auto-simulated flag) for the simulate-a-return UI.",
      ),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
    },
  )
  // Playground follow-up: simulate the proactive nudge the scheduler would fire after inactivity,
  // on the current playground thread, without waiting for the delay (no Chatwoot post).
  .post(
    "/:id/playground/followup",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as {
        threadId?: string;
        context?: string;
        draft?: PlaygroundDraft;
        guardrails?: boolean;
      };
      return {
        instance: instanceIdentity,
        ...(await runPlaygroundFollowup({
          ctx,
          agentId: requireDbId(params.id),
          threadId: b.threadId,
          context: b.context,
          overrides: b.draft,
          guardrails: b.guardrails,
        })),
      };
    },
    {
      detail: doc(
        "Run playground follow-up",
        "Simulates the proactive follow-up nudge on the current playground thread, with no Chatwoot post.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: playgroundFollowupBodySchema,
    },
  )
  // Playground voice note, step 1/2: transcribe ONLY, so the console can show the transcription
  // immediately (before the slower agent turn). Multipart; returns just the transcription. The
  // draft's STT config wins, so an unsaved credential is testable.
  .post(
    "/:id/playground/audio/transcribe",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as { file: File; draft?: string | PlaygroundDraft };
      return {
        instance: instanceIdentity,
        ...(await runPlaygroundTranscribe({
          ctx,
          agentId: requireDbId(params.id),
          file: b.file,
          overrides: parseDraft(b.draft),
        })),
      };
    },
    {
      detail: doc(
        "Transcribe playground audio",
        "Transcribes an uploaded voice note only (step 1 of 2), returning the transcription.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: t.Object({
        file: t.File({
          description: "The audio file (voice note) to transcribe.",
        }),
        draft: t.Optional(
          t.Union([t.String(), playgroundDraftSchema], {
            description:
              "Live, unsaved config override as a JSON string or object; its STT config wins so an unsaved credential is testable.",
          }),
        ),
      }),
    },
  )
  // Playground voice note, step 2/2: run a turn on the rendered <mensagem-de-audio>. Multipart;
  // returns the transcription + the reply. When `transcription` is supplied (from step 1) STT is
  // skipped here, so the reply isn't delayed by a second transcription.
  .post(
    "/:id/playground/audio",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as {
        file: File;
        threadId?: string;
        draft?: string | PlaygroundDraft;
        forceAudio?: string;
        guardrails?: string;
        transcription?: string;
      };
      const overrides = parseDraft(b.draft);
      return {
        instance: instanceIdentity,
        ...(await runPlaygroundAudioTurn({
          ctx,
          agentId: requireDbId(params.id),
          file: b.file,
          threadId: b.threadId,
          overrides,
          forceAudio: b.forceAudio === "true",
          guardrails: decodeMultipartFlag(b.guardrails),
          transcription: decodeMultipartText(b.transcription),
        })),
      };
    },
    {
      detail: doc(
        "Run playground audio turn",
        "Runs a turn on an uploaded voice note (step 2 of 2), returning the transcription and the reply.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: t.Object({
        file: t.File({
          description: "The audio file (voice note) to process.",
        }),
        threadId: t.Optional(
          t.String({
            description:
              "Playground thread id, shaped tenantId:playground:agentId:uuid, to continue.",
          }),
        ),
        draft: t.Optional(
          t.Union([t.String(), playgroundDraftSchema], {
            description:
              "Live, unsaved config override as a JSON string or object.",
          }),
        ),
        forceAudio: t.Optional(
          t.String({
            description: 'Force an audio reply when the string equals "true".',
          }),
        ),
        guardrails: t.Optional(
          t.String({
            description:
              'Skip the guardrail screening when the string equals "false" (default: screened).',
          }),
        ),
        transcription: t.Optional(
          t.String({
            description:
              "JSON-encoded precomputed transcription from step 1; when present, STT is skipped here.",
          }),
        ),
      }),
    },
  )
  // Playground image/document, step 1/2: extract ONLY, so the console can show the extracted content
  // immediately (before the slower agent turn). Multipart; returns the kind + content. The draft's
  // vision config wins, so an unsaved credential is testable.
  .post(
    "/:id/playground/file/extract",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as { file: File; draft?: string | PlaygroundDraft };
      return {
        instance: instanceIdentity,
        ...(await runPlaygroundExtract({
          ctx,
          agentId: requireDbId(params.id),
          file: b.file,
          overrides: parseDraft(b.draft),
        })),
      };
    },
    {
      detail: doc(
        "Extract playground file",
        "Extracts content from an uploaded image or document only (step 1 of 2), returning the kind and content.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: t.Object({
        file: t.File({
          description: "The image or document file to extract from.",
        }),
        draft: t.Optional(
          t.Union([t.String(), playgroundDraftSchema], {
            description:
              "Live, unsaved config override as a JSON string or object; its vision config wins so an unsaved credential is testable.",
          }),
        ),
      }),
    },
  )
  // Playground image/document, step 2/2: run a turn on the rendered marker. Multipart; returns the
  // extraction kind + content + the reply. When `kind`+`extracted` are supplied (from step 1) the
  // vision call is skipped here, so the reply isn't delayed by a second extraction.
  .post(
    "/:id/playground/file",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as {
        file: File;
        threadId?: string;
        draft?: string | PlaygroundDraft;
        forceAudio?: string;
        guardrails?: string;
        kind?: string;
        extracted?: string;
      };
      const overrides = parseDraft(b.draft);
      return {
        instance: instanceIdentity,
        ...(await runPlaygroundFileTurn({
          ctx,
          agentId: requireDbId(params.id),
          file: b.file,
          threadId: b.threadId,
          overrides,
          forceAudio: b.forceAudio === "true",
          guardrails: decodeMultipartFlag(b.guardrails),
          kind: decodeExtractKind(b.kind),
          extracted: decodeMultipartText(b.extracted),
        })),
      };
    },
    {
      detail: doc(
        "Run playground file turn",
        "Runs a turn on an uploaded image or document (step 2 of 2), returning the extraction and the reply.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: t.Object({
        file: t.File({ description: "The image or document file to process." }),
        threadId: t.Optional(
          t.String({
            description:
              "Playground thread id, shaped tenantId:playground:agentId:uuid, to continue.",
          }),
        ),
        draft: t.Optional(
          t.Union([t.String(), playgroundDraftSchema], {
            description:
              "Live, unsaved config override as a JSON string or object.",
          }),
        ),
        forceAudio: t.Optional(
          t.String({
            description: 'Force an audio reply when the string equals "true".',
          }),
        ),
        guardrails: t.Optional(
          t.String({
            description:
              'Skip the guardrail screening when the string equals "false" (default: screened).',
          }),
        ),
        kind: t.Optional(
          t.String({
            description:
              'Precomputed extraction kind from step 1: "image", "document", or "unsupported". When present with extracted, the vision call is skipped.',
          }),
        ),
        extracted: t.Optional(
          t.String({
            description:
              "JSON-encoded precomputed extracted content from step 1; when present, vision extraction is skipped here.",
          }),
        ),
      }),
    },
  )
  // Playground media: stream a persisted blob (recorded audio / TTS reply / uploaded file) for
  // in-app playback. Tenant-scoped; returns the raw bytes with their content-type.
  .get(
    "/:id/playground/media/:mediaId",
    async ({ tenantContext, params, set }) => {
      const ctx = ctxOrThrow(tenantContext);
      // NOTE: refused, not answered 404. A media id that is not an id is a malformed request, and
      // this route used to answer it as "no such blob": the one spelling of the rule in this app
      // that told the caller their id was fine and the row was gone. Issue #371.
      const blob = await getPlaygroundMedia(
        ctx,
        requireDbId(params.mediaId, "mediaId"),
      );
      if (!blob) {
        set.status = 404;
        return { error: "Not Found" };
      }
      return new Response(blob.bytes, {
        headers: {
          "content-type": blob.mime,
          "cache-control": "private, max-age=3600",
        },
      });
    },
    {
      detail: doc(
        "Stream playground media",
        "Streams a persisted playground blob (recorded audio, TTS reply, or uploaded file) for in-app playback.",
      ),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
        mediaId: t.String({
          description: "Stored media id, a BigInt encoded as a decimal string.",
        }),
      }),
    },
  )
  // Playground session history (server-side; the transcript is reconstructed from the checkpointer).
  .get(
    "/:id/playground/sessions",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      return {
        instance: instanceIdentity,
        sessions: await listPlaygroundSessions(ctx, requireDbId(params.id)),
      };
    },
    {
      detail: doc(
        "List playground sessions",
        "Returns the agent's playground sessions, reconstructed from the checkpointer.",
      ),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
    },
  )
  .get(
    "/:id/playground/sessions/:threadId",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      return {
        instance: instanceIdentity,
        turns: await getPlaygroundSessionTurns(
          ctx,
          requireDbId(params.id),
          params.threadId,
        ),
      };
    },
    {
      detail: doc(
        "Get playground session turns",
        "Returns the reconstructed turns of a single playground session.",
      ),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
        threadId: t.String({
          description:
            "Playground thread id, shaped tenantId:playground:agentId:uuid.",
        }),
      }),
    },
  )
  .delete(
    "/:id/playground/sessions/:threadId",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      await deletePlaygroundSession(
        ctx,
        requireDbId(params.id),
        params.threadId,
      );
      return { instance: instanceIdentity, ok: true };
    },
    {
      detail: doc(
        "Delete playground session",
        "Deletes a single playground session and its checkpointed history.",
      ),
      response: errors(400, 401, 403, 404),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
        threadId: t.String({
          description:
            "Playground thread id, shaped tenantId:playground:agentId:uuid.",
        }),
      }),
    },
  )
  // POST to avoid leaking credentialRef/baseURL in server access logs (no query params).
  .post(
    "/models/list",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as {
        provider: string;
        credentialRef?: string;
        baseURL?: string;
        capability?: "chat" | "transcription" | "vision";
      };
      return {
        instance: instanceIdentity,
        models: await listProviderModels(ctx, {
          provider: b.provider,
          credentialRef: b.credentialRef,
          baseURL: b.baseURL,
          capability: b.capability,
        }),
      };
    },
    {
      detail: doc(
        "List provider models",
        "Lists the available models for a model provider, using a vault credential reference.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        provider: t.String({
          minLength: 1,
          description:
            "Model provider key (openai, anthropic, google, deepseek, openrouter, openai-compatible, and similar).",
        }),
        credentialRef: t.Optional(
          t.String({
            description:
              "Vault entry reference for the provider API key; the secret is resolved server-side.",
          }),
        ),
        baseURL: t.Optional(
          t.String({
            description:
              "Override base URL, required for the openai-compatible provider.",
          }),
        ),
        capability: t.Optional(
          t.Union(
            [
              t.Literal("chat"),
              t.Literal("transcription"),
              t.Literal("vision"),
            ],
            {
              description:
                "Filter models by capability. Defaults to chat-capable models.",
            },
          ),
        ),
      }),
    },
  )
  .post(
    "/tts/list",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as {
        provider: string;
        kind: "voices" | "models";
        credentialRef?: string;
        baseURL?: string;
      };
      return {
        instance: instanceIdentity,
        items: await listTtsOptions(ctx, {
          provider: b.provider,
          kind: b.kind,
          credentialRef: b.credentialRef,
          baseURL: b.baseURL,
        }),
      };
    },
    {
      detail: doc(
        "List TTS voices/models",
        "Lists the voices or models for a text-to-speech provider. OpenAI returns a curated set; ElevenLabs is fetched live with the vault credential.",
      ),
      response: errors(400, 401, 403, 404, 422),
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        provider: t.String({
          minLength: 1,
          description: "TTS provider key (openai, elevenlabs).",
        }),
        kind: t.Union([t.Literal("voices"), t.Literal("models")], {
          description: "Which list to return: the provider's voices or models.",
        }),
        credentialRef: t.Optional(
          t.String({
            description:
              "Vault entry reference for the provider API key (required for ElevenLabs).",
          }),
        ),
        baseURL: t.Optional(
          t.String({ description: "Optional override base URL." }),
        ),
      }),
    },
  )
  .put(
    "/:id/tool-selections",
    async ({ tenantContext, params, body }) => {
      const b = body as {
        grants: ToolGrantInput[];
        expectedUpdatedAt?: string;
      };
      return {
        instance: instanceIdentity,
        ...(await replaceAgentToolSelections(
          ctxOrThrow(tenantContext),
          requireDbId(params.id),
          b.grants,
          undefined,
          { expectedUpdatedAt: parseExpectedUpdatedAt(b.expectedUpdatedAt) },
        )),
      };
    },
    {
      detail: doc(
        "Replace tool selections",
        "Replaces the agent's entire set of tool grants (replace-the-set semantics).",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Agent id, a BigInt encoded as a decimal string.",
        }),
      }),
      body: t.Object({
        grants: t.Array(
          t.Object({
            source: t.Union(
              [
                t.Literal("NATIVE"),
                t.Literal("RAG"),
                t.Literal("HTTP"),
                t.Literal("MCP"),
                t.Literal("INTEGRATION"),
                t.Literal("DOCUMENT"),
              ],
              {
                description:
                  "Grant source: NATIVE (built-in tools), RAG (knowledge bases), HTTP (custom tool), MCP (MCP server connection), INTEGRATION (integration instance), or DOCUMENT (document template).",
              },
            ),
            toolDefinitionId: t.Optional(
              t.Union([t.String(), t.Null()], {
                description:
                  "Tool definition id (BigInt string) for NATIVE or HTTP grants, or null.",
              }),
            ),
            mcpServerConnectionId: t.Optional(
              t.Union([t.String(), t.Null()], {
                description:
                  "MCP server connection id (BigInt string) for MCP grants, or null.",
              }),
            ),
            integrationInstanceId: t.Optional(
              t.Union([t.String(), t.Null()], {
                description:
                  "Integration instance id (BigInt string) for INTEGRATION grants, or null.",
              }),
            ),
            documentTemplateId: t.Optional(
              t.Union([t.String(), t.Null()], {
                description:
                  "Document template id (BigInt string) for DOCUMENT grants, or null.",
              }),
            ),
            knowledgeBaseIds: t.Optional(
              t.Array(t.String(), {
                description:
                  "Knowledge-base ids (BigInt strings) for a RAG grant; the bases the agent may search.",
              }),
            ),
            enabledTools: t.Optional(
              t.Array(t.String(), {
                description:
                  "Subset of tool names to enable within the source; omit to enable the source's full set.",
              }),
            ),
          }),
        ),
        expectedUpdatedAt: t.Optional(
          t.String({
            description:
              "Optimistic-concurrency precondition: the agent's updatedAt the client loaded (ISO). Replacing the set bumps the agent's updatedAt; a stale precondition is rejected with 409. Omit for last-write-wins.",
          }),
        ),
      }),
    },
  );
