import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { getAgent, getAgentToolSelections } from "@/modules/agents/service";
import type { MetricsFilter } from "@/modules/analytics/service";
import {
  getInstanceMetrics,
  getKpis,
  getTimeseries,
} from "@/modules/analytics/service";
import { listApiKeys } from "@/modules/api-keys/service";
import { listAudit } from "@/modules/audit/service";
import { listBusinessHours } from "@/modules/business-hours/service";
import {
  getChatwootDeployment,
  getChatwootInstance,
  listInboxes,
} from "@/modules/chatwoot/management";
import {
  getConversationDetail,
  getConversationMessages,
} from "@/modules/conversations/service";
import { documentAuthoringSchema } from "@/modules/documents/blocks";
import { listIssuedDocuments } from "@/modules/documents/issue";
import { documentStarters } from "@/modules/documents/starters";
import {
  getDocumentTemplate,
  listDocumentTemplates,
} from "@/modules/documents/templates";
import {
  COMPANY_TOKEN_ALIASES,
  DOCUMENT_TOKEN_ALIASES,
  RESERVED_TOKEN_PREFIXES,
} from "@/modules/documents/tokens";
import {
  experimentResults,
  getExperiment,
  listExperiments,
} from "@/modules/experiments/service";
import { listAlertChannels } from "@/modules/flowlog/channels";
import { exportExecutionLogs } from "@/modules/flowlog/export";
import { listExecutionLogs } from "@/modules/flowlog/read";
import { parseIsoInstant } from "@/modules/flowlog/settings";
import { FLOW_LEVELS, FLOW_STAGES } from "@/modules/flowlog/stages";
import {
  listCatalog,
  listIntegrationInstances,
} from "@/modules/integrations/service";
import { listMcpConnections } from "@/modules/mcp-connections/service";
import { listDocuments } from "@/modules/rag/documents";
import {
  listKnowledgeBases,
  listPendingApprovals,
  searchKnowledge,
} from "@/modules/rag/service";
import { getTenantSettings } from "@/modules/tenant-settings/service";
import {
  getToolDefinition,
  listToolDefinitions,
} from "@/modules/tool-definitions/service";
import {
  listVaultEntryInfos,
  vaultNameByRef,
  vaultReferences,
} from "@/modules/vault/service";
import {
  getWebhookDelivery,
  listWebhookDeliveries,
} from "@/modules/webhooks/outbound/deliveries";
import { OUTBOUND_EVENTS } from "@/modules/webhooks/outbound/events";
import { listWebhookSubscriptions } from "@/modules/webhooks/outbound/subscriptions";
import type { VerifiedToken } from "./oauth/tokens";
import {
  err,
  ok,
  parseMcpId,
  readGate,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP READ tools — the read half of the expanded admin surface, all gated by the same fence as
// write reads (mcp:read scope + a tenant target). Each tool projects a tenant-scoped service and
// serializes bigints to strings (JSON.stringify throws on a bigint). Secret-bearing fields are
// never returned: services redact them (Chatwoot adminToken → hasAdminToken, alert URL → urlMasked,
// API key → prefix), and credentialRef values are projected back to vault entry NAMES, never values.

const sid = (v: bigint): string => v.toString();
const sidn = (v: bigint | null): string | null =>
  v === null ? null : String(v);

// Parse a bigint id arg, mapping a bad value to a uniform error.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

// ── agents ──

export async function agentGet(
  principal: VerifiedToken,
  args: { agent_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.agent_id, "agent_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ agent: await getAgent(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function agentToolsGet(
  principal: VerifiedToken,
  args: { agent_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.agent_id, "agent_id");
  if (typeof id !== "bigint") return id;
  try {
    const view = await getAgentToolSelections(ctx, id, base);
    return ok({ grants: view.grants, catalog: view.catalog });
  } catch (e) {
    return failOf(e);
  }
}

// ── tool definitions (HTTP tools) ──

export async function toolList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ tools: await listToolDefinitions(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function toolGet(
  principal: VerifiedToken,
  args: { tool_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.tool_id, "tool_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ tool: await getToolDefinition(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── document templates ──

export async function documentTemplateList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    const templates = await listDocumentTemplates(ctx, base);
    // Blocks are dropped from the LIST: they are the bulk of a template and nobody browsing the list
    // reads them. document_template_get returns the whole thing.
    return ok({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        toolName: t.toolName,
        description: t.description,
        blocks: t.blocks.length,
        fields: t.fields.map(
          (f) => `${f.name}:${f.type}${f.required ? "*" : ""}`,
        ),
        numberPrefix: t.numberPrefix,
        lastNumber: t.lastNumber,
        enabled: t.enabled,
      })),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function documentTemplateGet(
  principal: VerifiedToken,
  args: { document_template_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.document_template_id, "document_template_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ template: await getDocumentTemplate(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

// The block/field/style shapes, as JSON Schema generated from the validator itself, plus the token
// names. Served on demand because publishing it in every tools/list would cost thousands of
// characters per session for a contract only a caller authoring a template needs.
export async function documentTemplateSchema(
  principal: VerifiedToken,
): Promise<WriteResult> {
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  return ok({
    ...documentAuthoringSchema(),
    tokens: {
      company: Object.entries(COMPANY_TOKEN_ALIASES).map(
        ([canonical, alias]) => `{{${canonical}}} / {{${alias}}}`,
      ),
      document: Object.entries(DOCUMENT_TOKEN_ALIASES).map(
        ([canonical, alias]) => `{{${canonical}}} / {{${alias}}}`,
      ),
      fields:
        "Any declared field by its own name, e.g. {{validade}}. A token naming neither a declared field nor a reserved name is refused.",
      reservedPrefixes: [...RESERVED_TOKEN_PREFIXES],
    },
  });
}

export async function documentStarterList(
  principal: VerifiedToken,
  args: { locale?: string } = {},
): Promise<WriteResult> {
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const starters = documentStarters(
    args.locale === "en-US" ? "en-US" : "pt-BR",
  );
  return ok({
    starters: starters.map((s) => ({
      key: s.key,
      name: s.name,
      description: s.description,
      blocks: s.blocks.length,
      fields: s.fields.map(
        (f) => `${f.name}:${f.type}${f.required ? "*" : ""}`,
      ),
    })),
  });
}

export async function issuedDocumentList(
  principal: VerifiedToken,
  args: { template_id?: string; thread_id?: string; limit?: number } = {},
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  let templateId: bigint | undefined;
  // `!== undefined`, not truthiness: an explicitly empty template_id is a malformed NARROWING
  // filter, and treating it as absent answers the tenant's whole recent list — the widest possible
  // answer to the narrowest possible question. Parsed and refused instead.
  if (args.template_id !== undefined) {
    const parsed = parseMcpId(args.template_id, "template_id");
    if (typeof parsed !== "bigint") return parsed;
    templateId = parsed;
  }
  try {
    return ok({
      documents: await listIssuedDocuments(
        ctx,
        { templateId, threadId: args.thread_id, limit: args.limit },
        base,
      ),
    });
  } catch (e) {
    return failOf(e);
  }
}

// ── MCP connections ──

export async function mcpConnectionList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ connections: await listMcpConnections(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── integrations ──

export async function integrationList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ integrations: await listIntegrationInstances(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function integrationCatalog(
  principal: VerifiedToken,
): Promise<WriteResult> {
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  return ok({ catalog: listCatalog() });
}

// ── knowledge (RAG) ──

export async function knowledgeList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    const bases = await listKnowledgeBases(ctx, base);
    return ok({
      knowledgeBases: bases.map((b) => ({ ...b, id: sid(b.id) })),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeSearch(
  principal: VerifiedToken,
  args: { query: string; knowledge_base_ids?: string[]; limit?: number },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  let kbIds: bigint[] | undefined;
  if (args.knowledge_base_ids?.length) {
    try {
      // Through the same parser as every other id: `BigInt(" 7 ")` is 7n, so a padded entry here
      // silently narrows to a knowledge base the caller did not name.
      kbIds = args.knowledge_base_ids.map((raw) => {
        const parsed = parseMcpId(raw, "knowledge_base_ids");
        if (typeof parsed !== "bigint") throw new Error("invalid");
        return parsed;
      });
    } catch {
      return err("invalid knowledge_base_ids");
    }
  }
  try {
    const hits = await searchKnowledge({
      ctx,
      query: args.query,
      knowledgeBaseIds: kbIds,
      limit: args.limit,
      base,
    });
    return ok({
      hits: hits.map((h) => ({
        ...h,
        id: sid(h.id),
        knowledgeBaseId: sid(h.knowledgeBaseId),
        documentId: sid(h.documentId),
      })),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeDocumentsList(
  principal: VerifiedToken,
  args: { knowledge_base_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const kbId = parseMcpId(args.knowledge_base_id, "knowledge_base_id");
  if (typeof kbId !== "bigint") return kbId;
  try {
    const docs = await listDocuments(ctx, kbId, base);
    return ok({ documents: docs.map((d) => ({ ...d, id: sid(d.id) })) });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeApprovalsList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ approvals: await listPendingApprovals(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── Chatwoot instances + inboxes ──

export async function instanceList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok(await getChatwootDeployment(ctx, base));
  } catch (e) {
    return failOf(e);
  }
}

export async function instanceGet(
  principal: VerifiedToken,
  args: { instance_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.instance_id, "instance_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ instance: await getChatwootInstance(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function inboxList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ inboxes: await listInboxes(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── outbound webhooks ──

export async function webhookList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ webhooks: await listWebhookSubscriptions(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function webhookEventsList(
  principal: VerifiedToken,
): Promise<WriteResult> {
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  return ok({ events: [...OUTBOUND_EVENTS] });
}

// ── outbound webhook deliveries ──
// The ledger the worker writes as it delivers. Read-only here; the requeue is a write tool
// (`webhook_delivery_requeue`). The payload never crosses this surface — see `deliveries.ts`.

export interface WebhookDeliveryListArgs {
  status?: string;
  subscription_id?: string;
  event?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export async function webhookDeliveryList(
  principal: VerifiedToken,
  args: WebhookDeliveryListArgs = {},
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  // `!== undefined` on every filter, so an argument the caller SENT as empty is refused by the
  // service instead of being dropped here and widening the page. The truthiness spelling is what
  // makes `status: ""` mean "every status".
  const opts: Parameters<typeof listWebhookDeliveries>[1] = {};
  if (args.status !== undefined) opts.status = args.status;
  if (args.event !== undefined) opts.event = args.event;
  // The same parse the REST filter uses, for the same reason: `new Date` normalises February 30
  // into March 2 and resolves a non-ISO string against the server's timezone, and a filter that
  // silently means something else is worse than one that is refused.
  for (const key of ["since", "until"] as const) {
    const raw = args[key];
    if (raw === undefined) continue;
    const d = parseIsoInstant(raw);
    if (d === null) return err(`invalid ${key}`);
    opts[key] = d;
  }
  if (args.limit !== undefined) opts.limit = args.limit;
  if (args.subscription_id !== undefined) {
    const v = parseMcpId(args.subscription_id, "subscription_id");
    if (typeof v !== "bigint") return v;
    opts.subscriptionId = v;
  }
  if (args.cursor !== undefined) {
    const v = parseMcpId(args.cursor, "cursor");
    if (typeof v !== "bigint") return v;
    opts.cursor = v;
  }
  try {
    const res = await listWebhookDeliveries(ctx, opts, base);
    return ok({ items: res.items, nextCursor: res.nextCursor });
  } catch (e) {
    return failOf(e);
  }
}

export async function webhookDeliveryGet(
  principal: VerifiedToken,
  args: { delivery_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.delivery_id, "delivery_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ delivery: await getWebhookDelivery(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── alert channels ──

export async function alertChannelList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ channels: await listAlertChannels(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function alertStageList(
  principal: VerifiedToken,
): Promise<WriteResult> {
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  return ok({ stages: [...FLOW_STAGES], levels: [...FLOW_LEVELS] });
}

// ── business hours ──

export async function businessHoursList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ businessHours: await listBusinessHours(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── experiments ──

export async function experimentList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    const rows = await listExperiments(ctx, base);
    return ok({
      experiments: rows.map((r) => ({
        ...r,
        id: sid(r.id),
        agentId: sidn(r.agentId),
      })),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function experimentGet(
  principal: VerifiedToken,
  args: { experiment_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.experiment_id, "experiment_id");
  if (typeof id !== "bigint") return id;
  try {
    const r = await getExperiment(ctx, id, base);
    return ok({
      experiment: { ...r, id: sid(r.id), agentId: sidn(r.agentId) },
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function experimentResultsGet(
  principal: VerifiedToken,
  args: { experiment_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.experiment_id, "experiment_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ results: await experimentResults(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── tenant settings (embedding / langfuse) ──

export async function tenantSettingsGet(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    const settings = await getTenantSettings(ctx, base);
    // Project stored vault:<id> refs back to entry NAMES (the MCP contract speaks names).
    const embeddingRef = settings.embedding.credentialRef
      ? await vaultNameByRef(ctx, settings.embedding.credentialRef, base)
      : null;
    const langfuseRef = settings.langfuse.credentialRef
      ? await vaultNameByRef(ctx, settings.langfuse.credentialRef, base)
      : null;
    return ok({
      settings: {
        embedding: { ...settings.embedding, credentialRef: embeddingRef },
        langfuse: { ...settings.langfuse, credentialRef: langfuseRef },
      },
    });
  } catch (e) {
    return failOf(e);
  }
}

// ── vault (names/kinds/usage only — never secret values) ──

export async function vaultList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ entries: await listVaultEntryInfos(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function vaultReferencesGet(
  principal: VerifiedToken,
  args: { vault_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.vault_id, "vault_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ references: await vaultReferences(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── API keys (prefix + metadata only — never the token) ──

export async function apiKeyList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ apiKeys: await listApiKeys(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── audit log ──

export async function auditList(
  principal: VerifiedToken,
  args: { action?: string; limit?: number },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({
      entries: await listAudit(
        ctx,
        { action: args.action, limit: args.limit },
        base,
      ),
    });
  } catch (e) {
    return failOf(e);
  }
}

// ── execution-flow logs ──

export interface LogsQueryArgs {
  since?: string;
  until?: string;
  level?: string;
  stage?: string;
  agent_id?: string;
  conversation_id?: string;
  turn_id?: string;
  source?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export async function logsQuery(
  principal: VerifiedToken,
  args: LogsQueryArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const opts: Parameters<typeof listExecutionLogs>[1] = {};
  if (args.since) opts.since = new Date(args.since);
  if (args.until) opts.until = new Date(args.until);
  if (args.level) opts.level = args.level;
  if (args.stage) opts.stage = args.stage;
  if (args.turn_id) opts.turnId = args.turn_id;
  if (args.source) opts.source = args.source;
  if (args.search) opts.search = args.search;
  if (args.limit !== undefined) opts.limit = args.limit;
  if (args.agent_id) {
    const v = parseMcpId(args.agent_id, "agent_id");
    if (typeof v !== "bigint") return v;
    opts.agentId = v;
  }
  if (args.conversation_id) {
    const v = parseMcpId(args.conversation_id, "conversation_id");
    if (typeof v !== "bigint") return v;
    opts.conversationId = v;
  }
  if (args.cursor) {
    const v = parseMcpId(args.cursor, "cursor");
    if (typeof v !== "bigint") return v;
    opts.cursor = v;
  }
  try {
    const res = await listExecutionLogs(ctx, opts, base);
    return ok({ items: res.items, nextCursor: res.nextCursor });
  } catch (e) {
    return failOf(e);
  }
}

export interface LogsExportArgs {
  since?: string;
  until?: string;
  level?: string;
  stage?: string;
  agent_id?: string;
  conversation_id?: string;
  turn_id?: string;
  source?: string;
  search?: string;
  format?: string;
  max_rows?: number;
}

// An MCP tool result is one blob handed to the model, so default to a smaller slice than the REST/UI
// hard cap — a routine export shouldn't return a multi-MB dump. The caller can raise `max_rows` up to
// the hard cap (the module clamps it).
const MCP_LOG_EXPORT_DEFAULT_ROWS = 1000;

export async function logsExport(
  principal: VerifiedToken,
  args: LogsExportArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const opts: Parameters<typeof exportExecutionLogs>[1] = {
    format: args.format === "json" ? "json" : "csv",
    maxRows: args.max_rows ?? MCP_LOG_EXPORT_DEFAULT_ROWS,
  };
  if (args.since) opts.since = new Date(args.since);
  if (args.until) opts.until = new Date(args.until);
  if (args.level) opts.level = args.level;
  if (args.stage) opts.stage = args.stage;
  if (args.turn_id) opts.turnId = args.turn_id;
  if (args.source) opts.source = args.source;
  if (args.search) opts.search = args.search;
  if (args.agent_id) {
    const v = parseMcpId(args.agent_id, "agent_id");
    if (typeof v !== "bigint") return v;
    opts.agentId = v;
  }
  if (args.conversation_id) {
    const v = parseMcpId(args.conversation_id, "conversation_id");
    if (typeof v !== "bigint") return v;
    opts.conversationId = v;
  }
  try {
    const res = await exportExecutionLogs(ctx, opts, base);
    return ok({
      format: res.format,
      filename: res.filename,
      count: res.count,
      truncated: res.truncated,
      content: res.content,
    });
  } catch (e) {
    return failOf(e);
  }
}

// ── dashboard metrics ──

function metricsFilter(args: {
  since?: string;
  source?: string;
}): MetricsFilter {
  const filter: MetricsFilter = {};
  if (args.since) filter.since = new Date(args.since);
  if (args.source) filter.source = args.source as MetricsFilter["source"];
  return filter;
}

export async function metricsGet(
  principal: VerifiedToken,
  args: { since?: string; source?: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const filter = metricsFilter(args);
  try {
    const [kpis, usage] = await Promise.all([
      getKpis(ctx, filter, base),
      getInstanceMetrics(ctx, filter, base),
    ]);
    return ok({ kpis, usage });
  } catch (e) {
    return failOf(e);
  }
}

export async function metricsTimeseries(
  principal: VerifiedToken,
  args: { since?: string; source?: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const filter = metricsFilter(args);
  try {
    return ok({ points: await getTimeseries(ctx, filter, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── conversations (detail + messages) ──

export async function conversationGet(
  principal: VerifiedToken,
  args: { conversation_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.conversation_id, "conversation_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ conversation: await getConversationDetail(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function conversationMessages(
  principal: VerifiedToken,
  args: { conversation_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.conversation_id, "conversation_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ ...(await getConversationMessages(ctx, id, {}, base)) });
  } catch (e) {
    return failOf(e);
  }
}
