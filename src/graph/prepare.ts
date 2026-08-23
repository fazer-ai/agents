import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import config from "@/config";
import type { ModelOverride } from "@/graph/model-override";
import { parseDbId } from "@/lib/db-id";
import type { ScopedDb, TenantContext } from "@/lib/tenancy";
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
import { parseSchedule, type Schedule } from "@/modules/business-hours/hours";
import { readSchedule } from "@/modules/business-hours/service";
import {
  ATTRIBUTE_SCOPES,
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
import {
  type ContactAuthConfig,
  readContactAuthConfig,
} from "@/modules/contact-auth/settings";
import type { ObservedConversation } from "@/modules/conversations/record-resolution";
import { resolveVariantOverride } from "@/modules/experiments/service";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import { readObservabilityConfig } from "@/modules/flowlog/settings";
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
import type { ImageFetchDeps } from "@/modules/images/fetch";
import {
  readSendImageConfig,
  type SendImageConfig,
} from "@/modules/images/settings";
import {
  buildToolpackTools,
  type IntegrationSelection,
  type SideEffectErrorReporter,
} from "@/modules/integrations/toolpacks";
import { type KanbanConfig, readKanbanConfig } from "@/modules/kanban/settings";
import { readMemoryConfig } from "@/modules/memory/settings";
import {
  readServiceWindowConfig,
  type ServiceWindowConfig,
} from "@/modules/service-window/service";
import { readSplitConfig, type SplitConfig } from "@/modules/split/service";
import { llmNormalizeForSpeech } from "@/modules/tts/normalize";
import { resolveNormalizeModel } from "@/modules/tts/normalize-model";
import { readTtsConfig, type TtsConfig } from "@/modules/tts/settings";
import { resolveInjectableCredential } from "@/modules/vault/injectable";
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
import { type AuditedSection, buildPromptAudit } from "./prompt-audit";
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
  // The same prompt with every customer-authored value replaced by its name and length, which is the
  // only version `execution_logs.detail` is allowed to keep (prompt-audit.ts). Never given to a model.
  systemPromptAudit: string;
  mc: ModelConfig;
  apiKey: string;
  // baseURL resolved from the credential entry (entry.baseUrl), taking precedence over mc.baseURL.
  credentialBaseUrl: string | null;
  // Guardrails (input/output moderation): config + the guardrails agent's OWN resolved API key /
  // baseURL (its chat model is separate from the main agent's). apiKey "" ⇒ disabled or the
  // credential did not resolve ⇒ the runtime skips the analysis (fail-open). The gate tells those
  // two apart: switched off reads as `not-run`, an empty key on an ENABLED direction as
  // `unavailable`, which is what puts an unresolvable ref in front of the operator.
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
  // The speech normalizer's OWN resolved key / baseURL, when the operator pointed it at a separate
  // credential. Empty ⇒ it inherits the agent's (the default). Resolved here, next to the agent's and
  // the guardrails agent's, so the audio path never opens a DB read of its own.
  ttsNormalizeApiKey: string;
  ttsNormalizeCredentialBaseUrl: string | null;
  contactVoiceReply: boolean | null;
  // Humanized text delivery (split into balloons + typing delay).
  splitConfig: SplitConfig;
  // WhatsApp 24h service-window gate for proactive sends + the contact name for template params.
  serviceWindowConfig: ServiceWindowConfig;
  handoffConfig: HandoffConfig;
  // Contact authorization gate (docs/contact-auth.md). Enforced by the webhook gate, the debounce
  // flush, the proactive nudge and the manual re-engage, NOT here; carried on the config so they
  // need no second settings read.
  contactAuthConfig: ContactAuthConfig;
  // Hosts the send_image tool may fetch an image from (operator-set; empty = the tool refuses).
  sendImageConfig: SendImageConfig;
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
  // Ceiling on the history tokens sent to the model (agent.settings.limits.maxHistoryTokens).
  // null = no ceiling, send the whole thread.
  maxHistoryTokens: number | null;
  // Whether a closed attendance gets folded into the contact's memory instead of staying raw on
  // the thread (agent.settings.memory.compaction). Read here so the turn that CROSSES an
  // attendance boundary can arm the compaction job without a second query.
  memoryCompaction: boolean;
  // The summariser's own model, as an override of the agent's, plus the credential it names. Same
  // three-field shape as the speech rewrite above; resolved through graph/model-override.ts.
  memoryCompactionOverride: ModelOverride;
  memoryCompactionApiKey: string;
  memoryCompactionCredentialBaseUrl: string | null;
  // Whether this agent's tool lines log the VALUES the model sent instead of their shape
  // (agent.settings.observability.logToolValues; off by default — see src/modules/flowlog/shape.ts).
  logToolValues: boolean;
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
  // Playground: the Availability the operator has selected but not saved yet, as the console's own
  // string ("" = none). Absent = read the saved column. Without it the playground answers
  // {{esta_aberto}} & co. from the schedule the picker no longer shows, which is the same drift
  // between description and enforcement these variables exist to remove.
  businessHoursId?: string;
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
  opts: {
    ignoreDisabled?: boolean;
    overrides?: AgentConfigOverrides;
    // Skips the A/B variant resolution. Resolving one is not a read: it INSERTS the thread's
    // assignment when there is none, and that row lands in the denominator of every result for the
    // experiment. A caller that never runs the tested prompt — memory compaction summarizes with a
    // fixed prompt of its own — would be inventing participants for an experiment it takes no part
    // in, lowering its reported rates with nothing in the numbers to say why.
    skipExperiment?: boolean;
  } = {},
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
  // unresolvable credential leaves the key empty and the runtime skips the analysis (fail-open,
  // logged), reporting `unavailable` rather than `not-run` so the operator can see it happened.
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
  // Speech normalizer's own credential, when it runs on a separate model. Same fail-open shape as
  // guardrails: an unresolvable ref leaves the key empty, and buildSpeechNormalizer then SKIPS the
  // rewrite (visibly) rather than quietly falling back to the agent's key on a provider that may not
  // accept it.
  const ttsCfg = readTtsConfig(effSettings);
  let ttsNormalizeApiKey = "";
  let ttsNormalizeCredentialBaseUrl: string | null = null;
  if (ttsCfg.normalize && ttsCfg.normalizeCredentialRef) {
    const nEntry = await tryResolveVaultEntry<string>(
      db,
      ttsCfg.normalizeCredentialRef,
    );
    if (nEntry) {
      ttsNormalizeApiKey = nEntry.secret;
      ttsNormalizeCredentialBaseUrl = nEntry.baseUrl;
    } else {
      logger.warn(
        "agent %s: tts normalize credentialRef %s did not resolve, so the speech rewrite is skipped",
        String(args.agentId),
        ttsCfg.normalizeCredentialRef,
      );
    }
  }
  // The summariser's own credential, when it runs on a separate model. Same fail-open shape as the
  // two above: an unresolvable ref leaves the key empty, and runCompaction then FAILS the job rather
  // than quietly falling back to the agent's key on a provider that may not accept it. Failing is
  // right here where skipping is right for the rewrite: a skipped rewrite costs one sentence's
  // delivery, a summary written by the wrong model is memory this contact carries forever.
  const memoryCfg = readMemoryConfig(effSettings).compaction;
  let memoryCompactionApiKey = "";
  let memoryCompactionCredentialBaseUrl: string | null = null;
  if (memoryCfg.enabled && memoryCfg.credentialRef) {
    const mEntry = await tryResolveVaultEntry<string>(
      db,
      memoryCfg.credentialRef,
    );
    if (mEntry) {
      memoryCompactionApiKey = mEntry.secret;
      memoryCompactionCredentialBaseUrl = mEntry.baseUrl;
    } else {
      logger.warn(
        "agent %s: memory compaction credentialRef %s did not resolve, so the attendance summary is not written",
        String(args.agentId),
        memoryCfg.credentialRef,
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
  // The agent's Availability, in one scoped read when configured. It feeds the clock (get_current_time
  // tool + {{hora_atual}} var) through its timezone, and the schedule variables ({{esta_aberto}},
  // {{proximo_atendimento}}, {{horario_atendimento}}) through the grid and its exceptions. Until this
  // read carried more than the timezone, the agent described its own hours from the operator's prose
  // and drifted from the gate the moment either changed. `null` = no Availability = always on.
  let timezone = DEFAULT_TIMEZONE;
  let schedule: Schedule | null = null;
  // A draft id is console input, so it goes through parseDbId (digits AND range: a value past 2^63-1
  // parses as a BigInt and then fails in the query BIND, turning a bad field into a 500) and is read
  // through the SAME scoped client: another tenant's row simply does not come back, and the turn
  // falls through to always-on rather than to the saved schedule — an unresolvable selection is "no
  // schedule", not "the old one".
  const draftHoursId = ov?.businessHoursId;
  const hoursId =
    draftHoursId === undefined
      ? agent.businessHoursId
      : parseDbId(draftHoursId);
  if (hoursId !== null) {
    const bh = await db.businessHours.findUnique({
      where: { id: hoursId },
      select: { timezone: true, windows: true, exceptions: true },
    });
    if (bh) {
      schedule = parseSchedule(bh);
      if (bh.timezone) timezone = bh.timezone;
    }
  }
  // Company name for the {{nome_empresa}} prompt variable (the tenant's own row under RLS).
  const tenant = await db.tenant.findFirst({ select: { name: true } });
  const langfuseCfg = await resolveLangfuseConfig(db, args.tenantId);
  const sel = await loadToolSelections(db, agent.id);
  // A/B: an active experiment for this agent may override the system prompt for this thread.
  const promptOverride = opts.skipExperiment
    ? null
    : await resolveVariantOverride(db, {
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
  const promptTemplate = composeSystemPrompt(
    ov?.systemPrompt ?? promptOverride ?? agent.systemPrompt,
    {
      grounded,
    },
  );
  const promptVars = buildPromptVars({
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
  });
  // Playground time simulation: a valid wall-clock override replaces the real now for every time
  // variable, interpreted in the agent's timezone; anything malformed falls back to the real now.
  // NOTE: one instant for BOTH renderings, and never `undefined`. `interpolatePromptVars` falls
  // back to its own `new Date()` per call, and the audited prompt is built further down, after the
  // appointment read: an exact-time variable would otherwise cross a minute (or a date) boundary
  // and the logged prompt would report an hour the model never saw.
  const promptOpts = {
    timezone,
    now:
      (ov?.promptNow
        ? zonedWallClockToInstant(ov.promptNow, timezone)
        : null) ?? new Date(),
    // Passed on every real path, so a schedule variable is answered rather than left literal. The
    // playground's time simulation reaches it through `now` above: an operator testing "what does
    // it say at 22:00" sees the agent report itself closed, exactly as the gate would.
    availability: { schedule },
  };
  const systemPrompt = interpolatePromptVars(
    promptTemplate,
    promptVars,
    promptOpts,
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
  // The same prompt with every customer-authored value taken out, for the row the Logs page shows.
  // Built here, from the same parts, so the two can never describe different turns. The alternative
  // (reconstructing it at the emit) would read a prompt that had already lost the seam between the
  // operator's text and what was substituted into it. See prompt-audit.ts for the rule.
  const auditedSections: AuditedSection[] = [];
  if (attributeSection) {
    auditedSections.push({
      label: "atributos",
      keys: ATTRIBUTE_SCOPES.flatMap((scope) =>
        attributeContext[scope].map((k) => `${scope}:${k}`),
      ),
      text: attributeSection,
    });
  }
  if (appointmentSection) {
    auditedSections.push({ label: "agendamentos", text: appointmentSection });
  }
  const limits = readLimitsConfig(effSettings);
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
    systemPromptAudit: buildPromptAudit({
      template: promptTemplate,
      vars: promptVars,
      opts: promptOpts,
      sections: auditedSections,
    }),
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
    ttsConfig: ttsCfg,
    ttsNormalizeApiKey,
    ttsNormalizeCredentialBaseUrl,
    contactVoiceReply: conv?.contact?.voiceReply ?? null,
    splitConfig: readSplitConfig(effSettings),
    serviceWindowConfig: readServiceWindowConfig(effSettings),
    handoffConfig: readHandoffConfig(effSettings),
    contactAuthConfig: readContactAuthConfig(effSettings),
    sendImageConfig: readSendImageConfig(effSettings),
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
    maxToolCalls: limits.maxToolCalls,
    maxHistoryTokens: limits.maxHistoryTokens,
    memoryCompaction: memoryCfg.enabled,
    memoryCompactionOverride: {
      provider: memoryCfg.provider,
      model: memoryCfg.model,
      credentialRef: memoryCfg.credentialRef,
      baseURL: memoryCfg.baseURL,
    },
    memoryCompactionApiKey,
    memoryCompactionCredentialBaseUrl,
    logToolValues: readObservabilityConfig(effSettings).logToolValues,
  };
}

export interface ToolsetCtx {
  tenantId: bigint;
  instanceId: bigint;
  base: PrismaClient;
  client: ChatwootClient;
  conversationId: number;
  threadId: string;
  // The conversation's status as this turn observed it, before any close of ours. Feeds the
  // IMMEDIATE resolve_conversation path (nudge turns, which carry no turnState): a close that had
  // already happened when the turn started is not the agent's. See record-resolution.ts rule 2.
  observed?: ObservedConversation;
  // Chatwoot id of the message that triggered this turn, exposed to HTTP tools as {{message_id}}.
  // Direct path: the incoming message's id. Debounce flush: the burst's last incoming message id
  // (the watermark), since the coalesced turn answers up to that message. 0/absent ⇒ not exposed.
  messageId?: number;
  // Mutable per-turn state shared between runLoadedTurn and the native tools (deferred resolve).
  // Only runLoadedTurn passes it; nudge/playground omit it on purpose (structural mirror of
  // TurnState in tools/native.ts — this module deliberately does not import that file).
  // Injectable for tests: the download + SSRF assertion send_image performs before queueing
  // (defaults are the real ones). The assertion resolves DNS, so a hermetic test has to stub it —
  // same convention as ToolpackCtx.assertSafe.
  imageDeps?: ImageFetchDeps;
  turnState?: {
    resolveRequested: boolean;
    // Mirror of TurnState.pendingImages: send_image queues here and the runtime delivers after the
    // turn's gates.
    pendingImages: {
      bytes: ArrayBuffer;
      mime: string;
      fileName: string;
      caption?: string;
      order: number;
    }[];
    imagesInFlight: number;
    imagesSeq: number;
  };
  // Structural mirror of HandoffTurnState in tools/native.ts, for the same reason as turnState.
  // Two fields, not one: the line the model wants delivered, and whether the transfer completed.
  handoffState?: { customerMessage: string | null; completed: boolean };
}

export interface ToolBuildDeps {
  buildNativeTools: (
    ctx: {
      client: ChatwootClient;
      conversationId: number;
      turnState?: {
        resolveRequested: boolean;
        // Mirror of TurnState.pendingImages: send_image queues here and the runtime delivers after the
        // turn's gates.
        pendingImages: {
          bytes: ArrayBuffer;
          mime: string;
          fileName: string;
          caption?: string;
          order: number;
        }[];
        imagesInFlight: number;
        imagesSeq: number;
      };
      handoffState?: { customerMessage: string | null; completed: boolean };
      transferWithSummary?: boolean;
      handoff?: HandoffConfig;
      handoffTargets?: HandoffTargets;
      tenantId?: bigint;
      base?: PrismaClient;
      contactDbId?: bigint | null;
      conversationDbId?: bigint | null;
      // Mirrors ToolCtx.observed (this whole ctx is a structural copy of it, so a field added
      // there has to be added here too or the call below stops type-checking).
      observed?: ObservedConversation;
      contactVoiceReply?: boolean | null;
      timezone?: string;
      vocab?: ChatwootVocab;
      kanban?: KanbanContext;
      sendImage?: SendImageConfig;
      fetchImpl?: typeof fetch;
      assertSafe?: ImageFetchDeps["assertSafe"];
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
  // Resolves an integration's chosen BusinessHours by id → the whole schedule (scoped read; RLS
  // fences it to this tenant, so a stale/other-tenant id yields null ⇒ the Calendar availability tool
  // treats the schedule as "always on"). Mirrors resolveCredential's bound-closure shape.
  const resolveBusinessHours = (id: string): Promise<Schedule | null> =>
    readSchedule(sysCtx(ctx.tenantId), id, ctx.base);
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
        handoffState: ctx.handoffState,
        transferWithSummary: cfg.transferWithSummary,
        handoff: effectiveHandoff,
        handoffTargets,
        tenantId: ctx.tenantId,
        base: ctx.base,
        contactDbId: cfg.contactDbId,
        conversationDbId: cfg.conversationDbId,
        observed: ctx.observed,
        contactVoiceReply: cfg.contactVoiceReply,
        timezone: cfg.timezone,
        vocab,
        kanban,
        sendImage: cfg.sendImageConfig,
        fetchImpl: ctx.imageDeps?.fetchImpl,
        assertSafe: ctx.imageDeps?.assertSafe,
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
  // The model to LABEL the usage row with. Defaults to the agent's own model, which is right for the
  // turn itself; a secondary call on a separately-configured model (the speech normalizer) must pass
  // the model it actually billed, or the row attributes that spend to the wrong model.
  model?: string;
  // The conversation to ATTRIBUTE the usage row and the trace to. Defaults to the one the config was
  // loaded for, which is right for a turn; memory compaction is the exception, because a claimed job
  // can find the thread already past the conversation its payload named, and the summary it bills is
  // of the segment it actually cut.
  conversationId?: bigint | null;
  // Passed through to the Langfuse handler: false for a secondary call sharing the turn's trace.
  // See TraceContext.updateRoot.
  updateRoot?: boolean;
  // Usage segmentation: "inbox" (real traffic, default) | "playground" (operator test turns).
  source?: UsageSource;
  // Per-turn id → the Langfuse trace id (correlates a trace with the ExecutionLog turn). Omitted
  // lets Langfuse generate its own id.
  turnId?: string;
  // The toolset bound to the model this turn → trace metadata (names always, schemas in debug mode).
  tools?: StructuredToolInterface[];
}

// `??` was wrong here, and the case it got wrong is the one the override exists for: compaction
// passes an explicit null when the segment it summarized belongs to a conversation whose mirrored row
// is gone (an owed backlog, a conversation deleted since). Coalescing that back to the config's own
// conversation charges the generation to an unrelated attendance — louder than the bug the override
// was added to fix. Omitted and explicitly-null are different answers, so they are read differently.
function resolveUsageConversation(
  cfg: AgentConfig,
  args: CallbacksArgs,
): bigint | null {
  return args.conversationId !== undefined
    ? args.conversationId
    : cfg.conversationDbId;
}

export function buildCallbacks(
  cfg: AgentConfig,
  args: CallbacksArgs,
): BaseCallbackHandler[] {
  const usage = new UsageCapture({
    tenantId: args.tenantId,
    agentId: cfg.agentId,
    conversationId: resolveUsageConversation(cfg, args),
    inboxId: cfg.inboxDbId,
    threadId: args.threadId,
    model: args.model ?? cfg.mc.model,
    node: args.node ?? "agent",
    source: args.source,
    persist: args.persistUsage,
    base: args.base,
  });
  const toolTrace = buildToolTraceMetadata(args.tools, cfg.langfuseCfg?.debug);
  const langfuse = buildLangfuseHandler(cfg.langfuseCfg, {
    tenantId: args.tenantId,
    threadId: args.threadId,
    conversationId: resolveUsageConversation(cfg, args),
    agentId: cfg.agentId,
    userId: cfg.langfuseCfg?.tenantSlug,
    turnId: args.turnId,
    source: args.source,
    availableTools: toolTrace.availableTools,
    availableToolSchemas: toolTrace.availableToolSchemas,
    updateRoot: args.updateRoot,
  });
  return langfuse ? [usage, langfuse] : [usage];
}

export interface SpeechNormalizerArgs {
  makeModel?: (cfg: ResolvedModelConfig) => BaseChatModel;
  // The turn's identity for the usage row and the trace. What makes this call READ as a secondary
  // call (the node label, the model label, updateRoot) is fixed below, not by the caller: every
  // transport that synthesizes audio has to record it the same way.
  callbacks?: Omit<CallbacksArgs, "node" | "model" | "updateRoot" | "tools">;
  // Its own `normalize` stage on the turn trail, NOT an event on the `tts` line: the provider/model
  // columns of a tts row mean the voice engine, and folding a second timing into that row would make
  // "how long does synthesis take" unanswerable.
  flow?: FlowContext;
}

// The reply's own rewrite-for-speech pass, as a separate model call. The agent writes the answer; this
// rewrites a COPY of it for the ear, so the agent's prompt never carries a delivery concern and the
// customer's transcript keeps the original wording. Returns undefined when the agent opted out, which
// is what tells synthesizeReply to send the raw text.
export function buildSpeechNormalizer(
  cfg: AgentConfig,
  args: SpeechNormalizerArgs = {},
): ((text: string) => Promise<string>) | undefined {
  if (!cfg.ttsConfig.normalize) return undefined;
  const resolved = resolveNormalizeModel(
    cfg.ttsConfig,
    {
      provider: cfg.mc.provider,
      model: cfg.mc.model,
      baseURL: cfg.credentialBaseUrl ?? cfg.mc.baseURL,
    },
    { ownCredentialBaseURL: cfg.ttsNormalizeCredentialBaseUrl },
  );
  const own = resolved.credential === "own";
  // Skipping the rewrite must never cost the customer the AUDIO: the caller wraps the whole TTS
  // branch in one try/catch, so anything that throws out of here degrades the reply to text. Every
  // way this builder can fail therefore returns undefined with a visible line instead.
  const skip = (reason: string): undefined => {
    if (args.flow) {
      emitFlowEvent(args.flow, {
        stage: "normalize",
        level: "warn",
        status: "skipped",
        provider: resolved.provider,
        model: resolved.model,
        detail: { reason },
      });
    }
    return undefined;
  };
  // Every configuration the resolver refuses: an unsupported provider name, a switched provider with
  // no key of its own (running it on the AGENT's key would transmit one vendor's secret to another),
  // and an openai-compatible endpoint that is missing. REST and MCP write the settings bag directly,
  // so the editor's warning is not the guard here.
  if (!resolved.runnable) return skip(resolved.reason ?? "not_runnable");
  // Its own credential was configured and did not resolve. Falling back to the AGENT's key would be a
  // silent substitution on a provider that may not even accept it.
  if (own && !cfg.ttsNormalizeApiKey) return skip("credential_not_found");
  const makeModel = args.makeModel ?? createChatModel;
  // Built from the resolution alone, never spread from the agent's config: everything the rewrite
  // is allowed to inherit came back through the resolver by name, and a spread would carry whatever
  // else the agent's config holds (today its credentialRef, tomorrow any field the schema grows)
  // across a provider switch, which is the one thing this whole resolution exists to refuse. The
  // guardrails model is built the same way.
  const mc: ResolvedModelConfig = {
    provider: resolved.provider as ModelConfig["provider"],
    model: resolved.model,
    // WHOSE key travels, decided by the resolver rather than here: the agent's is reachable only
    // while the provider is unchanged, and `none` is an openai-compatible endpoint that authenticates
    // by its URL, where sending the agent's key would be the leak this whole rule exists to prevent.
    apiKey:
      resolved.credential === "own"
        ? cfg.ttsNormalizeApiKey
        : resolved.credential === "agent"
          ? cfg.apiKey
          : "",
    baseURL: resolved.baseURL ?? undefined,
    // Pinned, and the agent's reasoningEffort deliberately NOT carried: this pass rewrites an answer
    // that already exists, and the effort the operator chose is about how the agent THINKS.
    // Reasoning here would only add latency to an audio reply the customer is waiting on.
    temperature: 0,
  };
  // createChatModel REJECTS some configurations synchronously (openai-compatible with no effective
  // base URL throws a 400), and this normalizer config is separately editable, so that throw is
  // reachable without the agent's own model being broken. Uncaught it would cost the audio reply.
  let model: BaseChatModel;
  try {
    model = makeModel(mc);
  } catch (err) {
    logger.warn(
      { err, agentId: String(cfg.agentId) },
      "tts normalize: model config is not runnable, skipping the speech rewrite",
    );
    return skip("model_not_runnable");
  }
  const callbacks = args.callbacks
    ? buildCallbacks(cfg, {
        ...args.callbacks,
        node: "tts_normalize",
        model: mc.model,
        // The turn's trace already exists under this turnId; this call is a generation INSIDE it.
        updateRoot: false,
      })
    : undefined;
  return (text) =>
    withFlowStage(
      args.flow,
      "normalize",
      {
        provider: mc.provider,
        model: mc.model,
        detail: { inChars: text.length },
        // NOTE: counts only. The rewritten text IS the customer's message, so no excerpt, prefix or
        // hash of it may reach a row an operator exports.
        detailOf: (out: string) => ({
          outChars: out.length,
          rewritten: out !== text,
        }),
        // Best-effort: synthesizeReply catches and synthesizes the raw text, so this is an advisory.
        errorLevel: "warn",
      },
      () => llmNormalizeForSpeech(model, text, callbacks),
    );
}

export interface GraphBuildDeps {
  makeModel?: (cfg: ResolvedModelConfig) => BaseChatModel;
  checkpointer?: BaseCheckpointSaver;
  // Fired when the hard tool-call limit forces a no-tools answer (runtime emits a flow warn).
  onToolLimit?: (info: { maxToolCalls: number; toolCalls: number }) => void;
  onModelRetry?: (info: { attempt: number; error: unknown }) => void;
  // Fired when a turn dropped history to fit maxHistoryTokens (runtime records it in the trail).
  onHistoryTrim?: (info: {
    kept: number;
    dropped: number;
    tokens: number;
  }) => void;
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
    onModelRetry: deps.onModelRetry,
    maxHistoryTokens: cfg.maxHistoryTokens,
    onHistoryTrim: deps.onHistoryTrim,
  });
}
