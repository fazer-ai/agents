import basePrisma from "@/api/lib/prisma";
import { normalizeExpectedStatuses } from "@/graph/tools/http-status";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  type AgentCreate,
  type AgentUpdate,
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
  createMcpConnection,
  deleteMcpConnection,
  discoverMcpTools,
  getMcpConnection,
  type McpConnectionCreate,
  type McpConnectionUpdate,
  updateMcpConnection,
} from "@/modules/mcp-connections/service";
import { unsupportedBodyShape } from "@/modules/tool-definitions/body-shape";
import { normalizeToolShapes } from "@/modules/tool-definitions/normalize";
import {
  createToolDefinition,
  deleteToolDefinition,
  getToolDefinition,
  type ToolDefinitionCreate,
  type ToolDefinitionUpdate,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import type { VerifiedToken } from "./oauth/tokens";
import {
  diffFields,
  err,
  gate,
  ok,
  parseMcpId,
  recordMcpAudit,
  resolveSecretRef,
  truncForAudit,
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
  mode?: "test" | "production";
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
      return ok({
        dryRun: true,
        action: "create",
        resource: "agent",
        preview: input,
      });
    }
    const created = await createAgent(ctx, input, base);
    const target = `agent:${created.id}`;
    const afterProj = {
      id: created.id,
      name: created.name,
      enabled: created.enabled,
    };
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.agent_create",
      target,
      before: null,
      after: truncForAudit(afterProj),
    });
    return ok({ dryRun: false, applied: true, target, agent: created });
  } catch (e) {
    return failOf(e);
  }
}

export interface AgentUpdateArgs {
  agent_id: string;
  name?: string;
  enabled?: boolean;
  mode?: "test" | "production";
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
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.agent_update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit(appliedProj),
    });
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
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.agent_clone",
      target: `agent:${clone.id}`,
      before: null,
      after: truncForAudit({
        id: clone.id,
        name: clone.name,
        clonedFrom: source.id,
      }),
    });
    return ok({ dryRun: false, applied: true, agent: clone });
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
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.agent_import",
      target: `agent:${agent.id}`,
      before: null,
      after: truncForAudit({
        id: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        mode: agent.mode,
      }),
    });
    return ok({ dryRun: false, applied: true, agent, warnings });
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
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.agent_delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
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
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.agent_tools_set",
      target,
      before: truncForAudit({ grants: current.grants }),
      after: truncForAudit({ grants: view.grants }),
    });
    return ok({ dryRun: false, applied: true, target, grants: view.grants });
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
async function buildToolPatch(
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
  if (args.output_schema !== undefined) patch.outputSchema = args.output_schema;
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
  const warnings = norm.warnings.length > 0 ? { warnings: norm.warnings } : {};
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "create",
        resource: "tool",
        preview: { ...input, ...norm.shapes },
        ...warnings,
      });
    }
    const created = await createToolDefinition(ctx, input, base);
    const target = `tool:${created.id}`;
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.tool_create",
      target,
      before: null,
      after: truncForAudit({ id: created.id, name: created.name }),
    });
    return ok({
      dryRun: false,
      applied: true,
      target,
      tool: created,
      ...warnings,
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
    const warnings =
      norm.warnings.length > 0 ? { warnings: norm.warnings } : {};
    const keys = Object.keys(built.patch) as (keyof ToolDefinitionUpdate)[];
    const beforeProj: Record<string, unknown> = {};
    const afterProj: Record<string, unknown> = {};
    for (const k of keys) {
      beforeProj[k] = (current as unknown as Record<string, unknown>)[k];
      afterProj[k] = normalizedPatch[k];
    }
    const target = `tool:${id}`;
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, afterProj),
        ...warnings,
      });
    }
    const updated = await updateToolDefinition(ctx, id, built.patch, base);
    const appliedProj: Record<string, unknown> = {};
    for (const k of keys)
      appliedProj[k] = (updated as unknown as Record<string, unknown>)[k];
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.tool_update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit(appliedProj),
    });
    return ok({
      dryRun: false,
      applied: true,
      target,
      diff: diffFields(beforeProj, appliedProj),
      ...warnings,
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
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.tool_delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
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
      return ok({
        dryRun: true,
        action: "create",
        resource: "mcp_connection",
        preview: input,
      });
    }
    const created = await createMcpConnection(ctx, input, base);
    const target = `mcp_connection:${created.id}`;
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.mcp_connection_create",
      target,
      before: null,
      after: truncForAudit({ id: created.id, name: created.name }),
    });
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
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.mcp_connection_update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit(appliedProj),
    });
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
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.mcp_connection_delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
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
