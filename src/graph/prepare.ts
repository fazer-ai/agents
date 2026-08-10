import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import config from "@/config";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { readLimitsConfig } from "@/modules/agents/limits";
import { readToolGuidance } from "@/modules/agents/tool-guidance";
import {
  buildAppointmentContextSection,
  loadAppointmentContext,
} from "@/modules/appointments/context";
import {
  cancelAppointmentReminders,
  enqueueAppointmentReminders,
} from "@/modules/appointments/reminders";
import { parseWindows, type WindowSpec } from "@/modules/business-hours/hours";
import {
  attributeBagsFrom,
  buildAttributeContextSection,
  isAttributeContextEmpty,
  readAttributeContextConfig,
} from "@/modules/chatwoot/attributes";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  type KanbanContext,
  loadKanbanContext,
} from "@/modules/chatwoot/kanban";
import {
  type ChatwootVocab,
  loadChatwootVocab,
} from "@/modules/chatwoot/vocab";
import { resolveVariantOverride } from "@/modules/experiments/service";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import {
  type GuardrailsConfig,
  readGuardrailsConfig,
} from "@/modules/guardrails/settings";
import {
  type HandoffConfig,
  readHandoffConfig,
} from "@/modules/handoff/settings";
import {
  type HandoffTargets,
  loadHandoffTargets,
} from "@/modules/handoff/targets";
import {
  buildToolpackTools,
  type IntegrationSelection,
  type SideEffectErrorReporter,
} from "@/modules/integrations/toolpacks";
import { type KanbanConfig, readKanbanConfig } from "@/modules/kanban/settings";
import {
  readServiceWindowConfig,
  type ServiceWindowConfig,
} from "@/modules/service-window/service";
import { readSplitConfig, type SplitConfig } from "@/modules/split/service";
import { readTtsConfig, type TtsConfig } from "@/modules/tts/settings";
import { ensureFreshGoogleAccessToken } from "@/modules/vault/google-oauth";
import { ensureFreshMcpAccessToken } from "@/modules/vault/mcp-oauth";
import { tryResolveVaultEntry } from "@/modules/vault/service";
import { chatwootThreadId, getCheckpointer } from "./checkpointer";
import { buildAgentGraph } from "./graph";
import {
  createChatModel,
  type ModelConfig,
  parseModelConfig,
  type ResolvedModelConfig,
} from "./models";
import {
  buildLangfuseHandler,
  buildToolTraceMetadata,
  type LangfuseConfig,
  resolveLangfuseConfig,
} from "./observability";
import {
  buildPromptVars,
  composeSystemPrompt,
  interpolatePromptVars,
} from "./prompt";
import { DEFAULT_TIMEZONE, zonedWallClockToInstant } from "./time";
import {
  buildHttpTools,
  type LoadedHttpToolDef,
  loadToolSelections,
  type RagConfig,
} from "./tools/assemble";
import type { NativeToolName } from "./tools/catalog";
import {
  buildMcpContextSection,
  loadMcpToolsForAgent,
  type McpLoadDeps,
  type McpSelection,
} from "./tools/mcp";
import { buildRagTools } from "./tools/rag";
import { UsageCapture, type UsagePersist, type UsageSource } from "./usage";

// Shared agent-invocation plumbing used by BOTH entry points: runAgentTurn (incoming customer
// message) and runAgentNudge (inbound domain event). Loading is a short scoped read (DB only);
// tool/client/MCP I/O happens OUTSIDE the tx. Keeping this in one place means the two paths build
// identical models, tools, cost capture, and tracing.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Resolves a credential ref into the string that gets injected (bearer/header/etc). For most kinds
// this is the stored string secret. For the managed-OAuth kinds (`google_oauth`, `mcp_oauth`) the
// stored value is a JSON object, so we auto-refresh and return the fresh access token (the bearer
// value). Returns null when the entry is missing. The refresh paths do their own scoped reads/writes
// + a refresh network call OUTSIDE any caller tx, so this must not be invoked inside one.
async function resolveInjectableCredential(
  base: PrismaClient,
  tenantId: bigint,
  ref: string,
): Promise<string | null> {
  const entry = await runScopedOn(base, sysCtx(tenantId), (db) =>
    tryResolveVaultEntry<unknown>(db, ref),
  );
  if (!entry) return null;
  if (entry.kind === "google_oauth" || entry.kind === "mcp_oauth") {
    const id = ref.startsWith("vault:")
      ? BigInt(ref.slice("vault:".length))
      : null;
    if (id === null) return null;
    return entry.kind === "mcp_oauth"
      ? ensureFreshMcpAccessToken(sysCtx(tenantId), id, base)
      : ensureFreshGoogleAccessToken(sysCtx(tenantId), id, base);
  }
  return typeof entry.secret === "string" ? entry.secret : null;
}

// Optional grounding threshold from agent.settings.grounding.maxDistance (a positive cosine
// distance). Anything malformed → null (no filtering), so a bad setting never silently blinds RAG.
function readMaxDistance(settings: unknown): number | null {
  if (!settings || typeof settings !== "object") return null;
  const g = (settings as Record<string, unknown>).grounding;
  if (!g || typeof g !== "object") return null;
  const v = (g as Record<string, unknown>).maxDistance;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export interface AgentConfig {
  agentId: bigint;
  // The persona's Chatwoot Agent Bot: numeric id (gate "our bot") + decrypted access token (used to
  // post AS this persona). null when the persona has no bot on this instance yet (e.g. playground).
  agentBotId: number | null;
  agentBotToken: string | null;
  conversationDbId: bigint | null;
  // The DB Inbox.id this conversation belongs to (null in the playground / no mirror row). Feeds
  // the per-inbox usage attribution on LlmUsage.
  inboxDbId: bigint | null;
  // NOTE: the inbox's Chatwoot channel class ("Channel::Api", "Channel::Instagram", …; null when unknown
  // or in the playground). Decides the TTS reply container (pickTtsFormat) — Meta's Instagram
  // messaging refuses WhatsApp's Ogg/Opus.
  channelType: string | null;
  contactDbId: bigint | null;
  // The native Chatwoot ContactInbox id (one contact on one channel) for this conversation. Keys the
  // graph memory thread (see resolveGraphThreadId). null on legacy rows / the playground.
  contactInboxId: number | null;
  systemPrompt: string;
  mc: ModelConfig;
  apiKey: string;
  // baseURL resolved from the credential entry (entry.baseUrl), taking precedence over mc.baseURL.
  credentialBaseUrl: string | null;
  // Guardrails (input/output moderation): config + the guardrails agent's OWN resolved API key /
  // baseURL (its chat model is separate from the main agent's). apiKey "" ⇒ disabled or the
  // credential did not resolve ⇒ the runtime skips analysis (fail-open).
  guardrails: GuardrailsConfig;
  guardrailsApiKey: string;
  guardrailsCredentialBaseUrl: string | null;
  transferWithSummary: boolean;
  nativeToolsAllow?: string[];
  httpToolDefs: LoadedHttpToolDef[];
  mcpSelections: McpSelection[];
  integrationSelections: IntegrationSelection[];
  ragConfig?: RagConfig;
  langfuseCfg: LangfuseConfig | null;
  // TTS (audio reply) config + the contact's stored preference, for the reply-modality decision.
  ttsConfig: TtsConfig;
  contactVoiceReply: boolean | null;
  // Humanized text delivery (split into balloons + typing delay).
  splitConfig: SplitConfig;
  // WhatsApp 24h service-window gate for proactive sends + the contact name for template params.
  serviceWindowConfig: ServiceWindowConfig;
  handoffConfig: HandoffConfig;
  // Per-agent kanban guidance (operator funnel note), surfaced in the kanban_move_card description.
  kanbanConfig: KanbanConfig;
  // Operator-authored guidance for tools whose only config is the note (set_custom_attribute,
  // assign_label, …), keyed by native tool name; merged into the tool descriptions at buildToolset.
  toolGuidance: Partial<Record<NativeToolName, string>>;
  // Conversation/contact context exposed to custom HTTP tools as {{placeholders}} (contact_name,
  // contact_email, …). conversation_id is merged in at buildToolset time (it lives on ctx). Never
  // holds a secret.
  httpToolContext: Record<string, string>;
  contactName: string | null;
  // IANA timezone resolved from the agent's BusinessHours (fallback DEFAULT_TIMEZONE). Feeds the
  // get_current_time native tool and the {{hora_atual}} prompt variable.
  timezone: string;
  // Soft+hard cap on tool executions within one turn (agent.settings.limits.maxToolCalls).
  maxToolCalls: number;
}

export interface LoadAgentArgs {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentId: bigint;
  threadId: string;
}

// Live, NON-persisted config override (playground "edit live" popup): the operator tests unsaved
// prompt/model/settings without writing to the DB. The secret NEVER travels — modelConfig carries
// only a credentialRef, resolved server-side from the vault. Grants are intentionally NOT
// overridable in v1 (they need id/ownership re-validation); the playground uses the saved set.
export interface AgentConfigOverrides {
  systemPrompt?: string;
  modelConfig?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  // Playground tool-simulation: tool name → canned result. Consumed by the playground graph builder
  // (NOT loadAgentConfig, which ignores it). Lets the operator mock any tool's output without a real
  // call. Conversation native tools are simulated regardless; this overrides a tool's result.
  toolMocks?: Record<string, string>;
  // Playground prompt-variable simulation: context-var name → value. The playground has no real
  // conversation, so {{nome_contato}} etc. would resolve empty; this lets the operator inject test
  // values. Keyed by canonical context names (pt-BR or EN alias); fed into buildPromptVars so every
  // alias + the derived first name stay consistent.
  promptVars?: Record<string, string>;
  // Playground time simulation: an offset-less wall-clock ("YYYY-MM-DDTHH:mm") that becomes the
  // "current time" for ALL {{hora_atual}}/{{data_atual}}/… variables, interpreted in the agent's own
  // timezone. Empty/invalid → the real now. Has no effect outside the playground (the real paths
  // never set it).
  promptNow?: string;
}

// Resolves a context-var override (playground) by canonical name (pt-BR or EN alias), falling back
// to the real value. Empty/blank overrides are ignored (the client omits them, but guard anyway).
function pickPromptVar(
  promptVars: Record<string, string> | undefined,
  names: readonly string[],
  fallback: string | null,
): string | null {
  if (promptVars) {
    for (const n of names) {
      const v = promptVars[n];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
  }
  return fallback;
}

// Loads the agent config + tools + tracing + cost-attribution ids (the caller has resolved which
// agentId owns this conversation). Returns null when the agent is missing/disabled or its model
// credential is absent (the runtime treats null as no-agent / silent).
export async function loadAgentConfig(
  db: ScopedDb,
  args: LoadAgentArgs,
  opts: { ignoreDisabled?: boolean; overrides?: AgentConfigOverrides } = {},
): Promise<AgentConfig | null> {
  const agent = await db.agent.findUnique({
    where: { id: args.agentId },
    select: {
      id: true,
      name: true,
      systemPrompt: true,
      modelConfig: true,
      enabled: true,
      transferWithSummary: true,
      settings: true,
      businessHoursId: true,
    },
  });
  if (!agent) return null;
  // The `enabled` toggle gates production auto-replies; the playground tests config regardless.
  if (!agent.enabled && !opts.ignoreDisabled) return null;
  // Live override (playground): effective prompt/model/settings come from the draft when present;
  // everything else (grants, ids, tenant) stays as saved. The secret is still resolved from the
  // vault by credentialRef below — the draft never carries it.
  const ov = opts.overrides;
  const effModelConfig = ov?.modelConfig ?? agent.modelConfig;
  const effSettings = (ov?.settings ?? agent.settings) as typeof agent.settings;
  const mc = parseModelConfig(effModelConfig);
  let apiKey = "";
  let credentialBaseUrl: string | null = null;
  if (mc.credentialRef) {
    const entry = await tryResolveVaultEntry<string>(db, mc.credentialRef);
    if (!entry) {
      // A credentialRef that no longer resolves (deleted / still-pending / a NAME passed where a
      // vault:<id> ref is required) otherwise makes the agent go silent with no trace — the turn just
      // returns null. Log it so the silent no-reply is diagnosable.
      logger.warn(
        "agent %s: model credentialRef %s did not resolve — the agent cannot reply until it is fixed",
        String(args.agentId),
        mc.credentialRef,
      );
      return null;
    }
    apiKey = entry.secret;
    credentialBaseUrl = entry.baseUrl;
  }
  // Guardrails agent's own credential (separate model). Resolved only when enabled; a missing/
  // unresolvable credential leaves the key empty and the runtime skips analysis (fail-open, logged).
  const guardrails = readGuardrailsConfig(effSettings);
  let guardrailsApiKey = "";
  let guardrailsCredentialBaseUrl: string | null = null;
  if (guardrails.enabled && guardrails.credentialRef) {
    const gEntry = await tryResolveVaultEntry<string>(
      db,
      guardrails.credentialRef,
    );
    if (gEntry) {
      guardrailsApiKey = gEntry.secret;
      guardrailsCredentialBaseUrl = gEntry.baseUrl;
    } else {
      logger.warn(
        "agent %s: guardrails credentialRef %s did not resolve — guardrails analysis is skipped",
        String(args.agentId),
        guardrails.credentialRef,
      );
    }
  }
  const attributeContext = readAttributeContextConfig(effSettings);
  const wantsAttributeContext = !isAttributeContextEmpty(attributeContext);
  const conv = await db.conversation.findUnique({
    where: {
      tenantId_chatwootInstanceId_chatwootConversationId: {
        tenantId: args.tenantId,
        chatwootInstanceId: args.instanceId,
        chatwootConversationId: args.conversationId,
      },
    },
    select: {
      id: true,
      contactInboxId: true,
      // NOTE: Mirrored Chatwoot custom attributes (conversation + linked kanban card); the contact's
      // own bag comes from the relation below. Feed the attribute-context block — no API call. The
      // three bags are unbounded jsonb, so they are projected ONLY when the agent selected keys:
      // an agent with the feature off would otherwise pay for them on every single turn.
      customAttributes: wantsAttributeContext,
      kanbanAttributes: wantsAttributeContext,
      contact: {
        select: {
          id: true,
          chatwootContactId: true,
          name: true,
          email: true,
          phone: true,
          voiceReply: true,
          customAttributes: wantsAttributeContext,
        },
      },
      inbox: {
        select: {
          id: true,
          chatwootInboxId: true,
          name: true,
          channelType: true,
        },
      },
    },
  });
  // The persona's own Chatwoot Agent Bot for this instance (id for the gate + token to post AS it).
  const bot = await db.chatwootAgentBot.findUnique({
    where: {
      tenantId_chatwootInstanceId_agentId: {
        tenantId: args.tenantId,
        chatwootInstanceId: args.instanceId,
        agentId: args.agentId,
      },
    },
    select: { chatwootAgentBotId: true, accessToken: true },
  });
  // Timezone for the clock (get_current_time tool + {{hora_atual}} var): the agent's BusinessHours,
  // falling back to the product default. A single small scoped read when configured.
  let timezone = DEFAULT_TIMEZONE;
  if (agent.businessHoursId !== null) {
    const bh = await db.businessHours.findUnique({
      where: { id: agent.businessHoursId },
      select: { timezone: true },
    });
    if (bh?.timezone) timezone = bh.timezone;
  }
  // Company name for the {{nome_empresa}} prompt variable (the tenant's own row under RLS).
  const tenant = await db.tenant.findFirst({ select: { name: true } });
  const langfuseCfg = await resolveLangfuseConfig(db, args.tenantId);
  const sel = await loadToolSelections(db, agent.id);
  // A/B: an active experiment for this agent may override the system prompt for this thread.
  const promptOverride = await resolveVariantOverride(db, {
    tenantId: args.tenantId,
    agentId: agent.id,
    threadId: args.threadId,
  });
  // Grounding is a runtime invariant: when the agent can search the KB, append the grounding
  // directive (don't fabricate / cite / "I don't know" → human) instead of trusting the tenant
  // prompt. The threshold lives in agent.settings (no column on the RAG selection row).
  const grounded = !!sel.ragConfig?.tools.includes("search_knowledge");
  if (sel.ragConfig) {
    const md = readMaxDistance(effSettings);
    if (md != null) sel.ragConfig.maxDistance = md;
  }
  // Interpolate allowlisted context variables ({{nome_contato}}, {{hora_atual}}, …) into the final
  // prompt, with the (customer-controlled) values sanitized. Applied here so BOTH the turn and the
  // nudge paths get identical, injection-bounded substitution. Time variables use the agent's tz.
  // An explicit draft prompt wins over the A/B variant (the operator is testing this exact prompt).
  const systemPrompt = interpolatePromptVars(
    composeSystemPrompt(
      ov?.systemPrompt ?? promptOverride ?? agent.systemPrompt,
      {
        grounded,
      },
    ),
    buildPromptVars({
      contactName: pickPromptVar(
        ov?.promptVars,
        ["nome_contato", "contact_name"],
        conv?.contact?.name ?? null,
      ),
      contactEmail: pickPromptVar(
        ov?.promptVars,
        ["email_contato", "contact_email"],
        conv?.contact?.email ?? null,
      ),
      contactPhone: pickPromptVar(
        ov?.promptVars,
        ["telefone_contato", "contact_phone"],
        conv?.contact?.phone ?? null,
      ),
      inboxName: pickPromptVar(
        ov?.promptVars,
        ["canal", "inbox_name"],
        conv?.inbox?.name ?? null,
      ),
      companyName: pickPromptVar(
        ov?.promptVars,
        ["nome_empresa", "company_name"],
        tenant?.name ?? null,
      ),
      agentName: pickPromptVar(
        ov?.promptVars,
        ["nome_agente", "agent_name"],
        agent.name,
      ),
    }),
    // Playground time simulation: a valid wall-clock override replaces the real now for every time
    // variable, interpreted in the agent's timezone; anything malformed falls back to the real now.
    {
      timezone,
      now: ov?.promptNow
        ? (zonedWallClockToInstant(ov.promptNow, timezone) ?? undefined)
        : undefined,
    },
  );
  // NOTE: The current values of the attribute keys the operator selected, rendered as an XML block
  // APPENDED to the FINISHED prompt — never interpolated, so a stored value containing
  // `{{nome_contato}}` stays literal. Values come from the mirror (webhook-fed), so this costs one
  // already-loaded row and no Chatwoot call. Absent selection / no conversation ⇒ no block.
  const attributeSection =
    conv && wantsAttributeContext
      ? buildAttributeContextSection(
          attributeBagsFrom({
            conversationAttributes: conv.customAttributes,
            contactAttributes: conv.contact?.customAttributes,
            kanbanAttributes: conv.kanbanAttributes,
          }),
          attributeContext,
          undefined,
          !sel.nativeToolsAllow ||
            sel.nativeToolsAllow.includes("set_custom_attribute"),
        )
      : null;
  // NOTE: The LIVE appointments booked in THIS conversation, re-read from the reminder scheduler
  // rows on EVERY turn — including after the last reminder fired (job DONE, start still ahead), the
  // exact turn where the customer replies to it. loadAgentConfig is shared by the reactive turn, the
  // nudge and the debounce flush, so the identity reaches all of them. Playground passes
  // conversationId 0 ⇒ no block. One bounded DB read; never a Google call.
  let appointmentSection: string | null = null;
  if (conv && args.conversationId > 0) {
    const canOperate = sel.integrationSelections.some(
      (s) =>
        s.catalogType === "GOOGLE_CALENDAR" &&
        s.enabledTools.some((t) =>
          [
            "calendar_update_event",
            "calendar_cancel_event",
            "calendar_confirm_appointment",
          ].includes(t),
        ),
    );
    try {
      appointmentSection = buildAppointmentContextSection(
        await loadAppointmentContext(
          db,
          args.tenantId,
          chatwootThreadId(args.tenantId, args.instanceId, args.conversationId),
        ),
        canOperate,
      );
    } catch (e) {
      // NOTE: Optional context fails OPEN — a read error here must not silence the whole turn.
      logger.warn(
        "appointment context load failed: %s",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  const promptSections = [attributeSection, appointmentSection].filter(
    (s): s is string => s !== null,
  );
  return {
    agentId: agent.id,
    agentBotId: bot?.chatwootAgentBotId ?? null,
    agentBotToken: bot ? decryptJson<string>(bot.accessToken) : null,
    conversationDbId: conv?.id ?? null,
    inboxDbId: conv?.inbox?.id ?? null,
    channelType: conv?.inbox?.channelType ?? null,
    contactDbId: conv?.contact?.id ?? null,
    contactInboxId: conv?.contactInboxId ?? null,
    systemPrompt: promptSections.length
      ? `${systemPrompt}\n\n${promptSections.join("\n\n")}`
      : systemPrompt,
    mc,
    apiKey,
    credentialBaseUrl,
    guardrails,
    guardrailsApiKey,
    guardrailsCredentialBaseUrl,
    transferWithSummary: agent.transferWithSummary,
    nativeToolsAllow: sel.nativeToolsAllow,
    httpToolDefs: sel.httpToolDefs,
    mcpSelections: sel.mcpSelections,
    integrationSelections: sel.integrationSelections,
    ragConfig: sel.ragConfig,
    langfuseCfg,
    ttsConfig: readTtsConfig(effSettings),
    contactVoiceReply: conv?.contact?.voiceReply ?? null,
    splitConfig: readSplitConfig(effSettings),
    serviceWindowConfig: readServiceWindowConfig(effSettings),
    handoffConfig: readHandoffConfig(effSettings),
    kanbanConfig: readKanbanConfig(effSettings),
    toolGuidance: readToolGuidance(effSettings),
    httpToolContext: {
      ...(conv?.contact?.chatwootContactId != null
        ? { contact_id: String(conv.contact.chatwootContactId) }
        : {}),
      ...(conv?.contact?.name ? { contact_name: conv.contact.name } : {}),
      ...(conv?.contact?.email ? { contact_email: conv.contact.email } : {}),
      ...(conv?.contact?.phone ? { contact_phone: conv.contact.phone } : {}),
      ...(conv?.inbox?.chatwootInboxId != null
        ? { inbox_id: String(conv.inbox.chatwootInboxId) }
        : {}),
      ...(conv?.inbox?.name ? { inbox_name: conv.inbox.name } : {}),
      ...(tenant?.name ? { company_name: tenant.name } : {}),
      agent_name: agent.name,
    },
    contactName: conv?.contact?.name ?? null,
    timezone,
    maxToolCalls: readLimitsConfig(effSettings).maxToolCalls,
  };
}

export interface ToolsetCtx {
  tenantId: bigint;
  instanceId: bigint;
  base: PrismaClient;
  client: ChatwootClient;
  conversationId: number;
  threadId: string;
  // Chatwoot id of the message that triggered this turn, exposed to HTTP tools as {{message_id}}.
  // Direct path: the incoming message's id. Debounce flush: the burst's last incoming message id
  // (the watermark), since the coalesced turn answers up to that message. 0/absent ⇒ not exposed.
  messageId?: number;
  // Mutable per-turn state shared between runLoadedTurn and the native tools (deferred resolve).
  // Only runLoadedTurn passes it; nudge/playground omit it on purpose (structural mirror of
  // TurnState in tools/native.ts — this module deliberately does not import that file).
  turnState?: { resolveRequested: boolean };
}

export interface ToolBuildDeps {
  buildNativeTools: (
    ctx: {
      client: ChatwootClient;
      conversationId: number;
      turnState?: { resolveRequested: boolean };
      transferWithSummary?: boolean;
      handoff?: HandoffConfig;
      handoffTargets?: HandoffTargets;
      tenantId?: bigint;
      base?: PrismaClient;
      contactDbId?: bigint | null;
      conversationDbId?: bigint | null;
      contactVoiceReply?: boolean | null;
      timezone?: string;
      vocab?: ChatwootVocab;
      kanban?: KanbanContext;
      toolInstructions?: Partial<Record<NativeToolName, string>>;
      onSideEffectError?: SideEffectErrorReporter;
    },
    allowed?: Iterable<string>,
  ) => StructuredToolInterface[];
  mcp?: McpLoadDeps;
  // Flow telemetry context for THIS turn. When present, an MCP discovery failure is surfaced as a
  // flowlog warn (visible in the Logs page; paged on inbox traffic) instead of only a stdout log.
  flow?: FlowContext;
}

// Native Chatwoot tools + allowlisted custom HTTP tools + allowlisted MCP tools. buildNativeTools
// is injected so this module does not import the native-tools file (which the nudge path may want
// to vary), keeping the dependency graph shallow.
export async function buildToolset(
  cfg: AgentConfig,
  ctx: ToolsetCtx,
  deps: ToolBuildDeps,
): Promise<StructuredToolInterface[]> {
  const resolveCredential = (ref: string) =>
    resolveInjectableCredential(ctx.base, ctx.tenantId, ref);
  // Resolves an integration's chosen BusinessHours by id → windows + timezone (scoped read; RLS fences
  // it to this tenant, so a stale/other-tenant id yields null ⇒ the Calendar availability tool treats
  // the schedule as "always on"). Mirrors resolveCredential's bound-closure shape.
  const resolveBusinessHours = async (
    id: string,
  ): Promise<{ windows: WindowSpec[]; timezone: string } | null> => {
    const bhId = /^\d+$/.test(id) ? BigInt(id) : null;
    if (bhId === null) return null;
    const row = await runScopedOn(ctx.base, sysCtx(ctx.tenantId), (db) =>
      db.businessHours.findUnique({
        where: { id: bhId },
        select: { windows: true, timezone: true },
      }),
    );
    if (!row) return null;
    return { windows: parseWindows(row.windows), timezone: row.timezone };
  };
  const flow = deps.flow;
  // NOTE: A side effect that fails INSIDE a tool that still returns success is invisible in the
  // tool's own flowlog line (the tool legitimately succeeded for the model). This binding lets toolpacks and
  // native tools surface those failures as their OWN `tool`-stage warn line (same shape as the MCP
  // onDiscoverError below): visible in the Logs page, and inbox traffic pages minLevel:warn alert
  // channels. detail.tool names the trail card; detail.phase discriminates the side effect.
  const onSideEffectError = flow
    ? (e: {
        tool: string;
        phase: string;
        detail?: Record<string, unknown>;
        err: unknown;
      }) =>
        emitFlowEvent(flow, {
          stage: "tool",
          level: "warn",
          status: "error",
          // NOTE: Spread first — the canonical tool/phase discriminators must win over any
          // caller-supplied detail keys (the Logs page and alerting key on detail.phase).
          detail: { ...(e.detail ?? {}), tool: e.tool, phase: e.phase },
          errorMessage: e.err instanceof Error ? e.err.message : String(e.err),
        })
    : undefined;
  // Deterministic appointment reminders: when the Calendar toolpack books an appointment, arm one
  // scheduler job per configured offset; cancel them on cancel/reschedule. Bound to the tenant + THIS
  // conversation's thread (the per-conversation `tenant:instance:convId`, which runAgentNudge parses —
  // NOT the per-contact-inbox memory thread). The POLICY (offsets/confirmation) lives in the Calendar
  // integration's config and is passed in by the toolpack; here we only wire the MECHANISM. Both are
  // wired on any real conversation so reminders can be armed and stale ones cleaned up regardless of
  // the per-integration toggle.
  const apptThreadId =
    ctx.conversationId > 0
      ? chatwootThreadId(ctx.tenantId, ctx.instanceId, ctx.conversationId)
      : null;
  const scheduleAppointmentReminders = apptThreadId
    ? async (a: {
        eventId: string;
        calendarId: string;
        startISO: string;
        credentialRef: string | null;
        offsetsHours: number[];
        askConfirmationOnLast: boolean;
        summary: string | null;
        calendarLabel: string | null;
      }) => {
        try {
          await enqueueAppointmentReminders({
            tenantId: ctx.tenantId,
            threadId: apptThreadId,
            eventId: a.eventId,
            calendarId: a.calendarId,
            credentialRef: a.credentialRef,
            startISO: a.startISO,
            offsetsHours: a.offsetsHours,
            askConfirmationOnLast: a.askConfirmationOnLast,
            summary: a.summary,
            calendarLabel: a.calendarLabel,
            base: ctx.base,
          });
        } catch (e) {
          logger.warn(
            "appointment reminders enqueue failed: %s",
            e instanceof Error ? e.message : String(e),
          );
          // NOTE: The appointment exists in Google but its reminders were never armed — the customer
          // silently misses them. `google_calendar` is the toolpack family name (the closure does not
          // know which calendar tool called it).
          onSideEffectError?.({
            tool: "google_calendar",
            phase: "reminders_enqueue",
            detail: { eventId: a.eventId },
            err: e,
          });
        }
      }
    : undefined;
  const cancelAppointmentRemindersFn = apptThreadId
    ? async (eventId: string) => {
        try {
          await cancelAppointmentReminders(ctx.tenantId, eventId, ctx.base);
        } catch (e) {
          logger.warn(
            "appointment reminders cancel failed: %s",
            e instanceof Error ? e.message : String(e),
          );
          onSideEffectError?.({
            tool: "google_calendar",
            phase: "reminders_cancel",
            detail: { eventId },
            err: e,
          });
        }
      }
    : undefined;
  // Slow-tool ack emitter: posts the per-tool "I'll look into that…" message (with a typing
  // indicator) before the tool runs. Wired ONLY on a real conversation (conversationId > 0) — the
  // playground builds its toolset with conversationId 0 and a dummy client, so acks never fire
  // there. Best-effort: any failure is swallowed so it can never block the actual tool call.
  const emitAck =
    ctx.conversationId > 0
      ? async (message: string) => {
          try {
            await ctx.client.sendMessage(ctx.conversationId, message);
            await ctx.client.toggleTyping(ctx.conversationId, true);
          } catch (e) {
            logger.warn(
              "tool ack failed (conv=%s): %s",
              String(ctx.conversationId),
              e instanceof Error ? e.message : String(e),
            );
          }
        }
      : undefined;
  const mcpTools = await loadMcpToolsForAgent(ctx.tenantId, cfg.mcpSelections, {
    // Default google_oauth refresh (overridable by tests via deps.mcp). Resolves the entry id from
    // the `vault:<id>` ref and returns a fresh access token, refreshing via Google when stale.
    refreshCredential: (tenantId, ref) =>
      resolveInjectableCredential(ctx.base, tenantId, ref),
    // A connection that fails discovery degrades the toolset silently (fail-open). When a flow ctx is
    // present, also surface it as a flowlog `tool` warn → visible in the Logs page and (inbox traffic
    // only) paged to alert channels. Best-effort: the emit is fire-and-forget and never throws.
    onDiscoverError: flow
      ? (sel, err) =>
          emitFlowEvent(flow, {
            stage: "tool",
            level: "warn",
            status: "error",
            detail: {
              mcp: sel.name,
              connId: String(sel.connId),
              phase: "discover",
            },
            errorMessage: err instanceof Error ? err.message : String(err),
          })
      : undefined,
    ...deps.mcp,
  });
  const toolpackTools = buildToolpackTools(cfg.integrationSelections, {
    tenantId: ctx.tenantId,
    base: ctx.base,
    threadId: ctx.threadId,
    // The current customer, so a toolpack can isolate per-contact data (e.g. Calendar appointments).
    // null on the playground (no mirrored contact) → such tools fail closed.
    contactDbId: cfg.contactDbId,
    resolveCredential,
    resolveBusinessHours,
    scheduleAppointmentReminders,
    cancelAppointmentReminders: cancelAppointmentRemindersFn,
    onSideEffectError,
    // Only a real conversation gets the live handle (mirrors the emitAck gate); the playground
    // builds with conversationId 0 + a stub client, so customer-delivery tools degrade.
    ...(ctx.conversationId > 0
      ? {
          chatwoot: { client: ctx.client, conversationId: ctx.conversationId },
        }
      : {}),
  });
  // Ground agent_choice handoff: resolve the instance's live agents/teams (network, outside the tx;
  // cached per instance) so the tool description lists real names and the model's pick resolves to an
  // id. Only on a real conversation — the playground builds with conversationId 0 + a stub client.
  // Best-effort: a failure leaves it ungrounded (the tool still works, with a private note on a miss).
  // A pinned target is account-scoped: if the conversation's account differs from where the target
  // was picked (targetInstanceId), the stored id is invalid here — fall back to agent_choice so the
  // model can pick a valid target from THIS account. null targetInstanceId ⇒ legacy/single-account
  // pinned, honored as-is. The editor already blocks pinning across accounts; this covers later drift.
  const hc = cfg.handoffConfig;
  const pinnedForeign =
    hc.mode === "pinned" &&
    hc.targetInstanceId != null &&
    hc.targetInstanceId !== Number(ctx.instanceId);
  const effectiveHandoff = pinnedForeign
    ? { ...hc, mode: "agent_choice" as const }
    : hc;
  let handoffTargets: HandoffTargets | undefined;
  if (effectiveHandoff.mode === "agent_choice" && ctx.conversationId > 0) {
    try {
      handoffTargets = await loadHandoffTargets(
        ctx.client,
        `${ctx.tenantId}:${ctx.instanceId}`,
      );
    } catch (e) {
      logger.warn(
        "handoff targets fetch failed (tenant=%s): %s",
        String(ctx.tenantId),
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  // Ground assign_label / set_custom_attribute with the account's real labels + attribute
  // definitions (network, outside the tx; cached per instance). Only on a real conversation and only
  // when one of those tools is actually granted (undefined allowlist ⇒ all). Best-effort: a failure
  // leaves the tools with generic descriptions.
  const vocabTools = ["assign_label", "set_custom_attribute"];
  const needsVocab =
    !cfg.nativeToolsAllow ||
    cfg.nativeToolsAllow.some((n) => vocabTools.includes(n));
  let vocab: ChatwootVocab | undefined;
  if (needsVocab && ctx.conversationId > 0) {
    try {
      vocab = await loadChatwootVocab(
        ctx.client,
        `${ctx.tenantId}:${ctx.instanceId}`,
      );
    } catch (e) {
      logger.warn(
        "chatwoot vocab fetch failed (tenant=%s): %s",
        String(ctx.tenantId),
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  // Resolve this conversation's kanban card (board + current step + steps) ONLY when the funnel tool
  // is granted (it is the costlier 2-3 call resolve), so the common case stays cheap. Grounds
  // kanban_move_card (step by name) + enables set_custom_attribute's task scope. Best-effort.
  const grantsKanban =
    !cfg.nativeToolsAllow || cfg.nativeToolsAllow.includes("kanban_move_card");
  let kanban: KanbanContext | undefined;
  if (grantsKanban && ctx.conversationId > 0) {
    try {
      kanban =
        (await loadKanbanContext(
          ctx.client,
          ctx.conversationId,
          `${ctx.tenantId}:${ctx.instanceId}`,
        )) ?? undefined;
    } catch (e) {
      logger.warn(
        "kanban context fetch failed (tenant=%s): %s",
        String(ctx.tenantId),
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  // Operator-authored per-tool guidance (handoff transfer logic / funnel notes), appended to the
  // respective native tool descriptions. Only keys with text are set.
  const toolInstructions: Partial<Record<NativeToolName, string>> = {
    ...cfg.toolGuidance,
  };
  // handoff/kanban guidance lives in their own grouped config; let it win over the flat map for those
  // two tools (the editor writes them there, not into settings.toolGuidance).
  if (cfg.handoffConfig.instructions) {
    toolInstructions.handoff_to_human = cfg.handoffConfig.instructions;
  }
  if (cfg.kanbanConfig.instructions) {
    toolInstructions.kanban_move_card = cfg.kanbanConfig.instructions;
  }
  return [
    ...deps.buildNativeTools(
      {
        client: ctx.client,
        conversationId: ctx.conversationId,
        turnState: ctx.turnState,
        transferWithSummary: cfg.transferWithSummary,
        handoff: effectiveHandoff,
        handoffTargets,
        tenantId: ctx.tenantId,
        base: ctx.base,
        contactDbId: cfg.contactDbId,
        conversationDbId: cfg.conversationDbId,
        contactVoiceReply: cfg.contactVoiceReply,
        timezone: cfg.timezone,
        vocab,
        kanban,
        toolInstructions,
        onSideEffectError,
      },
      cfg.nativeToolsAllow,
    ),
    ...buildHttpTools(cfg.httpToolDefs, {
      resolveCredential,
      emitAck,
      // HTTP tools are https-only unless allowHttp. In dev (where SSRF_ALLOW_PRIVATE_TARGETS is on by
      // default) operators legitimately point tools at local http services (see .env.example); prod
      // keeps the flag false → https-only. Ties the two so a local HTTP tool works without extra config.
      allowHttp: config.ssrf.allowPrivateTargets,
      context: {
        ...(ctx.conversationId > 0
          ? { conversation_id: String(ctx.conversationId) }
          : {}),
        ...(ctx.messageId && ctx.messageId > 0
          ? { message_id: String(ctx.messageId) }
          : {}),
        ...cfg.httpToolContext,
      },
    }),
    ...mcpTools,
    ...toolpackTools,
    ...buildRagTools(
      {
        tenantId: ctx.tenantId,
        base: ctx.base,
        knowledgeBaseIds: cfg.ragConfig?.knowledgeBaseIds ?? [],
        knowledgeBases: cfg.ragConfig?.knowledgeBases,
        threadId: ctx.threadId,
        maxDistance: cfg.ragConfig?.maxDistance,
      },
      cfg.ragConfig?.tools,
    ),
  ];
}

export interface CallbacksArgs {
  tenantId: bigint;
  threadId: string;
  base?: PrismaClient;
  persistUsage?: UsagePersist;
  node?: string;
  // Usage segmentation: "inbox" (real traffic, default) | "playground" (operator test turns).
  source?: UsageSource;
  // Per-turn id → the Langfuse trace id (correlates a trace with the ExecutionLog turn). Omitted
  // lets Langfuse generate its own id.
  turnId?: string;
  // The toolset bound to the model this turn → trace metadata (names always, schemas in debug mode).
  tools?: StructuredToolInterface[];
}

export function buildCallbacks(
  cfg: AgentConfig,
  args: CallbacksArgs,
): BaseCallbackHandler[] {
  const usage = new UsageCapture({
    tenantId: args.tenantId,
    agentId: cfg.agentId,
    conversationId: cfg.conversationDbId,
    inboxId: cfg.inboxDbId,
    threadId: args.threadId,
    model: cfg.mc.model,
    node: args.node ?? "agent",
    source: args.source,
    persist: args.persistUsage,
    base: args.base,
  });
  const toolTrace = buildToolTraceMetadata(args.tools, cfg.langfuseCfg?.debug);
  const langfuse = buildLangfuseHandler(cfg.langfuseCfg, {
    tenantId: args.tenantId,
    threadId: args.threadId,
    conversationId: cfg.conversationDbId,
    agentId: cfg.agentId,
    userId: cfg.langfuseCfg?.tenantSlug,
    turnId: args.turnId,
    source: args.source,
    availableTools: toolTrace.availableTools,
    availableToolSchemas: toolTrace.availableToolSchemas,
  });
  return langfuse ? [usage, langfuse] : [usage];
}

export interface GraphBuildDeps {
  makeModel?: (cfg: ResolvedModelConfig) => BaseChatModel;
  checkpointer?: BaseCheckpointSaver;
  // Fired when the hard tool-call limit forces a no-tools answer (runtime emits a flow warn).
  onToolLimit?: (info: { maxToolCalls: number; toolCalls: number }) => void;
}

export async function buildModelAndGraph(
  cfg: AgentConfig,
  tools: StructuredToolInterface[],
  deps: GraphBuildDeps = {},
) {
  const makeModel = deps.makeModel ?? createChatModel;
  const effectiveBaseUrl = cfg.credentialBaseUrl ?? cfg.mc.baseURL;
  const model = makeModel({
    ...cfg.mc,
    apiKey: cfg.apiKey,
    baseURL: effectiveBaseUrl,
  });
  const checkpointer = deps.checkpointer ?? (await getCheckpointer());
  // Append the MCP server-context block (each connected server's scope + native `instructions` + its
  // namespaced tool names) so the agent understands what an `mcp__<server>__<tool>` call operates on.
  // Built from the assembled toolset metadata here so turn / nudge / playground all get it uniformly.
  const mcpContext = buildMcpContextSection(tools);
  const systemPrompt = mcpContext
    ? `${cfg.systemPrompt}\n\n${mcpContext}`
    : cfg.systemPrompt;
  return buildAgentGraph({
    model,
    systemPrompt,
    checkpointer,
    tools,
    maxToolCalls: cfg.maxToolCalls,
    onToolLimit: deps.onToolLimit,
  });
}
