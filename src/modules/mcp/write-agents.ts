import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { normalizeExpectedStatuses } from "@/graph/tools/http-status";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { configHealthAfterWrite } from "@/modules/agents/config-health-read";
import type { AgentMode } from "@/modules/agents/mode";
import {
  type AgentCreate,
  type AgentUpdate,
  assertAgentCreatable,
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
  readResponseTemplateResult,
  storableResponseTemplate,
} from "@/modules/tool-definitions/response-template";
import {
  assertToolDefinitionCreatable,
  assertToolNameAvailable,
  createToolDefinition,
  deleteToolDefinition,
  getToolDefinition,
  type ToolDefinitionCreate,
  type ToolDefinitionUpdate,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import { readVaultRefFacts } from "@/modules/vault/service";
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
      // NOTE: the core's own question, asked before the preview answers it. It sits INSIDE the
      // branch rather than above it because the apply reaches the core, which asks it again —
      // and several of these read a row or resolve DNS, so above the branch is a second lookup
      // that can even disagree with the first (#490).
      const { businessHoursId, followUpHoursId } = assertAgentCreatable(input);
      // ADVISORY, unlike the line above it: this one READS. It passes the ids that line already
      // PARSED rather than re-reading `input`, so the preview and the write cannot end up asking
      // about different rows (#490).
      await assertSchedulesExist(ctx, businessHoursId, followUpHoursId, base);
      // ADVISORY too, and it asks the OTHER thing `createAgent` reads for: that every credential
      // ref in the payload resolves AND that an entry of that kind can serve the field. A
      // `google_oauth` entry holds an object where eight of these nine fields hand a plain string
      // to a provider SDK, so "it exists" is not the question (#471, #490).
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
      // NOTE: this preview had NO preflight, and its fence row hid that — the row passes an agent
      // id that does not exist, so it proved the not-found path and every rule `updateAgent`
      // applies after it went unasked. Measured: an empty name, a schedule id naming no row, and a
      // credentialRef whose kind cannot serve the field all previewed ok and applied refused (#490).
      const { rest, businessHoursId, followUpHoursId } =
        assertAgentUpdatable(patch);
      await assertSchedulesExist(ctx, businessHoursId, followUpHoursId, base);
      // Against the STORED bag, not `{}`: on an update the question is whether this write CHANGES
      // a ref, and `current` is the same row the diff above was rendered from.
      await assertCredentialRefsUsable(ctx, rest, base, {
        modelConfig: current.modelConfig,
      });
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
    return ok({
      dryRun: true,
      action: "import",
      agentName: exp.agent.name,
      willCreate: { enabled: false, mode: "test" },
      credentialsNeeded: exp.agent.credentials.map((c) => ({
        name: c.name,
        kind: c.kind,
      })),
      // Every component array the apply can CREATE, counted. A preview that omits one approves a
      // write the operator was never shown: the apply reuses or creates the templates before it
      // assigns the grants, so leaving them out here is the dry run answering about a different
      // operation than the one it is standing in for.
      components: {
        httpTools: comps?.httpTools.length ?? 0,
        mcpServers: comps?.mcpServers.length ?? 0,
        integrations: comps?.integrations.length ?? 0,
        knowledgeBases: comps?.knowledgeBases.length ?? 0,
        documentTemplates: comps?.documentTemplates?.length ?? 0,
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
    knowledgeBaseIds: g.knowledgeBaseIds ?? [],
    enabledTools: g.enabledTools ?? [],
  }));
  try {
    const current = await getAgentToolSelections(ctx, id, base);
    const target = `agent:${id}`;
    if (args.dry_run !== false) {
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
    // NOTE: refused here and not only in the service, for the reason the body check below gives: a
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
    // NOTE: refused here and not only in the service, for the same reason the expected_statuses
    // line below gives: a dry run never calls the service, so a body the apply would reject was
    // previewed back intact and with no warning — which is how the shape reached production in the
    // first place (issue #150).
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

// The unused-credential warning for one tool write, with the vault read it needs. Called once per
// write and spread into BOTH halves of the answer, like `norm.warnings` beside it: a preview that
// stays quiet about wiring the apply will not fix is the preview promising something away (#490).
//
// `shapes` is the EFFECTIVE row — patch over stored — and RAW: `unusedCredentialWarning` runs the
// normalization itself, because `buildHttpTool` runs it too and a legacy single-brace `{secret}`
// sitting in a stored template is therefore sent. Normalizing only the patch, as the preview does
// for its own purposes, would leave the stored half raw and report a working tool as unwired.
// The same read AFTER the write has committed, and it can never take the write down with it. The
// rule is docs/mcp.md's, for config-health: "the write had already committed, so a rejection is
// reported rather than raised". A pool timeout on this advisory lookup would otherwise answer
// `ok: false` for a tool that exists, and the caller's retry would meet a name conflict.
//
// Spelled out rather than forwarded with `...args`: the #502 fence reads these call sites for the
// client they hand on, and a spread names none — it caught this one.
async function appliedWiringWarning(
  ctx: TenantContext,
  base: PrismaClient,
  credentialRef: string | null | undefined,
  method: string | null | undefined,
  shapes: ToolShapePatch,
  ackMessage: string | null | undefined,
): Promise<string[]> {
  try {
    return await credentialWiringWarning(
      ctx,
      base,
      credentialRef,
      method,
      shapes,
      ackMessage,
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
    { kind: facts.kind, paramName: facts.paramName, baseUrl: facts.baseUrl },
    method,
    shapes,
    { ackMessage },
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
  // NOTE: surface what the service will canonicalize (JSON-Schema input_schema, single-brace
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
      // NOTE: the core's own question, asked before the preview answers it. It sits INSIDE the
      // branch rather than above it because the apply reaches the core, which asks it again —
      // and several of these read a row or resolve DNS, so above the branch is a second lookup
      // that can even disagree with the first (#490).
      const parsed = assertToolDefinitionCreatable(input);
      // ADVISORY, unlike the line above it: this one READS, outside the transaction the apply
      // will write in, so a free name here can be taken before the apply arrives. It answers the
      // collision that actually happens (a name the operator already used), and the unique index
      // inside the write remains what guarantees one name to one row (#490).
      await assertToolNameAvailable(ctx, parsed.name, base);
      // NOTE: INSIDE the branch, like the two checks above it and for a plainer reason: the apply
      // recomputes this from the row it wrote, so reading the vault out here was a scoped
      // transaction whose answer that path throws away.
      const wiring = await credentialWiringWarning(
        ctx,
        base,
        input.credentialRef,
        input.method,
        toolShapesOf(input),
        input.ackEnabled ? input.ackMessage : null,
      );
      const all = [...norm.warnings, ...wiring];
      return ok({
        dryRun: true,
        action: "create",
        resource: "tool",
        preview: { ...input, ...norm.shapes },
        ...(all.length > 0 ? { warnings: all } : {}),
      });
    }
    const created = await createToolDefinition(ctx, input, base);
    const target = `tool:${created.id}`;
    // NOTE: recomputed from the row that was CREATED, for the reason the update path gives: the
    // preview's vault read happens before the write, and a credential's param name or base URL can
    // change in between — the response would then describe wiring that is already not the wiring.
    const appliedWiring = await appliedWiringWarning(
      ctx,
      base,
      created.credentialRef,
      created.method,
      toolShapesOf(created),
      created.ackEnabled ? created.ackMessage : null,
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
    // NOTE: preview the canonical form the service will store (JSON-Schema input_schema converted,
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
      // NOTE: the EFFECTIVE row, patch over stored, because a patch that only attaches a credential
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
    // NOTE: recomputed from the row the write RETURNED, like `appliedProj` beside it, rather than
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
      // NOTE: the core's own question, asked before the preview answers it. It sits INSIDE the
      // branch rather than above it because the apply reaches the core, which asks it again —
      // and several of these read a row or resolve DNS, so above the branch is a second lookup
      // that can even disagree with the first (#490).
      const parsed = await assertMcpConnectionCreatable(input);
      // ADVISORY, unlike the line above it: this one READS, outside the transaction the apply
      // will write in, so a free name here can be taken before the apply arrives. It answers the
      // collision that actually happens (a name the operator already used), and the unique index
      // inside the write remains what guarantees one name to one row (#490).
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
      // NOTE: the core's own question, asked before the preview answers it. It sits INSIDE the
      // branch rather than above it because the apply reaches the core, which asks it again —
      // and several of these read a row or resolve DNS, so above the branch is a second lookup
      // that can even disagree with the first (#490).
      // NOTE: judged against `current` — the SAME row the diff above was rendered from. Reading it
      // again here would let a concurrent write land between the two, and the preview would then
      // approve one state while describing a diff against another.
      await assertMcpConnectionUpdatable(built.patch, current);
      // ADVISORY, and only when the patch actually renames. `exceptId` is what keeps a connection
      // keeping its own name from being read as a collision (#490).
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
