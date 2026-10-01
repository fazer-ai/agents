import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { normalizeExpectedStatuses } from "@/graph/tools/http-status";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { configHealthAfterWrite } from "@/modules/agents/config-health-read";
import type { AgentMode } from "@/modules/agents/mode";
import { isMonitoring } from "@/modules/agents/mode";
import {
  type AgentCreate,
  type AgentUpdate,
  assertAgentCreatable,
  assertAgentNotObserving,
  assertAgentToolGrantsResolvable,
  assertAgentUpdatable,
  assertCredentialRefsUsable,
  assertSchedulesExist,
  cloneAgent,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentToolSelections,
  replaceAgentToolSelections,
  type ToolGrantInput,
  updateAgent,
} from "@/modules/agents/service";
import { agentExportSchema, importAgent } from "@/modules/agents/transfer";
import {
  assertMcpConnectionCreatable,
  assertMcpConnectionHeadersFit,
  assertMcpConnectionNameAvailable,
  assertMcpConnectionUpdatable,
  createMcpConnection,
  deleteMcpConnection,
  discoverMcpTools,
  getMcpConnection,
  type McpConnectionCreate,
  type McpConnectionUpdate,
  updateMcpConnection,
} from "@/modules/mcp-connections/service";
import { unsupportedBodyShape } from "@/modules/tool-definitions/body-shape";
import { unusedCredentialWarning } from "@/modules/tool-definitions/credential-wiring";
import {
  normalizeToolShapes,
  type ToolShapePatch,
} from "@/modules/tool-definitions/normalize";
import {
  MODEL_RESPONSE_CHAR_MAX,
  MODEL_RESPONSE_CHAR_MIN,
  maxResponseCharsAcceptable,
  readResponseTemplateResult,
  storableResponseTemplate,
} from "@/modules/tool-definitions/response-template";
import {
  assertToolConversationRefResolvable,
  assertToolDefinitionCreatable,
  assertToolDefinitionPatchValid,
  assertToolNameAvailable,
  assertToolRelativeTemplateResolvable,
  createToolDefinition,
  deleteToolDefinition,
  getToolDefinition,
  type ToolDefinitionCreate,
  type ToolDefinitionUpdate,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import { dialableBaseUrl, readVaultRefFacts } from "@/modules/vault/service";
import type { VerifiedToken } from "./oauth/tokens";
import {
  diffFields,
  err,
  gate,
  ok,
  parseMcpId,
  resolveSecretRef,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP agent-builder write tools: create/update/clone/delete agents, replace an agent's tool
// grants, and CRUD the HTTP tool definitions + MCP server connections an agent can use. Every tool
// follows the spine: gate (mcp:write + tenant target) → resolve ids/credential NAMES server-side →
// load current (for update/delete) → dry-run preview by default → apply + audit. Credentials are
// always referenced by vault NAME (resolveSecretRef → vault:<id>); no raw secret crosses the model.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

// If a free-form config record carries a credentialRef NAME, resolve it to a stable vault:<id> ref
// (a vault:<id> passes through). Keeps the model-key reference out of the raw-secret path.
async function resolveConfigCredential(
  ctx: TenantContext,
  config: Record<string, unknown> | undefined,
  base: Parameters<typeof resolveSecretRef>[2],
): Promise<{ config?: Record<string, unknown> } | { fail: WriteResult }> {
  if (
    !config ||
    typeof config.credentialRef !== "string" ||
    !config.credentialRef
  ) {
    return { config };
  }
  const resolved = await resolveSecretRef(ctx, config.credentialRef, base);
  if ("fail" in resolved) return { fail: resolved.fail };
  return { config: { ...config, credentialRef: resolved.ref } };
}

// ── agents ──

export interface AgentCreateArgs {
  name: string;
  system_prompt?: string;
  enabled?: boolean;
  mode?: AgentMode;
  transfer_with_summary?: boolean;
  model_config?: Record<string, unknown>;
  business_hours_id?: string | null;
  follow_up_hours_id?: string | null;
  dry_run?: boolean;
}

export async function agentCreate(
  principal: VerifiedToken,
  args: AgentCreateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;

  const cred = await resolveConfigCredential(ctx, args.model_config, base);
  if ("fail" in cred) return cred.fail;

  const input: AgentCreate = { name: args.name };
  if (args.system_prompt !== undefined) input.systemPrompt = args.system_prompt;
  if (args.enabled !== undefined) input.enabled = args.enabled;
  if (args.mode !== undefined) input.mode = args.mode;
  if (args.transfer_with_summary !== undefined)
    input.transferWithSummary = args.transfer_with_summary;
  if (cred.config !== undefined) input.modelConfig = cred.config;
  if (args.business_hours_id !== undefined)
    input.businessHoursId = args.business_hours_id;
  if (args.follow_up_hours_id !== undefined)
    input.followUpHoursId = args.follow_up_hours_id;

  try {
    if (args.dry_run !== false) {
      // The core's own question, asked INSIDE the branch because the apply reaches the core,
      // which asks it again; above the branch it would be a second lookup that can disagree.
      const { businessHoursId, followUpHoursId } = assertAgentCreatable(input);
      // NOTE: ADVISORY, since this one READS. It takes the ids the line above PARSED, so the
      // preview and the write ask about the same rows.
      await assertSchedulesExist(ctx, businessHoursId, followUpHoursId, base);
      // NOTE: ADVISORY too: every credential ref resolves AND its kind can serve the field. A
      // `google_oauth` entry holds an object where most of these fields hand a string to a provider
      // SDK.
      await assertCredentialRefsUsable(ctx, input, base);
      return ok({
        dryRun: true,
        action: "create",
        resource: "agent",
        preview: input,
      });
    }
    const created = await createAgent(ctx, input, base);
    const target = `agent:${created.id}`;
    return ok({
      dryRun: false,
      applied: true,
      target,
      agent: created,
      ...(await configHealthAfterWrite(ctx, created.id, base)),
    });
  } catch (e) {
    return failOf(e);
  }
}

export interface AgentUpdateArgs {
  agent_id: string;
  name?: string;
  enabled?: boolean;
  mode?: AgentMode;
  transfer_with_summary?: boolean;
  model_config?: Record<string, unknown>;
  business_hours_id?: string | null;
  follow_up_hours_id?: string | null;
  dry_run?: boolean;
}

export async function agentUpdate(
  principal: VerifiedToken,
  args: AgentUpdateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.agent_id, "agent_id");
  if (typeof id !== "bigint") return id;

  const cred = await resolveConfigCredential(ctx, args.model_config, base);
  if ("fail" in cred) return cred.fail;

  const patch: AgentUpdate = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.mode !== undefined) patch.mode = args.mode;
  if (args.transfer_with_summary !== undefined)
    patch.transferWithSummary = args.transfer_with_summary;
  if (cred.config !== undefined) patch.modelConfig = cred.config;
  if (args.business_hours_id !== undefined)
    patch.businessHoursId = args.business_hours_id;
  if (args.follow_up_hours_id !== undefined)
    patch.followUpHoursId = args.follow_up_hours_id;
  if (Object.keys(patch).length === 0) {
    return err(
      "no updatable fields provided (name, enabled, mode, transfer_with_summary, model_config, business_hours_id, follow_up_hours_id)",
    );
  }

  try {
    const current = await getAgent(ctx, id, base);
    const keys = Object.keys(patch) as (keyof AgentUpdate)[];
    const beforeProj: Record<string, unknown> = {};
    const afterProj: Record<string, unknown> = {};
    for (const k of keys) {
      beforeProj[k] = (current as unknown as Record<string, unknown>)[k];
      afterProj[k] = patch[k];
    }
    const target = `agent:${id}`;
    if (args.dry_run !== false) {
      // The rules `updateAgent` applies past the not-found path, so the preview refuses what
      // the apply refuses.
      const { rest, businessHoursId, followUpHoursId } =
        assertAgentUpdatable(patch);
      await assertSchedulesExist(ctx, businessHoursId, followUpHoursId, base);
      // Against the STORED bag, not `{}`: on an update the question is whether this write CHANGES
      // a ref, and `current` is the same row the diff above was rendered from.
      await assertCredentialRefsUsable(ctx, rest, base, {
        modelConfig: current.modelConfig,
      });
      // NOTE: the apply refuses to SAVE a non-monitoring mode on an agent that observes an inbox
      // (its route answers nothing whatever the mode says), so the preview asks too.
      if (patch.mode !== undefined && !isMonitoring(patch.mode)) {
        await assertAgentNotObserving(ctx, id, base);
      }
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, afterProj),
      });
    }
    const updated = await updateAgent(ctx, id, patch, base);
    const appliedProj: Record<string, unknown> = {};
    for (const k of keys)
      appliedProj[k] = (updated as unknown as Record<string, unknown>)[k];
    return ok({
      dryRun: false,
      applied: true,
      target,
      diff: diffFields(beforeProj, appliedProj),
      ...(await configHealthAfterWrite(ctx, id, base)),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function agentClone(
  principal: VerifiedToken,
  args: { agent_id: string; name?: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.agent_id, "agent_id");
  if (typeof id !== "bigint") return id;
  try {
    const source = await getAgent(ctx, id, base);
    const target = `agent:${id}`;
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "clone",
        target,
        sourceName: source.name,
        newName: args.name ?? `${source.name} (copy)`,
      });
    }
    const clone = await cloneAgent(ctx, id, args.name, base);
    return ok({
      dryRun: false,
      applied: true,
      agent: clone,
      ...(await configHealthAfterWrite(ctx, clone.id, base)),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function agentImport(
  principal: VerifiedToken,
  args: { export: unknown; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  // Validate the export shape up front (the same schema importAgent enforces) so a malformed
  // payload fails as a clean WriteResult AND the dry-run can summarize what would be created.
  const parsed = agentExportSchema.safeParse(args.export);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return err(`invalid agent export: ${detail}`);
  }
  const exp = parsed.data;
  const comps = exp.components;
  // Dry-run by DEFAULT: report what would be created (the agent ALWAYS lands disabled + in test
  // mode). Credentials absent in this tenant are created as PENDING placeholders on apply (the ref
  // stays wired); the operator only fills each secret afterward (deep-link → vault) — write nothing now.
  if (args.dry_run !== false) {
    // The apply itself, rolled back (transfer.ts), so these warnings are the ones the
    // operator will get. A separate copy of the import's naming and reuse decisions would drift
    // from them.
    const rehearsal = await importAgent(ctx, args.export, base, {
      dryRun: true,
    }).catch((e: unknown) => {
      // A refusal here is one the apply would give too, and it belongs to the caller either way.
      if (e instanceof AppError) return { failed: err(e.message) } as const;
      throw e;
    });
    if ("failed" in rehearsal) return rehearsal.failed;
    return ok({
      dryRun: true,
      action: "import",
      agentName: exp.agent.name,
      willCreate: { enabled: false, mode: "test" },
      credentialsNeeded: exp.agent.credentials.map((c) => ({
        name: c.name,
        kind: c.kind,
      })),
      // What the apply ANSWERED, not what this function guessed it would: reuses, renames, skips
      // and every credential it could not find, verbatim from the rehearsal above.
      ...(rehearsal.warnings.length > 0
        ? { warnings: rehearsal.warnings }
        : {}),
      // Every component array the bundle CARRIES, counted. It is a different number from what the
      // apply creates — a component the destination already has is reused, and one this build
      // cannot store is skipped — and which is which is in the warnings above, per component, by
      // name. A preview that omitted an array entirely would be worse than one that over-counts:
      // the apply reuses or creates all of them before it assigns the grants.
      components: {
        httpTools: comps?.httpTools.length ?? 0,
        mcpServers: comps?.mcpServers.length ?? 0,
        integrations: comps?.integrations.length ?? 0,
        knowledgeBases: comps?.knowledgeBases.length ?? 0,
        documentTemplates: comps?.documentTemplates?.length ?? 0,
        codeTools: comps?.codeTools?.length ?? 0,
        businessHours: comps?.businessHours?.length ?? 0,
      },
    });
  }
  // Apply: importAgent creates the agent (+ any missing components) disabled/test and returns
  // structured warnings (reused components / missing credentials) for the operator to resolve.
  try {
    const { agent, warnings } = await importAgent(ctx, args.export, base);
    return ok({
      dryRun: false,
      applied: true,
      agent,
      warnings,
      ...(await configHealthAfterWrite(ctx, agent.id, base)),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function agentDelete(
  principal: VerifiedToken,
  args: { agent_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.agent_id, "agent_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getAgent(ctx, id, base);
    const target = `agent:${id}`;
    const beforeProj = { id: current.id, name: current.name };
    if (args.dry_run !== false) {
      // NOTE: the apply refuses to delete an agent that observes an inbox: the cascade would retire
      // the row and the route token while the fork kept delivering to a bot that is gone, and the
      // detach is a Chatwoot call the deletion's transaction cannot make.
      await assertAgentNotObserving(ctx, id, base);
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteAgent(ctx, id, base);
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export interface AgentToolsSetArgs {
  agent_id: string;
  grants: Array<{
    source: string;
    toolDefinitionId?: string | null;
    mcpServerConnectionId?: string | null;
    integrationInstanceId?: string | null;
    // The template a DOCUMENT grant points at. Without it this surface could CREATE a document
    // template over MCP and then had no way to grant it to an agent — the operator ended one step
    // short of a working document tool, in the transport the whole feature is authored from.
    documentTemplateId?: string | null;
    // The code tool a CODE grant points at (code_tool_list), for the same reason.
    codeToolDefinitionId?: string | null;
    knowledgeBaseIds?: string[];
    enabledTools?: string[];
  }>;
  dry_run?: boolean;
}

export async function agentToolsSet(
  principal: VerifiedToken,
  args: AgentToolsSetArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.agent_id, "agent_id");
  if (typeof id !== "bigint") return id;
  const grants: ToolGrantInput[] = args.grants.map((g) => ({
    source: g.source,
    toolDefinitionId: g.toolDefinitionId ?? null,
    mcpServerConnectionId: g.mcpServerConnectionId ?? null,
    integrationInstanceId: g.integrationInstanceId ?? null,
    documentTemplateId: g.documentTemplateId ?? null,
    codeToolDefinitionId: g.codeToolDefinitionId ?? null,
    knowledgeBaseIds: g.knowledgeBaseIds ?? [],
    enabledTools: g.enabledTools ?? [],
  }));
  try {
    const current = await getAgentToolSelections(ctx, id, base);
    const target = `agent:${id}`;
    if (args.dry_run !== false) {
      // NOTE: the core's own question about the ids INSIDE the array, which the row's single
      // `agent_id` never reaches. Inside the branch because `replaceAgentToolSelections` asks it
      // again under its lock.
      await assertAgentToolGrantsResolvable(ctx, grants, base);
      return ok({
        dryRun: true,
        target,
        currentGrants: current.grants,
        nextGrants: grants,
      });
    }
    const view = await replaceAgentToolSelections(ctx, id, grants, base);
    return ok({
      dryRun: false,
      applied: true,
      target,
      grants: view.grants,
      ...(await configHealthAfterWrite(ctx, id, base)),
    });
  } catch (e) {
    return failOf(e);
  }
}

// ── HTTP tool definitions ──

export interface ToolWriteArgs {
  name?: string;
  label?: string;
  description?: string | null;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url_template?: string;
  allowed_hosts?: string[];
  headers?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  credential_ref?: string | null;
  enabled?: boolean;
  expected_statuses?: number[];
  ack_enabled?: boolean;
  ack_message?: string | null;
  max_response_chars?: number | null;
  conversation_ref_integration_id?: string | number | null;
}

// Map snake_case tool args → the service's camelCase shape, resolving credential_ref NAME → vault:<id>.
//
// EXPORTED for the dry-run tests. What the preview shows has to be what the apply stores, and the
// only way to say that as a test is to ask this function what it built.
export async function buildToolPatch(
  ctx: TenantContext,
  args: ToolWriteArgs,
  base: Parameters<typeof resolveSecretRef>[2],
): Promise<{ patch: ToolDefinitionUpdate } | { fail: WriteResult }> {
  const patch: ToolDefinitionUpdate = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.label !== undefined) patch.label = args.label;
  if (args.description !== undefined) patch.description = args.description;
  if (args.method !== undefined) patch.method = args.method;
  if (args.url_template !== undefined) patch.urlTemplate = args.url_template;
  if (args.allowed_hosts !== undefined) patch.allowedHosts = args.allowed_hosts;
  if (args.headers !== undefined) patch.headers = args.headers;
  if (args.input_schema !== undefined) patch.inputSchema = args.input_schema;
  if (args.output_schema !== undefined) {
    // Refused here and not only in the service, for the reason the body check below gives: a
    // dry run never calls the service, so a template the apply would reject was previewed back
    // intact and with no warning. Only a DECLARED template is judged — anything else in this column
    // (including a real JSON Schema, which this argument has accepted unvalidated since it existed)
    // passes through as it always has.
    const r = readResponseTemplateResult(args.output_schema);
    if (r.declared && !r.ok) return { fail: err(r.problem) };
    // CANONICALIZED, not passed through, and it is the same lesson one line further down: the
    // service stores what `storableResponseTemplate` makes of this — a trimmed template, extra keys
    // dropped — so a dry run echoing the argument back promises a value that will not be stored,
    // and the diff a caller reads before applying is a diff against the wrong thing.
    patch.outputSchema = storableResponseTemplate(args.output_schema);
  }
  if (args.query !== undefined) patch.query = args.query;
  if (args.body !== undefined) {
    // Refused here and not only in the service: a dry run never calls the service, so a body
    // the apply rejects would otherwise preview back intact.
    const badBody = unsupportedBodyShape(args.body);
    if (badBody) return { fail: err(badBody) };
    patch.body = args.body;
  }
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  // Normalized HERE and not only in the service: this patch is also what a dry run shows as the
  // preview, and a preview that echoes the raw argument promises a shape the apply would not write.
  if (args.expected_statuses !== undefined)
    patch.expectedStatuses = normalizeExpectedStatuses(args.expected_statuses);
  if (args.ack_enabled !== undefined) patch.ackEnabled = args.ack_enabled;
  if (args.ack_message !== undefined) patch.ackMessage = args.ack_message;
  if (args.max_response_chars !== undefined) {
    // NOTE: refused here as well as in the service so the sentence names the argument THIS caller
    // sent; the service's names the REST field.
    if (!maxResponseCharsAcceptable(args.max_response_chars)) {
      return {
        fail: err(
          `max_response_chars must be an integer from ${MODEL_RESPONSE_CHAR_MIN} to ${MODEL_RESPONSE_CHAR_MAX}, or null for the default`,
        ),
      };
    }
    patch.maxResponseChars = args.max_response_chars;
  }
  if (args.conversation_ref_integration_id !== undefined) {
    patch.conversationRefIntegrationId =
      args.conversation_ref_integration_id === ""
        ? null
        : args.conversation_ref_integration_id;
  }
  if (args.credential_ref !== undefined) {
    if (args.credential_ref === null || args.credential_ref === "") {
      patch.credentialRef = null;
    } else {
      const resolved = await resolveSecretRef(ctx, args.credential_ref, base);
      if ("fail" in resolved) return { fail: resolved.fail };
      patch.credentialRef = resolved.ref;
    }
  }
  return { patch };
}

// The five interpolation sites off a row or a patch, as one object. Spelled once because the two
// writers assemble the same thing from three different shapes (the create input, the update patch,
// the stored row) and a site dropped from one of those spellings is a warning that fires on a tool
// that is wired.
function toolShapesOf(src: {
  urlTemplate?: string | null;
  query?: unknown;
  headers?: unknown;
  body?: unknown;
  inputSchema?: unknown;
}): ToolShapePatch {
  const out: ToolShapePatch = {};
  // NOTE: an absent site is OMITTED, never set to `undefined`. These objects are spread over one
  // another to build the effective row, and a spread key whose value is `undefined` overwrites: the
  // patch would erase every template it does not mention, and the warning would then fire on the
  // tool it was reading.
  if (typeof src.urlTemplate === "string") out.urlTemplate = src.urlTemplate;
  if (src.query !== undefined) out.query = src.query;
  if (src.headers !== undefined) out.headers = src.headers;
  if (src.body !== undefined) out.body = src.body;
  if (src.inputSchema !== undefined) out.inputSchema = src.inputSchema;
  return out;
}

// The unused-credential warning read AFTER the write committed, so a failure yields no warning
// instead of `ok: false` for a tool that exists (a retry would meet a name conflict). `shapes` is
// the effective row (patch over stored) and RAW: `unusedCredentialWarning` normalizes it, as
// `buildHttpTool` does. Arguments are spelled out, not spread, so the base-client fence reads them.
async function appliedWiringWarning(
  ctx: TenantContext,
  base: PrismaClient,
  credentialRef: string | null | undefined,
  method: string | null | undefined,
  shapes: ToolShapePatch,
  ackMessage: string | null | undefined,
  allowedHosts: string[] | null | undefined,
): Promise<string[]> {
  try {
    return await credentialWiringWarning(
      ctx,
      base,
      credentialRef,
      method,
      shapes,
      ackMessage,
      allowedHosts,
    );
  } catch {
    return [];
  }
}

async function credentialWiringWarning(
  ctx: TenantContext,
  base: PrismaClient,
  credentialRef: string | null | undefined,
  method: string | null | undefined,
  shapes: ToolShapePatch,
  ackMessage: string | null | undefined,
  allowedHosts: string[] | null | undefined,
): Promise<string[]> {
  if (!credentialRef) return [];
  const facts = await runScopedOn(base, ctx, (db) =>
    readVaultRefFacts(db, credentialRef),
  );
  // NOTE: a ref that names no row is a DIFFERENT problem — the credential was deleted, and the fix is
  // to attach one, not to wire the one that is there. Reading the miss as a legacy `generic` handed
  // that operator remediation for a tool whose credential does not exist. config-health is where the
  // dangling ref is reported; this stays quiet about it.
  if (!facts) return [];
  const warning = unusedCredentialWarning(
    // NOTE: the DIALABLE base, like every other reader — the facts carry the row as it is, and a
    // stray base URL on a kind that has no use for one is not prepended to anything any more. Judging
    // the stored value would read a relative tool as pointing somewhere it does not.
    {
      kind: facts.kind,
      paramName: facts.paramName,
      baseUrl: dialableBaseUrl(facts.kind, facts.baseUrl),
    },
    method,
    shapes,
    { ackMessage, allowedHosts },
  );
  return warning ? [warning] : [];
}

export async function toolCreate(
  principal: VerifiedToken,
  args: ToolWriteArgs & { dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  if (!args.name) return err("name is required");
  if (!args.url_template) return err("url_template is required");
  if (!args.allowed_hosts) return err("allowed_hosts is required");
  const built = await buildToolPatch(ctx, args, base);
  if ("fail" in built) return built.fail;
  const input = {
    ...built.patch,
    name: args.name,
    // label is required; default to the identifier when the caller didn't supply a display name.
    label: args.label ?? args.name,
    urlTemplate: args.url_template,
    allowedHosts: args.allowed_hosts,
  } as ToolDefinitionCreate;
  // Surface what the service will canonicalize (JSON-Schema input_schema, single-brace
  // {var}) so the author sees the converted shape and probable typos in the preview.
  const norm = normalizeToolShapes({
    urlTemplate: input.urlTemplate,
    query: input.query,
    headers: input.headers,
    body: input.body,
    inputSchema: input.inputSchema,
  });
  try {
    if (args.dry_run !== false) {
      // The core's own question, asked INSIDE the branch because the apply reaches the core,
      // which asks it again; above the branch it would be a second lookup that can disagree.
      const parsed = assertToolDefinitionCreatable(input);
      // NOTE: ADVISORY: it reads outside the apply's transaction, so the name can be taken
      // meanwhile. The unique index inside the write is what guarantees one name per row.
      await assertToolNameAvailable(ctx, parsed.name, base);
      // Same kind of rule, same ADVISORY footing: whether a relative template has a credential base
      // URL to take its host from is a question about a vault row, so the apply's own check inside
      // the transaction is the authority and this one only stops the preview approving a tool the
      // apply refuses.
      await assertToolRelativeTemplateResolvable(
        ctx,
        parsed.urlTemplate,
        input.credentialRef,
        base,
      );
      // NOTE: `{{conversation_ref}}` names its integration, asked of the canonical shapes the apply
      // would store.
      await assertToolConversationRefResolvable(
        ctx,
        { ...toolShapesOf(input), ...norm.shapes },
        parsed.conversationRefIntegrationId,
        base,
      );
      // INSIDE the branch, like the two checks above it and for a plainer reason: the apply
      // recomputes this from the row it wrote, so reading the vault out here was a scoped
      // transaction whose answer that path throws away.
      const wiring = await credentialWiringWarning(
        ctx,
        base,
        input.credentialRef,
        input.method,
        toolShapesOf(input),
        input.ackEnabled ? input.ackMessage : null,
        input.allowedHosts,
      );
      const all = [...norm.warnings, ...wiring];
      return ok({
        dryRun: true,
        action: "create",
        resource: "tool",
        // `parsed` first: the name is canonicalized on the way in, so echoing the spelling the
        // caller typed would promise a row stored under a different one.
        preview: { ...input, ...parsed, ...norm.shapes },
        ...(all.length > 0 ? { warnings: all } : {}),
      });
    }
    const created = await createToolDefinition(ctx, input, base);
    const target = `tool:${created.id}`;
    // Recomputed from the row that was CREATED, for the reason the update path gives: the
    // preview's vault read happens before the write, and a credential's param name or base URL can
    // change in between — the response would then describe wiring that is already not the wiring.
    const appliedWiring = await appliedWiringWarning(
      ctx,
      base,
      created.credentialRef,
      created.method,
      toolShapesOf(created),
      created.ackEnabled ? created.ackMessage : null,
      created.allowedHosts,
    );
    const applied = [...norm.warnings, ...appliedWiring];
    return ok({
      dryRun: false,
      applied: true,
      target,
      tool: created,
      ...(applied.length > 0 ? { warnings: applied } : {}),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function toolUpdate(
  principal: VerifiedToken,
  args: ToolWriteArgs & { tool_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.tool_id, "tool_id");
  if (typeof id !== "bigint") return id;
  const built = await buildToolPatch(ctx, args, base);
  if ("fail" in built) return built.fail;
  if (Object.keys(built.patch).length === 0) {
    return err("no updatable fields provided");
  }
  try {
    const current = await getToolDefinition(ctx, id, base);
    // Preview the canonical form the service will store (JSON-Schema input_schema converted,
    // single-brace {var} normalized against the effective field set) plus probable-typo warnings.
    const norm = normalizeToolShapes(
      {
        urlTemplate: built.patch.urlTemplate,
        query: built.patch.query,
        headers: built.patch.headers,
        body: built.patch.body,
        inputSchema: built.patch.inputSchema,
      },
      {
        urlTemplate: current.urlTemplate,
        query: current.query,
        headers: current.headers,
        body: current.body,
        inputSchema: current.inputSchema,
      },
    );
    const normalizedPatch = {
      ...built.patch,
      ...norm.shapes,
    } as ToolDefinitionUpdate;
    const keys = Object.keys(built.patch) as (keyof ToolDefinitionUpdate)[];
    const beforeProj: Record<string, unknown> = {};
    const afterProj: Record<string, unknown> = {};
    for (const k of keys) {
      beforeProj[k] = (current as unknown as Record<string, unknown>)[k];
      afterProj[k] = normalizedPatch[k];
    }
    const target = `tool:${id}`;
    if (args.dry_run !== false) {
      // The core's questions about a PATCH, advisory here and authoritative inside the apply:
      // the shape (which canonicalizes the name, so the diff shows what is STORED) and, for a
      // rename, name availability. `id` and `current.name` are excluded: keeping your own name is
      // not a collision.
      const parsed = assertToolDefinitionPatchValid(built.patch);
      // The EFFECTIVE pair, patch over stored, judged only when the patch names one of the two —
      // the same condition the apply uses, so the two halves agree on when the question applies as
      // well as on the answer.
      if (
        parsed.urlTemplate !== undefined ||
        built.patch.credentialRef !== undefined
      ) {
        await assertToolRelativeTemplateResolvable(
          ctx,
          parsed.urlTemplate ?? current.urlTemplate,
          built.patch.credentialRef !== undefined
            ? built.patch.credentialRef
            : current.credentialRef,
          base,
        );
      }
      if (parsed.name !== undefined) {
        await assertToolNameAvailable(ctx, parsed.name, base, id, current.name);
        afterProj.name = parsed.name;
      }
      // NOTE: the effective pair for `{{conversation_ref}}`, under the same condition the apply
      // judges it: only when the patch names a template or the integration.
      if (
        parsed.conversationRefIntegrationId !== undefined ||
        parsed.urlTemplate !== undefined ||
        parsed.headers !== undefined ||
        parsed.query !== undefined ||
        parsed.body !== undefined ||
        parsed.inputSchema !== undefined
      ) {
        await assertToolConversationRefResolvable(
          ctx,
          { ...toolShapesOf(current), ...norm.shapes },
          parsed.conversationRefIntegrationId !== undefined
            ? parsed.conversationRefIntegrationId
            : current.conversationRefIntegrationId,
          base,
        );
      }
      // The EFFECTIVE row, patch over stored, because a patch that only attaches a credential
      // says nothing about the templates and a patch that only rewrites a template says nothing
      // about the credential. Judging either half alone is how this warning would fire on a tool
      // that is wired and stay silent on one that is not.
      //
      // And INSIDE the branch: the apply recomputes it from the row it wrote, so out here it was a
      // scoped vault transaction whose answer that path throws away.
      const wiring = await credentialWiringWarning(
        ctx,
        base,
        built.patch.credentialRef !== undefined
          ? built.patch.credentialRef
          : current.credentialRef,
        built.patch.method ?? current.method,
        { ...toolShapesOf(current), ...toolShapesOf(built.patch) },
        // NOTE: `!== undefined` and not `??`: `ack_message: null` CLEARS the message, and reading a
        // cleared field as "unchanged" restored the ack the applied row will not have.
        (built.patch.ackEnabled ?? current.ackEnabled)
          ? built.patch.ackMessage !== undefined
            ? built.patch.ackMessage
            : current.ackMessage
          : null,
        built.patch.allowedHosts ?? current.allowedHosts,
      );
      const all = [...norm.warnings, ...wiring];
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, afterProj),
        ...(all.length > 0 ? { warnings: all } : {}),
      });
    }
    const updated = await updateToolDefinition(ctx, id, built.patch, base);
    const appliedProj: Record<string, unknown> = {};
    for (const k of keys)
      appliedProj[k] = (updated as unknown as Record<string, unknown>)[k];
    // Recomputed from the row the write RETURNED, like `appliedProj` beside it, rather than
    // reused from the preview. The preview reads outside the write's transaction, so a second
    // administrator can change the credential or a template in between — and the response would
    // then report a diff of the row that was written next to a warning about the row that was read.
    // No test distinguishes the two: the divergence needs a write landing inside that window, and
    // the consistency with the line above is the argument.
    const appliedWiring = await appliedWiringWarning(
      ctx,
      base,
      updated.credentialRef,
      updated.method,
      toolShapesOf(updated),
      updated.ackEnabled ? updated.ackMessage : null,
      updated.allowedHosts,
    );
    const applied = [...norm.warnings, ...appliedWiring];
    return ok({
      dryRun: false,
      applied: true,
      target,
      diff: diffFields(beforeProj, appliedProj),
      ...(applied.length > 0 ? { warnings: applied } : {}),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function toolDelete(
  principal: VerifiedToken,
  args: { tool_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.tool_id, "tool_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getToolDefinition(ctx, id, base);
    const target = `tool:${id}`;
    const beforeProj = { id: current.id, name: current.name };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteToolDefinition(ctx, id, base);
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// ── MCP server connections ──

export interface McpConnectionWriteArgs {
  name?: string;
  transport?: "streamableHttp" | "sse" | "stdio";
  url?: string | null;
  command?: string | null;
  credential_ref?: string | null;
  headers?: Record<string, unknown>;
  enabled?: boolean;
}

async function buildConnectionPatch(
  ctx: TenantContext,
  args: McpConnectionWriteArgs,
  base: Parameters<typeof resolveSecretRef>[2],
): Promise<{ patch: McpConnectionUpdate } | { fail: WriteResult }> {
  const patch: McpConnectionUpdate = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.transport !== undefined) patch.transport = args.transport;
  if (args.url !== undefined) patch.url = args.url;
  if (args.command !== undefined) patch.command = args.command;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.headers !== undefined) patch.headers = args.headers;
  if (args.credential_ref !== undefined) {
    if (args.credential_ref === null || args.credential_ref === "") {
      patch.credentialRef = null;
    } else {
      const resolved = await resolveSecretRef(ctx, args.credential_ref, base);
      if ("fail" in resolved) return { fail: resolved.fail };
      patch.credentialRef = resolved.ref;
    }
  }
  return { patch };
}

export async function mcpConnectionCreate(
  principal: VerifiedToken,
  args: McpConnectionWriteArgs & { dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  if (!args.name) return err("name is required");
  if (!args.transport) return err("transport is required");
  const built = await buildConnectionPatch(ctx, args, base);
  if ("fail" in built) return built.fail;
  const input = {
    ...built.patch,
    name: args.name,
    transport: args.transport,
  } as McpConnectionCreate;
  try {
    if (args.dry_run !== false) {
      // The core's own question, asked INSIDE the branch because the apply reaches the core,
      // which asks it again; above the branch it would be a second lookup that can disagree.
      const parsed = await assertMcpConnectionCreatable(input);
      await assertMcpConnectionHeadersFit(
        ctx,
        {
          headers: parsed.headers ?? {},
          transport: parsed.transport,
          credentialRef: parsed.credentialRef ?? null,
        },
        base,
      );
      // NOTE: ADVISORY: it reads outside the apply's transaction, so the name can be taken
      // meanwhile. The unique index inside the write is what guarantees one name per row.
      await assertMcpConnectionNameAvailable(ctx, parsed.name, base);
      return ok({
        dryRun: true,
        action: "create",
        resource: "mcp_connection",
        preview: input,
      });
    }
    const created = await createMcpConnection(ctx, input, base);
    const target = `mcp_connection:${created.id}`;
    return ok({ dryRun: false, applied: true, target, connection: created });
  } catch (e) {
    return failOf(e);
  }
}

export async function mcpConnectionUpdate(
  principal: VerifiedToken,
  args: McpConnectionWriteArgs & { connection_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.connection_id, "connection_id");
  if (typeof id !== "bigint") return id;
  const built = await buildConnectionPatch(ctx, args, base);
  if ("fail" in built) return built.fail;
  if (Object.keys(built.patch).length === 0) {
    return err("no updatable fields provided");
  }
  try {
    const current = await getMcpConnection(ctx, id, base);
    const keys = Object.keys(built.patch) as (keyof McpConnectionUpdate)[];
    const beforeProj: Record<string, unknown> = {};
    const afterProj: Record<string, unknown> = {};
    for (const k of keys) {
      beforeProj[k] = (current as unknown as Record<string, unknown>)[k];
      afterProj[k] = built.patch[k];
    }
    const target = `mcp_connection:${id}`;
    if (args.dry_run !== false) {
      // NOTE: the core's own question, asked INSIDE the branch because the apply asks it again.
      // Judged against `current`, the row the diff was rendered from: re-reading could let a
      // concurrent write land between the two, and the preview would approve one state while
      // describing another.
      await assertMcpConnectionUpdatable(built.patch, current);
      await assertMcpConnectionHeadersFit(
        ctx,
        {
          headers: built.patch.headers ?? current.headers,
          transport: built.patch.transport ?? current.transport,
          credentialRef:
            built.patch.credentialRef !== undefined
              ? built.patch.credentialRef
              : current.credentialRef,
        },
        base,
      );
      // NOTE: ADVISORY, and only on a rename. `exceptId` keeps a connection's own name from reading
      // as a collision.
      if (built.patch.name !== undefined) {
        await assertMcpConnectionNameAvailable(ctx, built.patch.name, base, id);
      }
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, afterProj),
      });
    }
    const updated = await updateMcpConnection(ctx, id, built.patch, base);
    const appliedProj: Record<string, unknown> = {};
    for (const k of keys)
      appliedProj[k] = (updated as unknown as Record<string, unknown>)[k];
    return ok({
      dryRun: false,
      applied: true,
      target,
      diff: diffFields(beforeProj, appliedProj),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function mcpConnectionDelete(
  principal: VerifiedToken,
  args: { connection_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.connection_id, "connection_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getMcpConnection(ctx, id, base);
    const target = `mcp_connection:${id}`;
    const beforeProj = { id: current.id, name: current.name };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteMcpConnection(ctx, id, base);
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// Discover the tools a remote MCP server exposes (connects using the connection's stored credential,
// resolved server-side). Read-only on our side, so it runs directly (no dry-run); requires mcp:write
// because it exercises the connection's credential.
export async function mcpConnectionDiscover(
  principal: VerifiedToken,
  args: { connection_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.connection_id, "connection_id");
  if (typeof id !== "bigint") return id;
  try {
    const discovered = await discoverMcpTools(ctx, id, base);
    return ok({
      tools: discovered.tools,
      instructions: discovered.instructions,
    });
  } catch (e) {
    return failOf(e);
  }
}
