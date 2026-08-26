import {
  ArrowLeft,
  BookOpen,
  Clock,
  Copy,
  Download,
  MessageSquare,
  RadioTower,
  Settings2,
  Share2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  Badge,
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  CredentialForm,
  DataBoundary,
  FormField,
  Input,
  Modal,
  PageContainer,
  Skeleton,
  StrongConfirmModal,
  type StrongConfirmPayload,
  type TabItem,
  Tabs,
  TestModeBadge,
  useModalController,
  useToast,
} from "@/client/components";
import { BusinessHoursForm } from "@/client/components/BusinessHoursForm";
import type { DiscoveredMcpTool } from "@/client/components/mcp/DiscoveredMcpTools";
import { useBreadcrumbLabel } from "@/client/contexts/BreadcrumbContext";
import { useNavGuard } from "@/client/contexts/NavGuardContext";
import { useTenantEvents } from "@/client/hooks/useTenantEvents";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { computeConfigIssues, issueHasAction } from "@/client/lib/configHealth";
import { formatRelativeTime, slugify } from "@/client/lib/utils";
import {
  invalidateVault,
  useVaultBaseUrls,
  useVaultRefs,
} from "@/client/lib/vaultCache";
import { IntegrationEditModal } from "@/client/pages/resources/IntegrationEditModal";
import { McpEditModal } from "@/client/pages/resources/McpEditModal";
import { ToolEditModal } from "@/client/pages/resources/ToolEditModal";
import { useKnowledgeManager } from "@/client/pages/resources/useKnowledgeManager";
import { readModelFallbackConfig } from "@/graph/fallback-settings";
import { modelOptionalFor } from "@/graph/model-defaults";
import { collectOversizedTextChanges } from "@/modules/agents/text-caps";
import type { Schedule } from "@/modules/business-hours/hours";
import {
  CHANNEL_REDIRECT_DEFAULTS,
  type ChannelRedirectConfig,
  readChannelRedirectConfig,
} from "@/modules/channel-redirect/service";
import {
  GUARDRAILS_DEFAULTS,
  type GuardrailsConfig,
} from "@/modules/guardrails/settings";
import { readMemoryConfig } from "@/modules/memory/settings";
import { DEFAULT_EXTRACTION_PROMPT } from "@/modules/vision/prompt-default";
import {
  BehaviorTab,
  type ContactAuthState,
  type MemoryState,
  type ModelFallbackState,
  type SendImageState,
} from "./BehaviorTab";
import {
  type ChannelRedirectFormState,
  ChannelRedirectTab,
} from "./ChannelRedirectTab";
import { ChannelsTab } from "./ChannelsTab";
import { ExportAgentModal } from "./ExportAgentModal";
import { followUpToForm, followUpToStored } from "./followUpFormState";
import { GeneralTab } from "./GeneralTab";
import { GuardrailsTab } from "./GuardrailsTab";
import { readGuardrailsFormState } from "./guardrailsFormState";
import { KnowledgeTab } from "./KnowledgeTab";
import { memoryToForm, memoryToStored } from "./memoryFormState";
import {
  modelFallbackToForm,
  modelFallbackToStored,
} from "./modelFallbackFormState";
import {
  observabilityToForm,
  observabilityToStored,
} from "./observabilityFormState";
import { PlaygroundFab } from "./PlaygroundFab";
import { PlaygroundTab } from "./PlaygroundTab";
import {
  parseToolPreconditionRows,
  serializeToolPreconditions,
} from "./ToolPreconditionsEditor";
import { ToolsTab } from "./ToolsTab";
import { readTtsFormState, ttsSettingsFrom } from "./ttsFormState";
import type {
  GrantState,
  HandoffUiState,
  Hours,
  ToolCatalog,
  ToolPreconditionRow,
  ToolSelectionView,
  VaultEntry,
} from "./types";
import { usePlaygroundChat } from "./usePlaygroundChat";

// The Schedule a saved businessHoursId points at, built field by field rather than passed through:
// rows can come back without windows/exceptions (the sibling picker guards them the same way), and
// the question asked of it — can this schedule ever close — must not turn on that.
function scheduleOf(
  hours: Hours[],
  businessHoursId: string | null | undefined,
): Schedule | null {
  if (!businessHoursId) return null;
  const h = hours.find((x) => String(x.id) === String(businessHoursId));
  return h
    ? {
        windows: (h.windows ?? []) as Schedule["windows"],
        exceptions: (h.exceptions ?? []) as Schedule["exceptions"],
        timezone: h.timezone,
      }
    : null;
}

type AgentResp = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.agents>["get"]>
>;
type Agent = NonNullable<AgentResp["data"]>["agent"];
// Derived, never hand-declared (docs/eden-treaty.md): a mirrored interface drifts the moment the
// controller adds a field, and it did. Written by hand this type omitted `lastError`, which is the
// one part of the reading that names the vendor's refusal, so the warning it feeds could only give
// generic advice about a cause the server had already identified.
type GuardrailHealthResp = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<typeof api.api.v1.agents>["guardrails"]["health"]["get"]
    >
  >["data"]
>;
type TabKey =
  | "general"
  | "channels"
  | "tools"
  | "knowledge"
  | "behavior"
  | "guardrails"
  | "channelRedirect"
  | "playground";

// Ordered tab keys; also the source of truth for validating the URL `:tab` segment.
// NOTE: the former "model" tab merged into "general"; unknown segments (including
// stale /model and /experiments links) are normalized to /general by the effect below.
const TAB_KEYS: TabKey[] = [
  "general",
  "channels",
  "tools",
  "knowledge",
  "behavior",
  "guardrails",
  "channelRedirect",
  "playground",
];

// The four config sections with their own unsaved-changes baseline + save button. Each is tracked
// independently so saving one never re-baselines (or drops) another's pending edits.
type SectionKey =
  | "general"
  | "behavior"
  | "channelRedirect"
  | "guardrails"
  | "tools"
  | "knowledge";
const SECTION_KEYS: SectionKey[] = [
  "general",
  "behavior",
  "channelRedirect",
  "guardrails",
  "tools",
  "knowledge",
];

// The structured import warnings from POST /agents/import (derived from the Eden client, never
// hand-declared — see docs/eden-treaty). Each carries a `code` the editor localizes + an optional
// deep-link `target`.
type ImportWarning = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.agents.import.post>>["data"]
>["warnings"][number];

// Map the (readonly) server grant view into the mutable working set. Used both
// on load and after a PUT, so the local set always mirrors the backend-
// normalized result (no silent drift if normalization ever diverges).
function mapGrants(grants: ToolSelectionView["grants"]): GrantState[] {
  return grants.map((g) => ({
    source: g.source,
    toolDefinitionId: g.toolDefinitionId,
    mcpServerConnectionId: g.mcpServerConnectionId,
    integrationInstanceId: g.integrationInstanceId,
    knowledgeBaseIds: [...g.knowledgeBaseIds],
    enabledTools: [...g.enabledTools],
  }));
}

// Canonical, order-independent serialization of a grant subset for the dirty
// check. enabledTools/knowledgeBaseIds come from a Set via [...set], so toggling
// a tool off then on reorders them and a naive JSON.stringify would report a
// false "unsaved changes". Sort the inner arrays and the grant list by a stable
// composite key so logically-identical selections always serialize the same.
function canonicalGrants(grants: GrantState[]): string {
  const norm = grants
    .map((g) => ({
      source: g.source,
      toolDefinitionId: g.toolDefinitionId ?? null,
      mcpServerConnectionId: g.mcpServerConnectionId ?? null,
      integrationInstanceId: g.integrationInstanceId ?? null,
      knowledgeBaseIds: [...(g.knowledgeBaseIds ?? [])].sort(),
      enabledTools: [...(g.enabledTools ?? [])].sort(),
    }))
    .sort((a, b) =>
      `${a.source}:${a.toolDefinitionId}:${a.mcpServerConnectionId}:${a.integrationInstanceId}`.localeCompare(
        `${b.source}:${b.toolDefinitionId}:${b.mcpServerConnectionId}:${b.integrationInstanceId}`,
      ),
    );
  return JSON.stringify(norm);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): string {
  return typeof v === "number" ? String(v) : "";
}
// Split the editor's "agent:<id>" | "team:<id>" | "" target back into the stored handoff shape. Only
// "pinned" carries a concrete target; the other modes null both out. Mirrors readBehaviorState's
// inverse (which packs targetAgentId/targetTeamId into `target`).
function serializeHandoff(h: HandoffUiState): {
  mode: string;
  targetAgentId: number | null;
  targetTeamId: number | null;
  targetInstanceId: number | null;
  instructions: string | null;
} {
  const [kind, idStr] = h.target.split(":");
  const id = Number(idStr);
  return {
    mode: h.mode,
    targetAgentId:
      h.mode === "pinned" && kind === "agent" && id > 0 ? id : null,
    targetTeamId: h.mode === "pinned" && kind === "team" && id > 0 ? id : null,
    // The account the target was picked from (account-scoped), so the runtime can validate it.
    targetInstanceId: h.mode === "pinned" ? h.targetInstanceId : null,
    instructions: h.instructions.trim() || null,
  };
}

// Pure per-section readers: map a synced Agent into the editor's working state.
// Shared by `applyAgent` (initial load / post-save) and the per-tab discard, so
// reverting a section reproduces exactly what the last sync produced.
function readModelState(a: Agent) {
  const mc = a.modelConfig as Record<string, unknown>;
  return {
    provider: str(mc.provider),
    model: str(mc.model),
    credentialRef: str(mc.credentialRef),
    baseURL: str(mc.baseURL),
    temperature: num(mc.temperature),
    reasoningEffort: str(mc.reasoningEffort),
  };
}

function readBehaviorState(a: Agent) {
  const s = (a.settings ?? {}) as Record<string, unknown>;
  const d = (s.debounce ?? {}) as Record<string, unknown>;
  const st = (s.stt ?? {}) as Record<string, unknown>;
  const tt = (s.tts ?? {}) as Record<string, unknown>;
  const sp = (s.split ?? {}) as Record<string, unknown>;
  const sw = (s.serviceWindow ?? {}) as Record<string, unknown>;
  const vi = (s.vision ?? {}) as Record<string, unknown>;
  const ho = (s.handoff ?? {}) as Record<string, unknown>;
  const ka = (s.kanban ?? {}) as Record<string, unknown>;
  const tg = (s.toolGuidance ?? {}) as Record<string, unknown>;
  const li = (s.limits ?? {}) as Record<string, unknown>;
  const ac = (s.attributeContext ?? {}) as Record<string, unknown>;
  const si = (s.sendImage ?? {}) as Record<string, unknown>;
  const av = (s.availability ?? {}) as Record<string, unknown>;
  const ca = (s.contactAuth ?? {}) as Record<string, unknown>;

  // NOTE: Attribute keys per scope: plain string lists (the runtime reader trims/dedups/caps them).
  const attrKeys = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  return {
    transferWithSummary: a.transferWithSummary,
    kanbanInstructions: str(ka.instructions),
    customAttributeInstructions: str(tg.set_custom_attribute),
    labelInstructions: str(tg.assign_label),
    updateKanbanTaskInstructions: str(tg.update_kanban_task),
    toolPreconditions: parseToolPreconditionRows(s.toolPreconditions),
    businessHoursId: a.businessHoursId ?? "",
    followUpHoursId: a.followUpHoursId ?? "",
    settings: s,
    awayEnabled: av.enabled === true,
    awayMessage: str(av.awayMessage),
    debounce: {
      enabled: typeof d.enabled === "boolean" ? d.enabled : true,
      windowSeconds: num(d.windowSeconds) || "15",
      maxMessagesPerBurst: num(d.maxMessagesPerBurst) || "20",
      maxWindowSeconds: num(d.maxWindowSeconds) || "60",
    },
    stt: {
      enabled: typeof st.enabled === "boolean" ? st.enabled : true,
      provider: str(st.provider) || "openai",
      model: str(st.model),
      language: str(st.language) || "pt",
      credentialRef: str(st.credentialRef),
      baseURL: str(st.baseURL),
    },
    contactAuth: {
      enabled: ca.enabled === true,
      url: str(ca.url),
      credentialRef: str(ca.credentialRef),
      timeoutMs: num(ca.timeoutMs) || "5000",
      // NOTE: "0" is meaningful (notify on every refused message), and num(0) is the truthy
      // string "0", so the fallback only fills a genuinely absent value.
      noticeCooldownSeconds: num(ca.noticeCooldownSeconds) || "60",
      includeMessageText: ca.includeMessageText === true,
      denyMessage: str(ca.denyMessage),
      handoffEnabled:
        typeof ca.handoffEnabled === "boolean" ? ca.handoffEnabled : true,
      handoffTeamId: num(ca.handoffTeamId),
      handoffTeamInstanceId: num(ca.handoffTeamInstanceId),
    },
    tts: readTtsFormState(tt),
    split: {
      enabled: typeof sp.enabled === "boolean" ? sp.enabled : true,
      maxChars: num(sp.maxChars) || "600",
      typingWpm: num(sp.typingWpm) || "250",
      maxDelayMs: num(sp.maxDelayMs) || "8000",
    },
    serviceWindow: {
      enabled: typeof sw.enabled === "boolean" ? sw.enabled : true,
      windowHours: num(sw.windowHours) || "24",
      templateName: str(sw.templateName),
      templateLanguage: str(sw.templateLanguage) || "pt_BR",
      templateParams: Array.isArray(sw.templateParams)
        ? (sw.templateParams as unknown[])
            .filter((x): x is string => typeof x === "string")
            .join(", ")
        : "",
      templateContent: str(sw.templateContent),
    },
    followUp: followUpToForm(s),
    handoff: {
      mode: str(ho.mode) || "route",
      target: num(ho.targetAgentId)
        ? `agent:${num(ho.targetAgentId)}`
        : num(ho.targetTeamId)
          ? `team:${num(ho.targetTeamId)}`
          : "",
      targetInstanceId:
        typeof ho.targetInstanceId === "number" ? ho.targetInstanceId : null,
      instructions: str(ho.instructions),
    },
    vision: {
      enabled: typeof vi.enabled === "boolean" ? vi.enabled : false,
      provider: str(vi.provider) || "openai",
      model: str(vi.model),
      credentialRef: str(vi.credentialRef),
      baseURL: str(vi.baseURL),
      // Prefill the field with the default so the operator sees (and can tweak)
      // the real instruction; buildSettings stores null when it stays the default.
      extractionPrompt: str(vi.extractionPrompt) || DEFAULT_EXTRACTION_PROMPT,
    },
    limits: {
      maxToolCalls: num(li.maxToolCalls) || "10",
      // NOTE: Empty means no ceiling, so an absent/zero value must stay empty rather than pick up a
      // default the way maxToolCalls does.
      maxHistoryTokens: num(li.maxHistoryTokens),
    },
    attributeContext: {
      conversation: attrKeys(ac.conversation),
      contact: attrKeys(ac.contact),
      task: attrKeys(ac.task),
    },
    sendImage: { allowedHosts: attrKeys(si.allowedHosts).join("\n") },
    // NOTE: through the SAME reader the runtime uses, not a hand-rolled check: a bag that came from
    // REST or an import can carry the string "true", which the runtime honors — reading it stricter
    // here would show the switch off while values were being logged, and would then persist that lie
    // on the next save.
    observability: observabilityToForm(s),
    // NOTE: Same reason as observability above — through the runtime's own reader, because this one
    // defaults to ON and a hand-rolled `=== true` would show the switch off on every agent whose bag
    // predates the feature, then persist that lie on the next save.
    memory: memoryToForm(s),
    modelFallback: modelFallbackToForm(s),
  };
}

function intFieldOr(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Map a normalized ChannelRedirectConfig into the editor's form shape (numbers as strings, inbox refs
// as select values). Both inboxes (entry + widget) are picked manually from the tenant's synced inboxes.
function toChannelRedirectForm(
  cfg: ChannelRedirectConfig,
): ChannelRedirectFormState {
  return {
    enabled: cfg.enabled,
    entryInboxId: cfg.entryInboxId === null ? "" : String(cfg.entryInboxId),
    widgetInboxId: cfg.widgetInboxId,
    redirectMessage: cfg.redirectMessage,
    resendDelayValue: String(cfg.resendDelayValue),
    resendDelayUnit: cfg.resendDelayUnit,
    maxResends: String(cfg.maxResends),
    openWidget: cfg.openWidget,
    cloneWaMessage: cfg.cloneWaMessage,
    chatFollowupEnabled: cfg.chatFollowupEnabled,
    chatFollowupDelayValue: String(cfg.chatFollowupDelayValue),
    chatFollowupDelayUnit: cfg.chatFollowupDelayUnit,
    chatFollowupInstructions: cfg.chatFollowupInstructions,
    waFollowupEnabled: cfg.waFollowupEnabled,
    waFollowupDelayValue: String(cfg.waFollowupDelayValue),
    waFollowupDelayUnit: cfg.waFollowupDelayUnit,
    waFollowupMessage: cfg.waFollowupMessage,
    closingEnabled: cfg.closingEnabled,
    closingDelayValue: String(cfg.closingDelayValue),
    closingDelayUnit: cfg.closingDelayUnit,
    closingMessage: cfg.closingMessage,
  };
}

// Read the agent's channelRedirect block into the form (the shared reader normalizes + clamps).
function readChannelRedirectState(a: Agent): ChannelRedirectFormState {
  return toChannelRedirectForm(readChannelRedirectConfig(a.settings));
}

// Serialize the channelRedirect form back to the config shape. The backend re-clamps every numeric
// field (readChannelRedirectConfig), so out-of-range values are corrected server-side; we still parse
// defensively here so a cleared input persists the default, not NaN.
function fromChannelRedirectForm(
  f: ChannelRedirectFormState,
): ChannelRedirectConfig {
  const D = CHANNEL_REDIRECT_DEFAULTS;
  return {
    enabled: f.enabled,
    entryInboxId: f.entryInboxId ? intFieldOr(f.entryInboxId, 0) || null : null,
    widgetInboxId: f.widgetInboxId,
    redirectMessage: f.redirectMessage,
    resendDelayValue: intFieldOr(f.resendDelayValue, D.resendDelayValue),
    resendDelayUnit: f.resendDelayUnit,
    maxResends: intFieldOr(f.maxResends, D.maxResends),
    openWidget: f.openWidget,
    cloneWaMessage: f.cloneWaMessage,
    chatFollowupEnabled: f.chatFollowupEnabled,
    chatFollowupDelayValue: intFieldOr(
      f.chatFollowupDelayValue,
      D.chatFollowupDelayValue,
    ),
    chatFollowupDelayUnit: f.chatFollowupDelayUnit,
    chatFollowupInstructions: f.chatFollowupInstructions,
    waFollowupEnabled: f.waFollowupEnabled,
    waFollowupDelayValue: intFieldOr(
      f.waFollowupDelayValue,
      D.waFollowupDelayValue,
    ),
    waFollowupDelayUnit: f.waFollowupDelayUnit,
    waFollowupMessage: f.waFollowupMessage,
    closingEnabled: f.closingEnabled,
    closingDelayValue: intFieldOr(f.closingDelayValue, D.closingDelayValue),
    closingDelayUnit: f.closingDelayUnit,
    closingMessage: f.closingMessage,
  };
}

// The dirty-tracking snapshot of the channelRedirect form.
function channelRedirectSnapshot(f: ChannelRedirectFormState): string {
  return JSON.stringify(f);
}

// NOTE: Static keys so the skeleton tabs don't key off the array index (one per editor tab:
// general / channels / tools / knowledge / behavior / guardrails / channelRedirect / playground).
const EDITOR_TAB_KEYS = [
  "tab-0",
  "tab-1",
  "tab-2",
  "tab-3",
  "tab-4",
  "tab-5",
  "tab-6",
  "tab-7",
];

// Bespoke loading placeholder mirroring the editor chrome (header row + tab bar)
// and the default general-tab form (name field + tall prompt textarea + save).
function AgentEditorSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="h-6 w-6" />
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-5 w-20" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <div className="flex gap-2">
        {EDITOR_TAB_KEYS.map((key) => (
          <Skeleton key={key} className="h-8 w-24" />
        ))}
      </div>
      <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
  );
}

// The route element is REUSED when `:id` changes — cloning an agent lands straight on the clone's
// editor — and this page keeps state that only means anything for one record. `usePlaygroundChat`
// reloads its saved simulation on that transition but not the conversation itself, so without this
// the turns you had with one agent show up under the next.
//
// Keyed by the record rather than reset field by field: every one of those resets has to know when
// the thing it clears will be repopulated, and answering that per field is how a discard ends up
// stranding a value the form still needs. A different agent is a different form. `:tab` is NOT in
// the key, so moving between tabs of the same agent keeps everything, which is what it is for.
export function AgentEditorPage() {
  const { id = "" } = useParams();
  return <AgentEditor key={id} />;
}

function AgentEditor() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const { id = "", tab: tabParam } = useParams();
  // The active tab is the URL `:tab` segment; an unknown value falls back to
  // "general" (and is normalized in the effect below so the URL stays canonical).
  const tab: TabKey = TAB_KEYS.includes(tabParam as TabKey)
    ? (tabParam as TabKey)
    : "general";

  // Origin breadcrumb (item 14): when the operator reached this editor from a conversation
  // ("Configure agent"), `?from=/conversations/:id` lets us offer a one-click way back. Validated to
  // an internal conversation path so it can never become an open redirect.
  const [searchParams] = useSearchParams();
  const fromParam = searchParams.get("from");
  const backToConversation =
    fromParam && /^\/conversations\/\d+$/.test(fromParam) ? fromParam : null;

  const location = useLocation();
  // Import warnings threaded from AgentsPage (item 1): captured once at mount, shown as a dismissible
  // banner so the operator sees exactly what was skipped/unset on import.
  const [importWarnings, setImportWarnings] = useState<ImportWarning[]>(
    () =>
      (location.state as { importWarnings?: ImportWarning[] } | null)
        ?.importWarnings ?? [],
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);
  const [savingGrants, setSavingGrants] = useState(false);
  const [savingChannelRedirect, setSavingChannelRedirect] = useState(false);
  const [savingGuardrails, setSavingGuardrails] = useState(false);

  // Agent fields
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [agentMode, setAgentMode] = useState<"test" | "production">(
    "production",
  );
  const [transferWithSummary, setTransferWithSummary] = useState(true);
  const [businessHoursId, setBusinessHoursId] = useState("");
  const [awayEnabled, setAwayEnabled] = useState(false);
  const [awayMessage, setAwayMessage] = useState("");
  const [followUpHoursId, setFollowUpHoursId] = useState("");
  // Free-form settings bag, preserved on save so editing one section never wipes another
  // (e.g. grounding). The debounce sub-state mirrors settings.debounce (see modules/debounce).
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [debounce, setDebounce] = useState({
    enabled: true,
    windowSeconds: "15",
    maxMessagesPerBurst: "20",
    maxWindowSeconds: "60",
  });
  // Speech-to-text (voice notes). Provider list mirrors modules/stt/providers.
  const [stt, setStt] = useState({
    enabled: true,
    provider: "openai",
    model: "",
    language: "pt",
    credentialRef: "",
    baseURL: "",
  });
  // Contact authorization gate. Mirrors agent.settings.contactAuth (modules/contact-auth).
  const [contactAuth, setContactAuth] = useState<ContactAuthState>({
    enabled: false,
    url: "",
    credentialRef: "",
    timeoutMs: "5000",
    noticeCooldownSeconds: "60",
    includeMessageText: false,
    denyMessage: "",
    handoffEnabled: true,
    handoffTeamId: "",
    handoffTeamInstanceId: "",
  });
  // Text-to-speech (audio replies). Mode + provider mirror modules/tts.
  // Same reader the saved agent goes through, so a new field can never exist in one and not the
  // other: the Behavior save REPLACES this block wholesale.
  const [tts, setTts] = useState(() => readTtsFormState({}));
  // Reply in multiple messages (split + typing delay). Mirrors modules/split
  // (on by default, wpm 250 — matches SPLIT_DEFAULTS).
  const [split, setSplit] = useState({
    enabled: true,
    maxChars: "600",
    typingWpm: "250",
    maxDelayMs: "8000",
  });
  // Proactive follow-up sequence. Mirrors agent.settings.followUp ({ enabled, steps[] }).
  const [followUp, setFollowUp] = useState({
    enabled: false,
    steps: [
      {
        delayValue: "30",
        delayUnit: "minutes",
        instructions: "",
        assignLabels: [] as string[],
        resolve: false,
        ignoreAppointmentPause: false,
      },
    ],
    pauseWhileAppointment: true,
  });
  // Image/document extraction (vision). Mirrors agent.settings.vision (modules/vision).
  const [vision, setVision] = useState({
    enabled: false,
    provider: "openai",
    model: "",
    credentialRef: "",
    baseURL: "",
    extractionPrompt: DEFAULT_EXTRACTION_PROMPT,
  });
  // Runtime limits. Mirrors agent.settings.limits (modules/agents/limits): the per-turn tool-call
  // cap and the per-turn history ceiling.
  const [limits, setLimits] = useState({
    maxToolCalls: "10",
    maxHistoryTokens: "",
  });
  // Whether this agent's tool lines log the values the model sent instead of their shape, and
  // whether the log debug mode is armed. Mirrors agent.settings.observability
  // (modules/flowlog/settings), and seeded from the reader over an empty bag rather than a literal
  // so a field added to that block cannot default differently here than it does at runtime.
  // Null until the tenant settings answer, which reads as "not known yet" and never as "off".
  const [langfuseSendContent, setLangfuseSendContent] = useState<
    boolean | null
  >(null);
  const [observability, setObservability] = useState(observabilityToForm({}));
  // What the SERVER is doing, as opposed to what the form is about to ask it to do. The "recording
  // more than the default" warning reads this one, never the form: a switch flipped off stops
  // recording when the save lands, not when the operator touches it, and a warning that goes quiet
  // on the touch tells them recording stopped while it is still running. Set only where a server
  // read set the form (load, post-save refresh, discard), never by a switch.
  const [savedObservability, setSavedObservability] = useState(
    observabilityToForm({}),
  );
  // Whether an attendance that ended is folded into a summary, and which model writes it. Seeded
  // from the reader over an empty bag rather than a literal: the pre-load state is the same shape
  // the round-trip pair produces, so a field added to `compaction` cannot default differently here
  // than it does everywhere else.
  const [memory, setMemory] = useState<MemoryState>(() => memoryToForm({}));
  const [modelFallback, setModelFallback] = useState<ModelFallbackState>(() =>
    modelFallbackToForm({}),
  );
  // NOTE: Hosts the send_image tool may fetch from. Mirrors agent.settings.sendImage
  // (modules/images/settings), edited as one host per line.
  const [sendImage, setSendImage] = useState<SendImageState>({
    allowedHosts: "",
  });
  // NOTE: Which Chatwoot custom attributes are injected into the prompt as current values, per
  // scope. Mirrors agent.settings.attributeContext (modules/chatwoot/attributes).
  const [attributeContext, setAttributeContext] = useState<{
    conversation: string[];
    contact: string[];
    task: string[];
  }>({ conversation: [], contact: [], task: [] });
  // WhatsApp → website-chat redirect. Its own editor section (own Save + dirty tracking), though the
  // config lives in agent.settings.channelRedirect. Mirrors modules/channel-redirect/service.
  const [channelRedirect, setChannelRedirect] =
    useState<ChannelRedirectFormState>(() =>
      toChannelRedirectForm(CHANNEL_REDIRECT_DEFAULTS),
    );
  // Guardrails (input/output moderation). Own editor section (own Save + dirty tracking); the form
  // state is the config shape (agent.settings.guardrails).
  const [guardrails, setGuardrails] = useState<GuardrailsConfig>(() =>
    structuredClone(GUARDRAILS_DEFAULTS),
  );
  // WhatsApp 24h service window (proactive sends). Mirrors modules/service-window.
  const [serviceWindow, setServiceWindow] = useState({
    enabled: true,
    windowHours: "24",
    templateName: "",
    templateLanguage: "pt_BR",
    templateParams: "",
    templateContent: "",
  });
  // Handoff targeting: who receives a handed-off conversation (route | pinned | agent_choice).
  const [handoff, setHandoff] = useState<HandoffUiState>({
    mode: "route",
    target: "",
    targetInstanceId: null,
    instructions: "",
  });
  // Operator funnel guidance for kanban_move_card (Tools-tab config, like handoff). Synced only by
  // syncToolConfig (NOT applyAgent), so a Behavior save never wipes an unsaved edit here.
  const [kanbanInstructions, setKanbanInstructions] = useState("");
  // Operator usage guidance for set_custom_attribute + assign_label (Tools-tab config, like kanban).
  // Persisted in agent.settings.toolGuidance; synced only by syncToolConfig.
  const [customAttributeInstructions, setCustomAttributeInstructions] =
    useState("");
  const [labelInstructions, setLabelInstructions] = useState("");
  // Operator usage guidance for update_kanban_task (Tools-tab config). Persisted in
  // agent.settings.toolGuidance.update_kanban_task; synced only by syncToolConfig.
  // Per-tool preconditions (Tools tab, same lifecycle as the guidance above). Held as a LIST while
  // editing and stored as a map keyed by tool name — see ToolPreconditionsEditor.
  const [toolPreconditions, setToolPreconditions] = useState<
    ToolPreconditionRow[]
  >([]);
  const [updateKanbanTaskInstructions, setUpdateKanbanTaskInstructions] =
    useState("");
  // Model config (flattened). Cost tracking comes from Langfuse, so there is no
  // per-agent pricing here anymore.
  const [model, setModel] = useState({
    provider: "",
    model: "",
    credentialRef: "",
    baseURL: "",
    temperature: "",
    reasoningEffort: "",
  });
  // The endpoint each selected credential carries, which OUTRANKS the typed field wherever one is
  // shown. Resolved from the vault, not from the pickers: the page judges these on every tab, and
  // one tab's picker is unmounted while another is on screen. Only ever mirrored, never merged into
  // the form — each field displays `credBaseUrl ?? form.baseURL` and is disabled while a credential
  // provides it, so the operator's own value is never overwritten and never needs giving back.
  const vaultBaseUrl = useVaultBaseUrls();
  const modelCredBaseUrl = vaultBaseUrl(model.credentialRef);
  const sttCredBaseUrl = vaultBaseUrl(stt.credentialRef);
  const visionCredBaseUrl = vaultBaseUrl(vision.credentialRef);
  const memoryCredBaseUrl = vaultBaseUrl(memory.credentialRef);
  const modelFallbackCredBaseUrl = vaultBaseUrl(modelFallback.credentialRef);
  const ttsNormalizeCredBaseUrl = vaultBaseUrl(tts.normalizeCredentialRef);

  // Tool selection
  const [grants, setGrants] = useState<GrantState[]>([]);
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  // Discovered MCP tools + per-connection collapse state, kept here (not in ToolGrantsEditor) so the
  // discovery survives switching agent tabs — the operator doesn't have to re-Discover.
  const [mcpTools, setMcpTools] = useState<Record<string, DiscoveredMcpTool[]>>(
    {},
  );
  const [mcpInstructions, setMcpInstructions] = useState<
    Record<string, string | null>
  >({});
  const [mcpCollapsed, setMcpCollapsed] = useState<Record<string, boolean>>({});
  const [integrationCollapsed, setIntegrationCollapsed] = useState<
    Record<string, boolean>
  >({});

  // Pools
  const [hours, setHours] = useState<Hours[]>([]);
  // The Availability the prompt preview resolves {{esta_aberto}} & co. against: the schedule this
  // agent is bound to, as the Behavior tab currently has it (unsaved changes included, so the preview
  // answers for the schedule the operator is looking at). Not configured → null, which the runtime and
  // the gate both read as always on.
  const promptAvailability = useMemo(() => {
    const h = hours.find((x) => String(x.id) === businessHoursId);
    // Built field by field rather than passed through: the sibling picker guards windows/exceptions
    // with `?? []` for rows that come back without them, and a preview is not the place to find out.
    return {
      schedule: h
        ? {
            windows: (h.windows ?? []) as Schedule["windows"],
            exceptions: (h.exceptions ?? []) as Schedule["exceptions"],
            timezone: h.timezone,
          }
        : null,
    };
  }, [hours, businessHoursId]);

  const confirm = useModalController<ConfirmPayload>();
  const cloneModal = useModalController();
  // Fill a pending credential without leaving the editor (opened from a config-health warning).
  const fillCredModal = useModalController<VaultEntry>();
  const exportModal = useModalController();
  const [cloneName, setCloneName] = useState("");
  // The suggested name prefilled on open; the modal only warns about discarding
  // when the user actually edited it.
  const cloneNameDefaultRef = useRef("");
  // Per-section sync counters: bumping a section recaptures ONLY that section's unsaved-changes
  // baseline (below) from the freshly-synced state. Per-section (not one global counter) so saving
  // one tab never re-baselines another tab's pending edits — which would silently mask (and, via the
  // old full applyAgent, drop) unsaved changes made in a different tab or browser.
  const [sectionSync, setSectionSync] = useState<Record<SectionKey, number>>({
    general: 0,
    behavior: 0,
    channelRedirect: 0,
    guardrails: 0,
    tools: 0,
    knowledge: 0,
  });
  const bumpSync = useCallback((...keys: SectionKey[]) => {
    setSectionSync((s) => {
      const next = { ...s };
      for (const k of keys) next[k] += 1;
      return next;
    });
  }, []);

  // The agent's version token (updatedAt) the editor last loaded/saved. Sent as the save precondition
  // (optimistic concurrency) and compared against realtime agent-config events to flag external edits.
  // A ref (not state) so saves read the freshest value without a re-render dependency.
  const loadedUpdatedAtRef = useRef<string | null>(null);
  // Counts this editor's own in-flight saves. While > 0, the realtime agent-config echo of OUR OWN
  // write is ignored, so it can't flicker the "changed elsewhere" banner in the window between the
  // server advancing the token (and broadcasting) and our markSynced recording it. A genuine
  // concurrent write during a save is still caught by the updatedAt precondition (409 → handleConflict).
  const savingRef = useRef(0);
  // "Changed elsewhere" banner: set by a realtime agent-config event for a newer version, or by a 409
  // save rejection. `conflictRetry` (when set) re-runs the rejected save, overwriting on purpose.
  const [staleNotice, setStaleNotice] = useState(false);
  const [conflictRetry, setConflictRetry] = useState<(() => void) | null>(null);

  // The last server-synced agent/grants, kept so a discard can restore the
  // baseline (the JSON snapshot only detects drift; it can't rehydrate state).
  const syncedAgentRef = useRef<Agent | null>(null);
  const syncedGrantsRef = useRef<ToolSelectionView["grants"]>([]);

  // transferWithSummary + handoff + kanban guidance are config of native tools, owned by the Tools tab.
  // They are synced from the server here (load / discard-all / Tools save / Tools revert) and
  // deliberately NOT reset by applyAgent — otherwise a General/Behavior save (which calls applyAgent)
  // would wipe a pending, unsaved Tools edit.
  const syncToolConfig = useCallback((a: Agent) => {
    const b = readBehaviorState(a);
    setTransferWithSummary(b.transferWithSummary);
    setHandoff(b.handoff);
    setKanbanInstructions(b.kanbanInstructions);
    setCustomAttributeInstructions(b.customAttributeInstructions);
    setLabelInstructions(b.labelInstructions);
    setUpdateKanbanTaskInstructions(b.updateKanbanTaskInstructions);
    setToolPreconditions(b.toolPreconditions);
  }, []);

  // Full reset of the general + behavior form state from a synced agent. Used on load and discard-all
  // (NOT on a single-section save — that would clobber other tabs' unsaved edits). Callers bump the
  // relevant section sync counters afterward to recapture baselines.
  const applyAgent = useCallback((a: Agent) => {
    syncedAgentRef.current = a;
    setName(a.name);
    setSystemPrompt(a.systemPrompt);
    setEnabled(a.enabled);
    setAgentMode(a.mode === "test" ? "test" : "production");
    setModel(readModelState(a));
    const b = readBehaviorState(a);
    setBusinessHoursId(b.businessHoursId);
    setAwayEnabled(b.awayEnabled);
    setAwayMessage(b.awayMessage);
    setFollowUpHoursId(b.followUpHoursId);
    setSettings(b.settings);
    setDebounce(b.debounce);
    setStt(b.stt);
    setContactAuth(b.contactAuth);
    setTts(b.tts);
    setSplit(b.split);
    setServiceWindow(b.serviceWindow);
    setFollowUp(b.followUp);
    setVision(b.vision);
    setLimits(b.limits);
    setObservability(b.observability);
    setSavedObservability(b.observability);
    setMemory(b.memory);
    setModelFallback(b.modelFallback);
    setSendImage(b.sendImage);
    setAttributeContext(b.attributeContext);
    setChannelRedirect(readChannelRedirectState(a));
    setGuardrails(readGuardrailsFormState(a.settings));
  }, []);

  // Reset ONLY the general section (identity + model) from a synced agent — the post-save sync for the
  // General tab, leaving every other tab's pending edits untouched.
  const applyGeneral = useCallback((a: Agent) => {
    syncedAgentRef.current = a;
    setName(a.name);
    setSystemPrompt(a.systemPrompt);
    setEnabled(a.enabled);
    setAgentMode(a.mode === "test" ? "test" : "production");
    setModel(readModelState(a));
  }, []);

  // Reset ONLY the behavior section from a synced agent — the post-save sync for the Behavior tab.
  const applyBehavior = useCallback((a: Agent) => {
    syncedAgentRef.current = a;
    const b = readBehaviorState(a);
    setBusinessHoursId(b.businessHoursId);
    setAwayEnabled(b.awayEnabled);
    setAwayMessage(b.awayMessage);
    setFollowUpHoursId(b.followUpHoursId);
    setSettings(b.settings);
    setDebounce(b.debounce);
    setStt(b.stt);
    setContactAuth(b.contactAuth);
    setTts(b.tts);
    setSplit(b.split);
    setServiceWindow(b.serviceWindow);
    setFollowUp(b.followUp);
    setVision(b.vision);
    setLimits(b.limits);
    setObservability(b.observability);
    setSavedObservability(b.observability);
    setMemory(b.memory);
    setModelFallback(b.modelFallback);
    setSendImage(b.sendImage);
    setAttributeContext(b.attributeContext);
  }, []);

  // Reset ONLY the channelRedirect section from a synced agent — the post-save sync for the Redirect tab.
  const applyChannelRedirect = useCallback((a: Agent) => {
    syncedAgentRef.current = a;
    setChannelRedirect(readChannelRedirectState(a));
  }, []);

  // Reset ONLY the guardrails section from a synced agent — the post-save sync for the Guardrails tab.
  const applyGuardrails = useCallback((a: Agent) => {
    syncedAgentRef.current = a;
    setGuardrails(readGuardrailsFormState(a.settings));
  }, []);

  const loadHours = useCallback(async () => {
    const { data } = await api.api.v1["business-hours"].get();
    if (data) setHours([...data.businessHours]);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [agentRes, tsRes, hoursRes] = await Promise.all([
        api.api.v1.agents({ id }).get(),
        api.api.v1.agents({ id })["tool-selections"].get(),
        api.api.v1["business-hours"].get(),
      ]);
      // Only for the shared debug warning (#58): the third switch that widens what is recorded is
      // the tenant's `langfuse.sendContent`, and it lives on another page. Deliberately OUTSIDE the
      // load above and not awaited with it — the warning is allowed to say less, never to hold the
      // editor open or send it to the error state, and inside that `Promise.all` a slow or refused
      // optional read would do both.
      void api.api.v1["tenant-settings"]
        .get()
        .then((r) =>
          setLangfuseSendContent(r.data?.langfuse.sendContent ?? null),
        )
        .catch(() => setLangfuseSendContent(null));
      if (agentRes.error || !agentRes.data || tsRes.error || !tsRes.data) {
        setError(true);
        return;
      }
      applyAgent(agentRes.data.agent);
      syncToolConfig(agentRes.data.agent);
      syncedGrantsRef.current = tsRes.data.grants;
      setGrants(mapGrants(tsRes.data.grants));
      setCatalog(tsRes.data.catalog);
      loadedUpdatedAtRef.current = String(agentRes.data.agent.updatedAt);
      bumpSync(...SECTION_KEYS);
      setStaleNotice(false);
      setConflictRetry(null);
      // The other half of the sync tick. A reload is an explicit "tell me the current state", and
      // without it the server-read parts of the page would answer with whatever they read the first
      // time, which is the state the operator just asked to replace.
      setServerSyncTick((n) => n + 1);
      if (hoursRes.data) setHours([...hoursRes.data.businessHours]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [id, applyAgent, syncToolConfig, bumpSync]);

  // Realtime heads-up: another tab / operator / the API / the MCP server changed this agent. Flag the
  // banner only when the incoming version is newer than what we loaded (so our own save echoing back,
  // which advances loadedUpdatedAtRef first, never self-triggers).
  useTenantEvents({
    onAgentConfig: (e) => {
      if (e.agentId !== id) return;
      // Suppress the echo of our own in-flight save (see savingRef). The precondition is the real guard.
      if (savingRef.current > 0) return;
      const loaded = loadedUpdatedAtRef.current;
      if (
        loaded &&
        new Date(e.updatedAt).getTime() > new Date(loaded).getTime()
      ) {
        setStaleNotice(true);
      }
    },
  });

  useEffect(() => {
    void load();
  }, [load]);

  // When the operator returns from a Resources tab (opened via the "New" links in the tool/knowledge
  // editors), refetch ONLY the catalog so a freshly-created tool/server/integration/base appears,
  // without touching in-progress grant edits (grants stay local).
  const refreshCatalog = useCallback(async () => {
    try {
      const { data } = await api.api.v1.agents({ id })["tool-selections"].get();
      if (data) setCatalog(data.catalog);
    } catch {
      // best-effort
    }
  }, [id]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshCatalog();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshCatalog]);

  // Knowledge-base documents manager, reused for the config-health "index" deep-link: the warning opens
  // the base's documents modal straight from the editor. onChanged refetches the catalog so the warning
  // clears once everything is indexed.
  const knowledgeManager = useKnowledgeManager({
    onChanged: refreshCatalog,
    allowDocumentEdits: true,
  });

  // Step-up gate for deleting the agent (re-type the name + password), mirroring the Chatwoot teardown.
  const strongDelete = useModalController<StrongConfirmPayload>();
  // In-editor edit modals for the import-warning "Revisar" deep-links: a reused tool/MCP/integration
  // opens its OWN editor right here (view the merged result) instead of bouncing to the resources page.
  // They fetch the full record by id; onSaved refetches the catalog so any tweak reflects immediately.
  const toolEditModal = useModalController<{ id?: string }>();
  const mcpEditModal = useModalController<{ id?: string }>();
  const integrationEditModal = useModalController<{ id?: string }>();
  // A reused-schedule "Review" opens the schedule's OWN editor in place (a business-hours warning has
  // no resource id in the catalog, so we fetch the list and match by name before opening).
  const businessHoursReviewModal = useModalController<{ id: string }>();
  const [businessHoursReviewItem, setBusinessHoursReviewItem] =
    useState<Hours | null>(null);

  // Normalize an unknown `:tab` segment to the canonical /general URL.
  useEffect(() => {
    if (id && tabParam && !TAB_KEYS.includes(tabParam as TabKey)) {
      navigate(`/agents/${id}/general`, { replace: true });
    }
  }, [id, tabParam, navigate]);

  // Surface the agent's name (not its opaque id) in the header breadcrumb.
  useBreadcrumbLabel(id ? `/agents/${id}` : null, name || null);

  // With a provider chosen, ALWAYS serialize the full shape: collapsing to {} when the model name
  // was empty used to wipe credential/baseURL/temperature on save. An empty model is a valid config
  // for openai-compatible ("the server's default"); other providers are blocked by
  // guardModelBeforeSave below (the backend schema rejects them too).
  function buildModelConfig(): Record<string, unknown> {
    if (!model.provider) return {};
    const cfg: Record<string, unknown> = {
      provider: model.provider,
      model: model.model.trim(),
    };
    if (model.credentialRef) cfg.credentialRef = model.credentialRef;
    if (model.baseURL.trim()) cfg.baseURL = model.baseURL.trim();
    if (model.temperature !== "") cfg.temperature = Number(model.temperature);
    // Only openai has the endpoint that carries reasoning together with tools, and the backend
    // schema rejects the field on every other provider — so a leftover value from a provider swap
    // must not be serialized.
    if (model.reasoningEffort && model.provider === "openai")
      cfg.reasoningEffort = model.reasoningEffort;
    return cfg;
  }

  // Preflight for any save that writes modelConfig: a missing model name is only acceptable for
  // openai-compatible. Everyone else gets a clear toast instead of a 400 (or, worse, a wipe).
  function guardModelBeforeSave(): boolean {
    if (
      model.provider &&
      !modelOptionalFor(model.provider) &&
      !model.model.trim()
    ) {
      showToast(
        t(
          "editor.modelRequired",
          "Pick a model for this provider before saving.",
        ),
        "error",
      );
      return false;
    }
    return true;
  }

  // Merge the debounce sub-form back into the preserved settings bag (the server clamps the values;
  // see modules/debounce/settings). Spreading `settings` keeps any other keys (e.g. grounding).
  function buildSettings(): Record<string, unknown> {
    return {
      ...settings,
      // NOTE: channelRedirect is intentionally NOT overridden from the live form here. It is its own
      // editor section with its own Save (saveChannelRedirect merges it onto the synced settings), so
      // reading the live channelRedirect form in a Behavior save would clobber that tab's unsaved
      // edits. The `...settings` spread preserves the last-synced channelRedirect; saveChannelRedirect
      // keeps that bag in step after its own write (same pattern as saveTools does for handoff/kanban).
      availability: { enabled: awayEnabled, awayMessage: awayMessage.trim() },
      debounce: {
        enabled: debounce.enabled,
        windowSeconds: Number(debounce.windowSeconds) || 15,
        maxMessagesPerBurst: Number(debounce.maxMessagesPerBurst) || 20,
        maxWindowSeconds: Number(debounce.maxWindowSeconds) || 60,
      },
      stt: {
        enabled: stt.enabled,
        provider: stt.provider,
        model: stt.model.trim(),
        language: stt.language.trim() || "pt",
        credentialRef: stt.credentialRef || null,
        // When the credential has a baseUrl, the runtime uses it; don't overwrite with the
        // displayed (credential's) value — keep the user's own config or null.
        baseURL: stt.baseURL.trim() || null,
      },
      contactAuth: {
        enabled: contactAuth.enabled,
        url: contactAuth.url.trim() || null,
        credentialRef: contactAuth.credentialRef || null,
        timeoutMs: Number(contactAuth.timeoutMs) || 5000,
        // NOTE: 0 is meaningful (notify on every refused message), so `|| 60` would erase it;
        // only an emptied field falls back to the default.
        noticeCooldownSeconds:
          contactAuth.noticeCooldownSeconds.trim() === ""
            ? 60
            : Math.max(0, Number(contactAuth.noticeCooldownSeconds) || 0),
        // NOTE: Stored even under GET (the runtime reader ignores it there), so flipping the
        // method back and forth does not lose the choice.
        includeMessageText: contactAuth.includeMessageText,
        denyMessage: contactAuth.denyMessage.trim() || null,
        handoffEnabled: contactAuth.handoffEnabled,
        handoffTeamId: Number(contactAuth.handoffTeamId) || null,
        // The account the team was picked from, saved with it. Never on its own: without a team it
        // pins nothing, and a leftover from a cleared choice would outlive what it described.
        handoffTeamInstanceId: contactAuth.handoffTeamId
          ? Number(contactAuth.handoffTeamInstanceId) || null
          : null,
      },
      tts: ttsSettingsFrom(tts),
      split: {
        enabled: split.enabled,
        maxChars: Number(split.maxChars) || 600,
        typingWpm: Number(split.typingWpm) || 250,
        maxDelayMs: Number(split.maxDelayMs) || 8000,
      },
      serviceWindow: {
        enabled: serviceWindow.enabled,
        windowHours: Number(serviceWindow.windowHours) || 24,
        templateName: serviceWindow.templateName.trim() || null,
        templateLanguage: serviceWindow.templateLanguage.trim() || "pt_BR",
        templateCategory: "UTILITY",
        templateParams: serviceWindow.templateParams
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
        templateContent: serviceWindow.templateContent.trim() || null,
      },
      followUp: followUpToStored(followUp),
      vision: {
        enabled: vision.enabled,
        provider: vision.provider,
        model: vision.model.trim(),
        credentialRef: vision.credentialRef || null,
        // When the credential carries a baseUrl, the runtime uses it; keep the user's own value
        // (or null) instead of persisting the displayed credential URL (mirror STT).
        baseURL: vision.baseURL.trim() || null,
        // Store null when the prompt is empty or still the default (keeps storage
        // clean; the reader re-prefills the default on load — no false-dirty).
        extractionPrompt:
          vision.extractionPrompt.trim() &&
          vision.extractionPrompt.trim() !== DEFAULT_EXTRACTION_PROMPT
            ? vision.extractionPrompt.trim()
            : null,
      },
      limits: {
        maxToolCalls: Number(limits.maxToolCalls) || 10,
        // NOTE: An emptied field is how the operator turns the ceiling OFF, so it has to reach the
        // API as null. `Number("") || 0` would send 0, which the reader also reads as off, but null
        // is what "not configured" means everywhere else in this payload.
        maxHistoryTokens: Number(limits.maxHistoryTokens) || null,
      },
      // NOTE: through the pair, for the same reason `memory` below is — this save REPLACES the
      // block, so a field written out by hand here is deleted from the bag the moment someone
      // forgets it. ./observabilityFormState is the round-trip guard.
      observability: observabilityToStored(observability),
      // NOTE: through the pair, not spelled out here. The Behavior save REPLACES the block, so a
      // field the form dropped would be deleted on the next save — which is exactly how
      // `tts.baseURL` was lost once, and the round-trip test over ./memoryFormState is the guard.
      memory: memoryToStored(memory),
      modelFallback: modelFallbackToStored(modelFallback),
      attributeContext: {
        conversation: attributeContext.conversation,
        contact: attributeContext.contact,
        task: attributeContext.task,
      },
      sendImage: {
        allowedHosts: sendImage.allowedHosts
          .split("\n")
          .map((h) => h.trim())
          .filter(Boolean),
      },
    };
  }

  // Serialize the editable surface per tab so we can both (a) drive the
  // unsaved-changes guard (any section dirty) and (b) flag the exact tab(s)
  // that changed with a dot. Tools and Knowledge both edit the shared `grants`,
  // so a grants change flags both. Compared to the last server-synced baseline.
  // Grants are one array but split across two tabs by source: RAG → Knowledge,
  // everything else → Tools. Snapshot each subset so toggling one tab's grant
  // doesn't light up the other (each editor preserves the other's subset).
  const sectionSnap = {
    // General covers identity + model (the tabs merged). Track the raw model
    // form state, not buildModelConfig() — the latter collapses to {} until
    // provider+model are both set and drops empty/normalized fields, so editing
    // temperature/baseURL/credential wouldn't register as dirty.
    general: JSON.stringify({ name, systemPrompt, enabled, agentMode, model }),
    // Track the behavior FORM state directly (not buildSettings(), which spreads the whole settings
    // bag including tool-owned handoff/kanban) so a Tools save never falsely lights up Behavior's dot.
    behavior: JSON.stringify({
      businessHoursId,
      awayEnabled,
      awayMessage,
      followUpHoursId,
      debounce,
      stt,
      contactAuth,
      tts,
      split,
      serviceWindow,
      followUp,
      vision,
      limits,
      attributeContext,
      sendImage,
      observability,
      memory,
      modelFallback,
    }),
    // The WhatsApp→website-chat redirect (own Save button). widgetInboxId is excluded (server-owned,
    // persisted on provision), so provisioning the widget never lights up this tab's unsaved-changes dot.
    channelRedirect: channelRedirectSnapshot(channelRedirect),
    // Guardrails (own Save button) — the full config JSON.
    guardrails: JSON.stringify(guardrails),
    // transferWithSummary + handoff are config of the handoff_to_human tool (Tools tab), saved with
    // the grant set, so they flag the Tools tab's unsaved-changes dot — not Behavior's.
    tools: JSON.stringify({
      grants: canonicalGrants(grants.filter((g) => g.source !== "RAG")),
      transferWithSummary,
      handoff,
      kanbanInstructions,
      customAttributeInstructions,
      labelInstructions,
      updateKanbanTaskInstructions,
      toolPreconditions,
    }),
    knowledge: canonicalGrants(grants.filter((g) => g.source === "RAG")),
  };
  const baselineRef = useRef<typeof sectionSnap | null>(null);
  const lastSyncRef = useRef<Record<SectionKey, number>>({
    general: -1,
    behavior: -1,
    channelRedirect: -1,
    guardrails: -1,
    tools: -1,
    knowledge: -1,
  });
  // Recapture each section's baseline during the render that follows ITS server sync (bumpSync for
  // that section); `sectionSnap` already reflects the freshly-synced state there. Per-section (not a
  // single token) so saving one tab leaves the others' baselines — and unsaved-changes dots — intact.
  if (baselineRef.current === null) {
    baselineRef.current = { ...sectionSnap };
  }
  for (const k of SECTION_KEYS) {
    if (lastSyncRef.current[k] !== sectionSync[k]) {
      lastSyncRef.current[k] = sectionSync[k];
      baselineRef.current = { ...baselineRef.current, [k]: sectionSnap[k] };
    }
  }
  const baseline = baselineRef.current;
  const dirty = {
    general: !!baseline && sectionSnap.general !== baseline.general,
    behavior: !!baseline && sectionSnap.behavior !== baseline.behavior,
    channelRedirect:
      !!baseline && sectionSnap.channelRedirect !== baseline.channelRedirect,
    guardrails: !!baseline && sectionSnap.guardrails !== baseline.guardrails,
    tools: !!baseline && sectionSnap.tools !== baseline.tools,
    knowledge: !!baseline && sectionSnap.knowledge !== baseline.knowledge,
  };
  const anyDirty =
    dirty.general ||
    dirty.behavior ||
    dirty.channelRedirect ||
    dirty.guardrails ||
    dirty.tools ||
    dirty.knowledge;

  // What the vault holds, for the two credential states the panel below can only see from the list:
  // referenced but not filled yet (created via the MCP credential_create tool, say), and referenced
  // but not there at all (deleted, or a name written over REST/MCP that no resolver matches). Both
  // refresh on any vault change (e.g. the operator fills the secret), so a warning clears without a
  // manual reload.
  const {
    known: knownRefs,
    pending: pendingRefs,
    pendingEntries,
  } = useVaultRefs();

  // The tenant's embedding credential ref — a prerequisite for indexing knowledge bases. Loaded once so
  // config health can, when a base needs indexing, point at the real blocker (embedding unconfigured, or
  // its credential still pending) instead of a per-base "index me" that would just fail.
  const [embeddingCredentialRef, setEmbeddingCredentialRef] = useState("");
  useEffect(() => {
    let alive = true;
    api.api.v1["tenant-settings"].get().then(({ data }) => {
      if (alive && data)
        setEmbeddingCredentialRef(data.embedding.credentialRef ?? "");
    });
    return () => {
      alive = false;
    };
  }, []);

  // What the guardrail screen actually DID lately, for the panel below. Configuration cannot answer
  // it: a retired model id, a parameter the vendor rejects and a chronic timeout are all valid
  // configuration until the call is made, and the pass is fail-open, so each one delivers messages
  // as if they had been reviewed.
  //
  // A snapshot, not a subscription, and `serverSyncTick` is what decides when it is retaken: every
  // successful load (including the Reload the stale-state banner offers) and every successful save.
  // Those are the two moments the operator expects a fresh answer. Nothing is fetched before the
  // first load completes (the tick starts at 0), so the page does not spend a request answering a
  // question about an agent it has not read yet.
  //
  // It does NOT follow live traffic. An editor left open does not learn about failures that started
  // meanwhile, and closing that gap by polling costs a request a minute on every open editor to
  // shorten a wait that ends the next time anybody loads or saves.
  //
  // A request that fails clears the snapshot instead of leaving the last one on screen, and a null
  // snapshot is read by the panel as "nothing to say" rather than as a warning. Both halves are the
  // same call the panel already makes for an unloaded vault list: under-reporting for a moment is
  // the safe direction, because a stale count invites acting on a number nobody can vouch for, and
  // a line saying the console could not reach its own API is not actionable from this screen.
  const [serverSyncTick, setServerSyncTick] = useState(0);
  const [guardrailHealth, setGuardrailHealth] =
    useState<GuardrailHealthResp | null>(null);
  const guardrailsOn = guardrails.enabled;
  useEffect(() => {
    if (!id || !guardrailsOn || serverSyncTick === 0) {
      setGuardrailHealth(null);
      return;
    }
    let alive = true;
    api.api.v1
      .agents({ id })
      .guardrails.health.get()
      .then(({ data }) => {
        if (!alive) return;
        setGuardrailHealth(data ?? null);
      })
      .catch(() => {
        if (alive) setGuardrailHealth(null);
      });
    return () => {
      alive = false;
    };
  }, [id, guardrailsOn, serverSyncTick]);

  // Chatwoot's OWN out-of-hours reply, on the inboxes this agent is bound to. Same snapshot rule as
  // the reading above, and live on the server rather than read off the inbox mirror: the mirror is
  // only as fresh as the last time somebody pressed Sync, so a mirrored copy would keep warning
  // about a reply that was switched off weeks ago and there would be nowhere on this page to clear
  // it. An unreachable Chatwoot comes back as an empty list, which is silence.
  //
  // NOT gated on this agent's own away message being on, because the collision does not need it: an
  // agent with nothing to say out of hours still answers through the closure Chatwoot just announced.
  const [outOfOfficeInboxes, setOutOfOfficeInboxes] = useState<
    { id: string; name: string }[]
  >([]);
  useEffect(() => {
    if (!id || serverSyncTick === 0) {
      setOutOfOfficeInboxes([]);
      return;
    }
    let alive = true;
    api.api.v1
      .agents({ id })
      .inboxes["out-of-office"].get()
      .then(({ data }) => {
        if (alive) setOutOfOfficeInboxes(data?.inboxes ?? []);
      })
      .catch(() => {
        if (alive) setOutOfOfficeInboxes([]);
      });
    return () => {
      alive = false;
    };
  }, [id, serverSyncTick]);

  // Live config-health (item 1): features turned on but missing the credential they need to run, OR
  // referencing a credential whose secret is not filled in yet (pending). The import that strips
  // secrets is the common trigger; each issue deep-links to its tab + section, or to the vault fill
  // modal when pending. Per-issue messages (dynamic key by issue.key) registered for extraction:
  // t('editor.configIssue.model', 'The model has no API key set, so the agent cannot reply.')
  // t('editor.configIssue.stt', 'Voice transcription is on but has no API key set.')
  // t('editor.configIssue.tts', 'Audio replies are on but have no API key set.')
  // t('editor.configIssue.ttsNormalize', 'The speech rewrite is on but its model configuration cannot run, so replies will be spoken without it. Check its provider, model, key and endpoint.')
  // t('editor.configIssuePending.ttsNormalize', 'The speech-rewrite credential is referenced but not filled in yet.')
  // t('editor.configIssue.memoryModel', 'A separate model is set for attendance summaries but its configuration cannot run, so attendances that end will not be summarized and the contact keeps no memory of them. Check its provider, model, key and endpoint.')
  // t('editor.configIssue.modelFallback', 'A fallback provider is set but its configuration cannot run, so a turn the primary provider drops is still lost. Check its provider, model, key and endpoint.')
  // t('editor.configIssuePending.memoryModel', 'The summary-model credential is referenced but not filled in yet, so attendances that end are not summarized.')
  // t('editor.configIssuePending.modelFallback', 'The fallback-provider credential is referenced but not filled in yet, so the fallback cannot take a turn.')
  // t('editor.configIssue.vision', 'Image/document reading is on but has no API key set.')
  // t('editor.configIssue.guardrails', 'Guardrails are on but have no API key set, so messages go out unscreened.')
  // t('editor.configIssuePending.guardrails', 'The guardrails credential is referenced but not filled in yet, so messages go out unscreened.')
  // t('editor.configIssueUnresolved.guardrails', 'The guardrails credential no longer exists, so messages go out unscreened.')
  // t('editor.configIssueGuardrailsFailing', 'Guardrails are on, but {{failures}} of their checks could not run in the last {{hours}} hours (the most recent {{when}}). Analysis is fail-open, so a check that could not run caught nothing and held nothing back. Check the model, the endpoint and the key.')
  // t('editor.configIssueGuardrailsFailingCause', 'Guardrails are on, but {{failures}} of their checks could not run in the last {{hours}} hours (the most recent {{when}}). Analysis is fail-open, so a check that could not run caught nothing and held nothing back. The last one said: {{error}}')
  // t('editor.configIssuePending.model', 'The model credential is referenced but not filled in yet.')
  // t('editor.configIssuePending.stt', 'The transcription credential is referenced but not filled in yet.')
  // t('editor.configIssuePending.tts', 'The audio-reply credential is referenced but not filled in yet.')
  // t('editor.configIssuePending.vision', 'The image-reading credential is referenced but not filled in yet.')
  // t('editor.configIssuePending.contactAuth', 'The contact-authorization credential is referenced but not filled in yet, so the check fails and the agent stays silent.')
  // t('editor.configIssueUnresolved.contactAuth', 'The contact-authorization credential no longer exists, so the check fails and the agent stays silent.')
  // t('editor.configIssue.contactAuthUnlockHandoff', 'The access-code unlock and the handoff cancel each other out: the first refusal opens the conversation and assigns it, and a conversation that is open is no longer the AI\'s, so the code the customer sends next never reaches the check. Turn the handoff off to let contacts unlock themselves, or stop sending the message text if a human should take every refused conversation.')
  // t('editor.configIssue.contactAuthSilentRefusal', 'A refused contact is left with nothing: no message is sent and the conversation is not opened for anyone, so their message goes unanswered and only a private note records it. Write the refusal message, or turn on the handoff to humans.')
  // t('editor.configIssue.contactAuthNoUrl', 'The authorization check is on but has no endpoint to ask. Without one it fails on every message and the agent stops answering anyone. Fill in the endpoint URL, or turn the check off.')
  // t('editor.configIssue.embedding', 'A knowledge base needs indexing, but the tenant embedding is not configured.')
  // t('editor.configIssuePending.embedding', 'A knowledge base needs indexing, but the embedding credential is not filled in yet.')
  // t('editor.configIssue.redirect', 'Redirect is on but a WhatsApp or website-chat inbox is not set, so it will not run.')
  // t('editor.configIssueUnresolved.model', 'The model credential no longer exists, so the agent cannot reply. Pick another one.')
  // t('editor.configIssueUnresolved.stt', 'The transcription credential no longer exists, so voice messages are not transcribed.')
  // t('editor.configIssueUnresolved.tts', 'The audio-reply credential no longer exists, so replies are sent as text.')
  // t('editor.configIssueUnresolved.ttsNormalize', 'The speech-rewrite credential no longer exists, so replies are spoken without the rewrite.')
  // t('editor.configIssueUnresolved.memoryModel', 'The summary-model credential no longer exists, so attendances that end are not summarized.')
  // t('editor.configIssueUnresolved.modelFallback', 'The fallback-provider credential no longer exists, so the fallback cannot take a turn.')
  // t('editor.configIssueUnresolved.vision', 'The image-reading credential no longer exists, so images and documents are not read.')
  // t('editor.configIssueUnresolved.embedding', 'A knowledge base needs indexing, but the embedding credential no longer exists.')
  // Knowledge bases this agent uses (its RAG grant) that still have documents awaiting indexing —
  // surfaced as a config warning so a freshly-imported agent flags "index me" right in the editor.
  const ragGrant = grants.find((g) => g.source === "RAG");
  const selectedKbIds = new Set(ragGrant?.knowledgeBaseIds ?? []);
  const knowledgeBasesNeedingIndex = (catalog?.knowledgeBases ?? [])
    .filter((k) => selectedKbIds.has(k.id) && k.unindexedCount > 0)
    .map((k) => ({ id: k.id, name: k.name }));
  // The agent's model as STORED, which is what the speech rewrite will inherit at runtime and is
  // not the same thing as the model being edited on General. The tabs do not save together: a
  // Behavior save carries none of General's pending edits, so judging the rewrite against them
  // blesses a pairing that exists nowhere. Reproduced by review: switch the provider on General,
  // configure the rewrite to inherit that provider's key, save Behavior, discard General. The bag
  // now names a vendor the saved agent never had, and every audio reply skips the rewrite as
  // `credential_required` while the editor called the configuration valid.
  const savedModel = syncedAgentRef.current
    ? readModelState(syncedAgentRef.current)
    : model;
  const savedModelBaseUrl =
    vaultBaseUrl(savedModel.credentialRef) ?? savedModel.baseURL;
  // The summariser override is judged on the STORED bag (see `settings` on the input), so the
  // credential whose endpoint outranks it has to be the stored one too. Reading the form's instead
  // would judge a saved configuration against a credential the row does not name.
  const savedMemoryCredBaseUrl = vaultBaseUrl(
    readMemoryConfig(syncedAgentRef.current?.settings).compaction
      .credentialRef ?? "",
  );
  // Same rule, same reason: the fallback is judged on the STORED bag, so its endpoint has to come
  // from the credential the row names rather than from the one the form is holding.
  const savedModelFallbackCredBaseUrl = vaultBaseUrl(
    readModelFallbackConfig(syncedAgentRef.current?.settings).credentialRef ??
      "",
  );
  const configIssues = computeConfigIssues({
    settings: syncedAgentRef.current?.settings,
    // Saved, like the settings above. Absent only before the first load lands, and nothing that
    // reads it can be non-empty that early.
    agentEnabled: syncedAgentRef.current?.enabled ?? true,
    modelProvider: model.provider,
    modelCredentialRef: model.credentialRef,
    sttEnabled: stt.enabled,
    sttCredentialRef: stt.credentialRef,
    ttsMode: tts.mode,
    ttsCredentialRef: tts.credentialRef,
    savedModelProvider: savedModel.provider,
    savedModelBaseURL: savedModelBaseUrl,
    savedModelCredentialRef: savedModel.credentialRef,
    savedMemoryCredentialBaseURL: savedMemoryCredBaseUrl,
    savedModelFallbackCredentialBaseURL: savedModelFallbackCredBaseUrl,
    ttsNormalize: tts.normalize,
    ttsNormalizeProvider: tts.normalizeProvider,
    ttsNormalizeModel: tts.normalizeModel,
    ttsNormalizeCredentialRef: tts.normalizeCredentialRef,
    ttsNormalizeBaseURL: ttsNormalizeCredBaseUrl ?? tts.normalizeBaseURL,
    visionEnabled: vision.enabled,
    visionCredentialRef: vision.credentialRef,
    contactAuthEnabled: contactAuth.enabled,
    contactAuthUrl: contactAuth.url,
    contactAuthCredentialRef: contactAuth.credentialRef,
    contactAuthIncludeMessageText: contactAuth.includeMessageText,
    contactAuthHandoffEnabled: contactAuth.handoffEnabled,
    contactAuthDenyMessage: contactAuth.denyMessage,
    guardrailsEnabled: guardrails.enabled,
    guardrailsCredentialRef: guardrails.credentialRef ?? "",
    guardrailsFailures: guardrailHealth?.failures,
    guardrailsLastFailureAt: guardrailHealth?.lastAt,
    pendingRefs,
    knownRefs,
    knowledgeBasesNeedingIndex,
    embeddingCredentialRef,
    redirectEnabled: channelRedirect.enabled,
    redirectEntryInboxId: channelRedirect.entryInboxId,
    redirectWidgetInboxId: channelRedirect.widgetInboxId,
    outOfOfficeInboxes,
    // The SAVED schedule, next to the saved settings above and for the same reason: the panel
    // describes the row, and a schedule picked but not saved gates nothing yet.
    savedSchedule: scheduleOf(hours, syncedAgentRef.current?.businessHoursId),
  });

  // Deep-link to a config issue. For a PENDING credential the fix lives in the vault, so jump to the
  // vault list with the fill modal pre-opened (?fill=<id>). Otherwise switch to the issue's tab
  // (URL-driven) carrying a focus marker; the effect below scrolls to the section + highlights it.
  function goToIssue(issue: (typeof configIssues)[number]) {
    // A knowledge issue is not a credential fix: open the base's documents modal so the operator can
    // index the imported documents.
    if (
      issue.key === "knowledge" &&
      issue.knowledgeBaseId &&
      issue.knowledgeBaseName
    ) {
      knowledgeManager.openDocs({
        id: issue.knowledgeBaseId,
        name: issue.knowledgeBaseName,
      });
      return;
    }
    if (issue.pending && issue.vaultId) {
      // Fill the pending credential in-place (modal on the editor) rather than jumping to the vault
      // page. Fall back to the vault deeplink only if the entry isn't in the loaded list.
      const entry = pendingEntries.find((e) => e.id === issue.vaultId);
      if (entry) {
        fillCredModal.open(entry);
      } else {
        navigate(`/resources/vault?fill=${issue.vaultId}`);
      }
      return;
    }
    if (issue.key === "embedding") {
      // Embedding not configured (the pending case is handled by the vault-fill branch above): the fix
      // lives in the tenant's Advanced settings.
      navigate("/resources/advanced");
      return;
    }
    navigate(
      `/agents/${id}/${issue.tab}${
        backToConversation ? `?from=${backToConversation}` : ""
      }`,
      { state: { focusSection: issue.sectionId } },
    );
  }

  // The human-facing line for a config issue: "referenced but not filled in" and "referenced but
  // gone" each read differently from the classic "no credential set", because the operator's next
  // move differs (fill it, pick another, set one). Kept out of the JSX so the dynamic-key lint
  // suppression sits on the t() call.
  function issueMessage(issue: (typeof configIssues)[number]): string {
    // Text already in the row, over its cap: whatever passes the cap is dropped by the reader, which
    // is invisible everywhere else. The message stops at that, without claiming the model receives
    // the rest — with the section switched off it receives none of it. When the field has no control
    // in the editor the message says so, instead of leaving the operator hunting for a tab.
    if (issue.key === "textCap") {
      const params = {
        field: issue.field ?? "",
        len: issue.length ?? 0,
        max: issue.max ?? 0,
      };
      return issue.tab
        ? t(
            "editor.configIssueTextCap",
            "{{field}} holds {{len}} characters and the limit is {{max}}: everything past that is ignored.",
            params,
          )
        : t(
            "editor.configIssueTextCapNoField",
            "{{field}} holds {{len}} characters and the limit is {{max}}: everything past that is ignored. This note has no field in the console, so it can only be shortened through the API.",
            params,
          );
    }
    if (issue.key === "knowledge") {
      return t(
        "editor.configIssueKnowledge",
        'Knowledge base "{{name}}" has documents that need indexing.',
        { name: issue.knowledgeBaseName ?? "" },
      );
    }
    // A guardrail that HAS its credential and still could not run. The count is the whole point: the
    // panel's other lines describe a state ("no key set"), this one describes what already happened,
    // and an operator has to be told that those turns went out unscreened rather than blocked.
    if (issue.key === "guardrailsFailing") {
      const params = {
        failures: issue.failures ?? 0,
        hours: guardrailHealth?.windowHours ?? 24,
        when: issue.lastFailureAt
          ? formatRelativeTime(issue.lastFailureAt, i18n.language)
          : "-",
        error: guardrailHealth?.lastError ?? "",
      };
      // The vendor's own words when they survived the write, generic advice when they did not. They
      // are what separates "look at this" from "fix this": "400 temperature is not supported" names
      // the setting, while a list of three things to check makes the operator try all of them.
      //
      // The line stops at what a failure row proves, which is less than it looks. It does not say
      // the message went out unscreened: a failed input check leaves the output check free to screen
      // the reply, and a split output analysis merges both halves, so it can carry an error from one
      // and a violation from the other and still replace or suppress the send. All that is certain
      // is fail-open, and it applies to the failed check alone: that one caught nothing and held
      // nothing back.
      return params.error
        ? t(
            "editor.configIssueGuardrailsFailingCause",
            "Guardrails are on, but {{failures}} of their checks could not run in the last {{hours}} hours (the most recent {{when}}). Analysis is fail-open, so a check that could not run caught nothing and held nothing back. The last one said: {{error}}",
            params,
          )
        : t(
            "editor.configIssueGuardrailsFailing",
            "Guardrails are on, but {{failures}} of their checks could not run in the last {{hours}} hours (the most recent {{when}}). Analysis is fail-open, so a check that could not run caught nothing and held nothing back. Check the model, the endpoint and the key.",
            params,
          );
    }
    // Two out-of-hours messages on one inbox, or one announcing a closure the other serves through.
    // The inboxes are NAMED, not counted: half of every fix is on Chatwoot's screen, and "two of
    // your inboxes" does not tell anyone which two to open there.
    if (issue.key === "outOfHoursBoth" || issue.key === "outOfHoursChatwoot") {
      const inboxes = (issue.inboxNames ?? []).join(", ");
      return issue.key === "outOfHoursBoth"
        ? t(
            "editor.configIssueOutOfHoursBoth",
            "Chatwoot already replies out of hours on {{inboxes}}, and this agent's out-of-hours message is on as well, so the customer gets both. The two schedules are set in different products and Chatwoot's has no dates in it, so on a holiday they will disagree too.",
            { inboxes },
          )
        : t(
            "editor.configIssueOutOfHoursChatwoot",
            "Chatwoot replies out of hours on {{inboxes}}, and this agent does not read that schedule: it answers whenever its own says it is open. The customer can be told the business is closed and served in the same breath.",
            { inboxes },
          );
    }
    if (issue.pending) {
      // biome-ignore lint/plugin/no-dynamic-i18n-key: pending keys registered via magic comments above computeConfigIssues
      return t(`editor.configIssuePending.${issue.key}` as const, {
        defaultValue: "This credential is referenced but not filled in yet.",
      });
    }
    if (issue.unresolved) {
      // biome-ignore lint/plugin/no-dynamic-i18n-key: unresolved keys registered via magic comments above computeConfigIssues
      return t(`editor.configIssueUnresolved.${issue.key}` as const, {
        defaultValue: "This credential no longer exists. Pick another one.",
      });
    }
    // biome-ignore lint/plugin/no-dynamic-i18n-key: issue keys registered via magic comments above computeConfigIssues
    return t(`editor.configIssue.${issue.key}` as const, {
      defaultValue: "This feature is enabled but has no credential set.",
    });
  }

  // The write boundary refuses a settings bag whose operator prose is over its cap. A save that
  // fires several calls (tools = grants PUT then agent PATCH) would otherwise persist the first and
  // fail the second, leaving the grants saved, the toast saying it failed, and the local state stale.
  // Same walker and same comparison the server runs — against the last-synced bag, so a value stored
  // before the caps is not what stops a save that never touched it.
  function settingsTextError(bag: unknown, stored: unknown): string | null {
    const over = collectOversizedTextChanges(bag, stored)[0];
    if (!over) return null;
    return t(
      "editor.settingsTextTooLong",
      "The text in {{field}} is too long: {{len}} characters (limit {{max}}).",
      { field: over.path, len: over.length, max: over.max },
    );
  }

  // Localized text for a structured import warning. Static keys (one per code) keep it extract-safe;
  // params interpolate the names/counts. New codes added in transfer.ts must get a case here.
  function importWarningMessage(w: ImportWarning): string {
    const p = w.params ?? {};
    switch (w.code) {
      case "guidanceClipped":
        return t(
          "editor.importWarning.guidanceClipped",
          'The text in "{{field}}" was longer than {{max}} characters and was trimmed on import.',
          p,
        );
      case "credentialNotFound":
        return t(
          "editor.importWarning.credentialNotFound",
          'Credential "{{name}}" was not found here, so it was left unset.',
          p,
        );
      case "credentialPending":
        return t(
          "editor.importWarning.credentialPending",
          'Credential "{{name}}" was not found here, so a placeholder was created. Fill in its secret to activate it.',
          p,
        );
      case "credentialMissingMeta":
        return t(
          "editor.importWarning.credentialMissingMeta",
          'Credential "{{name}}" is missing from the export metadata, so it was left unset.',
          p,
        );
      case "credentialAmbiguous":
        return t(
          "editor.importWarning.credentialAmbiguous",
          'Credential "{{name}}" appears with more than one type in the export, so it was left unset.',
          p,
        );
      case "hoursNotFound":
        return t(
          "editor.importWarning.hoursNotFound",
          'Business hours "{{name}}" were not found here, so they were left unset.',
          p,
        );
      case "hoursReused":
        return t(
          "editor.importWarning.hoursReused",
          'Business hours "{{name}}" already existed and were reused; check the schedule is right.',
          p,
        );
      case "hoursWindowsDropped":
        return t(
          "editor.importWarning.hoursWindowsDropped",
          'Business hours "{{name}}": {{count}} weekly window(s) were not stored as written. Open the schedule and check the days are right.',
          p,
        );
      case "hoursExceptionsDropped":
        return t(
          "editor.importWarning.hoursExceptionsDropped",
          'Business hours "{{name}}": {{count}} date exception(s) were not stored as written. Open the schedule and check the holidays and closures are right.',
          p,
        );
      case "httpToolBodyIgnored":
        return t(
          "editor.importWarning.httpToolBodyIgnored",
          'Tool "{{name}}" had a request body in a shape this version does not accept, so it was reduced to the part that was actually being sent. The request is unchanged; open it under Body to check it.',
          p,
        );
      case "httpToolReused":
        return t(
          "editor.importWarning.httpToolReused",
          'Tool "{{name}}" already existed and was reused; check it is right.',
          p,
        );
      case "httpToolCredNotFound":
        return t(
          "editor.importWarning.httpToolCredNotFound",
          'Tool "{{tool}}" credential "{{credential}}" was not found here, so it was left unset.',
          p,
        );
      case "mcpReused":
        return t(
          "editor.importWarning.mcpReused",
          'MCP server "{{name}}" already existed and was reused; check it is right.',
          p,
        );
      case "mcpUnsafeStdio":
        return t(
          "editor.importWarning.mcpUnsafeStdio",
          'MCP server "{{name}}" has an unsupported command and was skipped.',
          p,
        );
      case "integrationUnknownType":
        return t(
          "editor.importWarning.integrationUnknownType",
          'Integration "{{name}}" has an unknown type and was skipped.',
          p,
        );
      case "integrationReused":
        return t(
          "editor.importWarning.integrationReused",
          'Integration "{{name}}" already existed and was reused; check it is right.',
          p,
        );
      case "kbReused":
        return t(
          "editor.importWarning.kbReused",
          'Knowledge base "{{name}}" already existed and was reused; check it is right.',
          p,
        );
      case "kbReusedDocsSkipped":
        return t(
          "editor.importWarning.kbReusedDocsSkipped",
          'Knowledge base "{{name}}" already existed and was reused; its {{n}} bundled document(s) were not imported.',
          p,
        );
      case "kbGrantNotFound":
        return t(
          "editor.importWarning.kbGrantNotFound",
          'Knowledge base "{{name}}" was not found, so its grant was skipped.',
          p,
        );
      case "httpGrantNotFound":
        return t(
          "editor.importWarning.httpGrantNotFound",
          'Tool "{{name}}" was not found, so its grant was skipped.',
          p,
        );
      case "mcpGrantNotFound":
        return t(
          "editor.importWarning.mcpGrantNotFound",
          'MCP server "{{name}}" was not found, so its grant was skipped.',
          p,
        );
      case "unknownGrantSourceSkipped":
        return t(
          "editor.importWarning.unknownGrantSourceSkipped",
          "{{n}} tool grant(s) came from a newer version and were skipped.",
          p,
        );
      case "documentGrantNotFound":
        return t(
          "editor.importWarning.documentGrantNotFound",
          'Document template "{{name}}" was not found, so its grant was skipped.',
          p,
        );
      case "documentTemplateReused":
        return t(
          "editor.importWarning.documentTemplateReused",
          'Document template "{{name}}" already existed and was reused; check it is right.',
          p,
        );
      case "documentTemplateNameTaken":
        return t(
          "editor.importWarning.documentTemplateNameTaken",
          'Document template "{{name}}" was not imported: this account already has a template with that name ({{existing}}). Names have to be unique, because the agent picks between documents by name.',
          p,
        );
      case "documentTemplateInvalid":
        return t(
          "editor.importWarning.documentTemplateInvalid",
          'Document template "{{name}}" could not be imported: {{reason}}',
          p,
        );
      case "integrationGrantNotFound":
        return t(
          "editor.importWarning.integrationGrantNotFound",
          'Integration "{{name}}" was not found, so its grant was skipped.',
          p,
        );
      default:
        return w.code;
    }
  }

  // Resolve a reused schedule by name (a business-hours warning carries no catalog id) and open its own
  // editor in place; fall back to the resources page if the list can't be matched.
  async function openBusinessHoursReview(name: string) {
    const { data } = await api.api.v1["business-hours"].get();
    const item = data?.businessHours.find((h) => h.name === name);
    if (item) {
      setBusinessHoursReviewItem(item);
      businessHoursReviewModal.open({ id: item.id });
    } else {
      navigate("/resources/business-hours");
    }
  }

  // Deep-link a structured import warning to where it is reviewed, then dismiss it: reviewing IS the
  // acknowledgement, and clearing the last one collapses the whole banner. A reused tool/MCP/integration/
  // schedule opens its OWN editor modal right here; KB opens the in-editor documents modal; a missing
  // agent credential scrolls to the exact field (model/stt/tts/vision) that references it. Only a
  // credential referenced ONLY by a component (no agent field) falls back to the vault page.
  function goToImportWarning(w: ImportWarning) {
    const target = w.target;
    if (target) {
      switch (target.kind) {
        case "vault":
          navigate("/resources/vault");
          break;
        case "agentField":
          // Deep-link to the exact field that references the missing credential (model/stt/tts/vision),
          // scrolling + highlighting it — same mechanism config-health uses.
          navigate(
            `/agents/${id}/${target.tab}${
              backToConversation ? `?from=${backToConversation}` : ""
            }`,
            { state: { focusSection: target.sectionId } },
          );
          break;
        case "businessHours":
          void openBusinessHoursReview(target.name);
          break;
        case "tool": {
          const tool = catalog?.toolDefinitions.find(
            (x) => x.name === target.name,
          );
          if (tool) toolEditModal.open({ id: tool.id });
          else navigate("/resources/tools");
          break;
        }
        case "mcp": {
          const conn = catalog?.mcpConnections.find(
            (x) => x.name === target.name,
          );
          if (conn) mcpEditModal.open({ id: conn.id });
          else navigate("/resources/mcp");
          break;
        }
        case "integration": {
          const inst = catalog?.integrationInstances.find(
            (x) =>
              x.catalogType === target.catalogType && x.name === target.name,
          );
          if (inst) integrationEditModal.open({ id: inst.id });
          else navigate("/resources/integrations");
          break;
        }
        case "knowledge": {
          const kb = catalog?.knowledgeBases.find(
            (k) => k.name === target.name,
          );
          if (kb) knowledgeManager.openDocs({ id: kb.id, name: kb.name });
          else navigate("/resources/knowledge");
          break;
        }
        // The panel rather than a modal, unlike tools and MCP above: a document template's editor
        // opens from its own row and needs the loaded template, which this page does not carry.
        // Without an arm here the Review action only dismissed the warning and went nowhere.
        case "document":
          navigate("/resources/documents");
          break;
      }
    }
    const key = `${w.code}:${JSON.stringify(w.params ?? {})}`;
    setImportWarnings((prev) =>
      prev.filter((x) => `${x.code}:${JSON.stringify(x.params ?? {})}` !== key),
    );
  }

  const focusSection = (location.state as { focusSection?: string } | null)
    ?.focusSection;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run per navigation (location.key) to consume a fresh focus marker.
  useEffect(() => {
    if (!focusSection) return;
    // Wait a frame so the freshly-switched tab's section is mounted before scrolling/highlighting.
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(focusSection);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Soft accent ring that fades in then out once (.section-highlight in index.css). Remove +
      // force a reflow first so re-navigating to the same section restarts the animation.
      el.classList.remove("section-highlight");
      el.getBoundingClientRect();
      el.classList.add("section-highlight");
      el.addEventListener(
        "animationend",
        () => el.classList.remove("section-highlight"),
        { once: true },
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [focusSection, location.key]);

  // Playground readiness: the playground now tests the LIVE draft (prompt/model/settings sent as a
  // non-persisted override), so the hard requirements are read from the CURRENT model form, not the
  // saved snapshot. baseURL is intentionally not checked — it can come from the credential at
  // runtime; a genuinely missing one still surfaces as a reply error bubble.
  const playgroundMissing: string[] = [];
  if (!model.provider) playgroundMissing.push("provider");
  // openai-compatible runs without a model name (the server's default model).
  if (!model.model.trim() && model.provider !== "openai-compatible")
    playgroundMissing.push("model");
  if (!model.credentialRef) playgroundMissing.push("credential");
  const toolsDirty = dirty.tools || dirty.knowledge;

  // Per-capability playground readiness (from the LIVE behavior form, like playgroundMissing is from
  // the model form). STT/vision RESPECT the feature's `enabled` toggle: the live draft carries it, so
  // the operator still tests before saving by flipping the toggle on (no separate "ignore" path). The
  // other hard requirement is the credential — the provider always defaults to a valid one. The audio
  // REPLY is a manual playground toggle (forceAudio), so it only needs TTS configured (a voice too for
  // providers that require one, like ElevenLabs; mirrors modules/tts), not tts.enabled.
  const playgroundCapabilities = {
    audioInput: stt.enabled && !!stt.credentialRef,
    audioReply:
      !!tts.credentialRef &&
      (tts.provider !== "elevenlabs" || !!tts.voice.trim()),
    fileInput: vision.enabled && !!vision.credentialRef,
    // Same two hard requirements the runtime has (modules/guardrails/gate): the feature switched on
    // and its OWN credential resolved. A direction being off is not checked here — that is a per-
    // direction answer, and the gate already returns "not-run" for it without costing anything.
    guardrails: guardrails.enabled && !!guardrails.credentialRef,
  };

  // Live draft sent with each playground turn: the unsaved prompt/model/settings (never grants —
  // those need saving). Read fresh at send time inside the hook, so it always reflects the form.
  const getDraft = () => ({
    systemPrompt,
    businessHoursId,
    modelConfig: buildModelConfig(),
    settings: buildSettings(),
  });
  const playgroundChat = usePlaygroundChat(id, playgroundMissing.length > 0, {
    getDraft,
  });
  // The floating playground panel's open state lives here; its trigger is the editor save bar
  // (TabActionBar) on the config tabs, and the panel itself renders below (PlaygroundFab).
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const openPlayground = () => setPlaygroundOpen(true);
  // Guards LEAVING the editor (sidebar, breadcrumbs, the Back link, browser
  // Back, refresh/close) when there are unsaved changes. Switching tabs keeps
  // the component mounted (state survives), so it is intentionally not guarded.
  useNavGuard(anyDirty);

  // Per-tab discard: restore a single section from the last synced agent. No
  // syncSeq bump — only the reverted section returns to baseline, the other
  // tabs keep their own pending state.
  const revertGeneral = () => {
    const a = syncedAgentRef.current;
    if (!a) return;
    setName(a.name);
    setSystemPrompt(a.systemPrompt);
    setEnabled(a.enabled);
    setAgentMode(a.mode === "test" ? "test" : "production");
    setModel(readModelState(a));
  };
  const revertBehavior = () => {
    const a = syncedAgentRef.current;
    if (!a) return;
    const b = readBehaviorState(a);
    setBusinessHoursId(b.businessHoursId);
    setAwayEnabled(b.awayEnabled);
    setAwayMessage(b.awayMessage);
    setFollowUpHoursId(b.followUpHoursId);
    setSettings(b.settings);
    setDebounce(b.debounce);
    setStt(b.stt);
    setContactAuth(b.contactAuth);
    setTts(b.tts);
    setSplit(b.split);
    setServiceWindow(b.serviceWindow);
    setFollowUp(b.followUp);
    setVision(b.vision);
    setLimits(b.limits);
    setObservability(b.observability);
    setSavedObservability(b.observability);
    setMemory(b.memory);
    setModelFallback(b.modelFallback);
    setSendImage(b.sendImage);
    setAttributeContext(b.attributeContext);
  };
  const revertChannelRedirect = () => {
    const a = syncedAgentRef.current;
    if (!a) return;
    setChannelRedirect(readChannelRedirectState(a));
  };
  const revertGuardrails = () => {
    const a = syncedAgentRef.current;
    if (!a) return;
    setGuardrails(readGuardrailsFormState(a.settings));
  };
  // Tools and Knowledge share one grant array but own disjoint slices (Tools =
  // non-RAG, Knowledge = RAG), so each discard restores only its slice and
  // keeps the other tab's pending edits.
  const revertTools = () => {
    const synced = mapGrants(syncedGrantsRef.current);
    setGrants((cur) => [
      ...cur.filter((g) => g.source === "RAG"),
      ...synced.filter((g) => g.source !== "RAG"),
    ]);
    // Handoff config lives on the Tools tab, so its discard restores here too.
    if (syncedAgentRef.current) syncToolConfig(syncedAgentRef.current);
  };
  const revertKnowledge = () => {
    const synced = mapGrants(syncedGrantsRef.current);
    setGrants((cur) => [
      ...synced.filter((g) => g.source === "RAG"),
      ...cur.filter((g) => g.source !== "RAG"),
    ]);
  };

  // Discard everything back to the last synced state in one shot (confirmed,
  // since it can wipe edits across several tabs).
  function askDiscardAll() {
    confirm.open({
      title: t("editor.discardAllTitle", "Discard all changes?"),
      message: t(
        "editor.discardAllMessage",
        "All unsaved changes across every tab will be lost.",
      ),
      danger: true,
      confirmLabel: t("editor.discardAll", "Discard all"),
      onConfirm: () => {
        const a = syncedAgentRef.current;
        if (a) {
          applyAgent(a);
          syncToolConfig(a);
        }
        setGrants(mapGrants(syncedGrantsRef.current));
        bumpSync(...SECTION_KEYS);
      },
    });
  }

  // Optimistic-concurrency precondition the save sends (the version we loaded), unless `force` (the
  // operator chose "overwrite anyway" from the conflict banner).
  const expectedFor = (force: boolean) =>
    force ? undefined : (loadedUpdatedAtRef.current ?? undefined);

  // A 409 means another writer advanced the agent since we loaded. Surface the banner + stash a retry
  // that re-runs the SAME save forcing the overwrite. Returns true when handled (caller stops).
  function handleConflict(
    err: { status?: number } | null | undefined,
    retry: () => void,
  ): boolean {
    if (err && err.status === 409) {
      setConflictRetry(() => retry);
      setStaleNotice(true);
      showToast(
        t(
          "editor.conflictToast",
          "This agent was changed elsewhere. Reload, or save again to overwrite.",
        ),
        "error",
      );
      return true;
    }
    return false;
  }

  function markSynced(updatedAt: string | null) {
    if (updatedAt) loadedUpdatedAtRef.current = updatedAt;
    setStaleNotice(false);
    setConflictRetry(null);
    // Every successful save funnels through here, which makes it one of the two places that can tell
    // the server-read parts of this page to look again (the other is `load`). A save is the
    // operator's "I fixed it", and the guardrail health snapshot is the first reader of the tick.
    setServerSyncTick((n) => n + 1);
  }

  async function saveAgent(
    patch: Record<string, unknown>,
    section: "general" | "behavior",
    force = false,
  ) {
    savingRef.current += 1;
    setSavingAgent(true);
    try {
      const expected = expectedFor(force);
      const { data, error: err } = await api.api.v1.agents({ id }).patch({
        ...patch,
        ...(expected ? { expectedUpdatedAt: expected } : {}),
      });
      if (handleConflict(err, () => void saveAgent(patch, section, true))) {
        return;
      }
      if (err || !data) throw err ?? new Error("no data");
      // Re-sync ONLY the saved section so the other tabs' unsaved edits are never clobbered.
      if (section === "general") applyGeneral(data.agent);
      else applyBehavior(data.agent);
      markSynced(String(data.agent.updatedAt));
      bumpSync(section);
      showToast(t("editor.saved", "Agent saved."), "success");
    } catch (e) {
      // NOTE: surface the backend's localized message when present (the prompt-size cap, the
      // settings text caps) instead of the generic failure toast.
      showToast(
        apiErrorMessage(e) ||
          t("editor.saveError", "Could not save the agent."),
        "error",
      );
    } finally {
      savingRef.current -= 1;
      setSavingAgent(false);
    }
  }

  async function saveGrants(force = false) {
    savingRef.current += 1;
    setSavingGrants(true);
    try {
      const expected = expectedFor(force);
      const { data, error: err } = await api.api.v1
        .agents({ id })
        ["tool-selections"].put({
          grants,
          ...(expected ? { expectedUpdatedAt: expected } : {}),
        });
      if (handleConflict(err, () => void saveGrants(true))) return;
      if (err || !data) throw err ?? new Error("no data");
      syncedGrantsRef.current = data.grants;
      setGrants(mapGrants(data.grants));
      setCatalog(data.catalog);
      markSynced(data.agentUpdatedAt ? String(data.agentUpdatedAt) : null);
      bumpSync("tools", "knowledge");
      showToast(t("editor.grantsSaved", "Tools updated."), "success");
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("editor.grantsError", "Could not update tools."),
        "error",
      );
    } finally {
      savingRef.current -= 1;
      setSavingGrants(false);
    }
  }

  // Tools-tab save: the grant set PLUS the handoff_to_human + kanban config (which live on the tools,
  // not in Behavior). The config bits are merged onto the LAST-SYNCED settings so this never clobbers
  // unsaved edits pending in the Behavior tab (both write the same settings JSON column). Two writes
  // (grants PUT, then agent PATCH); the PUT bumps the agent's token, so the PATCH precondition chains
  // to the PUT's returned token (else the PATCH would 409 against our own grant write).
  async function saveTools(force = false) {
    savingRef.current += 1;
    setSavingGrants(true);
    try {
      // Everything the PATCH will send, built BEFORE the grants PUT so the whole bag can be checked
      // against the write boundary's own rule first. None of it depends on the PUT's result.
      const syncedSettings = (syncedAgentRef.current?.settings ?? {}) as Record<
        string,
        unknown
      >;
      const handoffJson = serializeHandoff(handoff);
      const kanbanJson = { instructions: kanbanInstructions.trim() || null };
      // Merge the per-tool guidance map: preserve any entries for other tools, set/clear ours.
      const existingGuidance = (syncedSettings.toolGuidance ?? {}) as Record<
        string,
        unknown
      >;
      const toolGuidanceJson: Record<string, unknown> = { ...existingGuidance };
      const attrNote = customAttributeInstructions.trim();
      const labelNote = labelInstructions.trim();
      const updateKanbanNote = updateKanbanTaskInstructions.trim();
      if (attrNote) toolGuidanceJson.set_custom_attribute = attrNote;
      else delete toolGuidanceJson.set_custom_attribute;
      if (labelNote) toolGuidanceJson.assign_label = labelNote;
      else delete toolGuidanceJson.assign_label;
      if (updateKanbanNote)
        toolGuidanceJson.update_kanban_task = updateKanbanNote;
      else delete toolGuidanceJson.update_kanban_task;
      const toolPreconditionsJson = serializeToolPreconditions(
        toolPreconditions,
        syncedSettings.toolPreconditions,
      );
      const toolsSettings = {
        ...syncedSettings,
        handoff: handoffJson,
        kanban: kanbanJson,
        toolGuidance: toolGuidanceJson,
        toolPreconditions: toolPreconditionsJson,
      };
      // The WHOLE bag, not just this tab's fields: the PATCH resends every block, so text typed on
      // another tab would refuse it just the same — after the grants had already been written.
      //
      // On a forced overwrite the last-synced bag is stale by definition (the 409 says someone else
      // wrote), so it is re-read first: if the other writer shortened a legacy over-cap note, our
      // copy is now an EDIT of it, the server would refuse the PATCH, and the grants PUT would
      // already have persisted. A failed re-read falls back to the synced bag rather than blocking
      // the save on it.
      const storedSettings = force
        ? ((await api.api.v1.agents({ id }).get()).data?.agent.settings ??
          syncedSettings)
        : syncedSettings;
      const toolsText = settingsTextError(toolsSettings, storedSettings);
      if (toolsText) {
        showToast(toolsText, "error");
        return;
      }
      const expected = expectedFor(force);
      const grantsRes = await api.api.v1.agents({ id })["tool-selections"].put({
        grants,
        ...(expected ? { expectedUpdatedAt: expected } : {}),
      });
      if (handleConflict(grantsRes.error, () => void saveTools(true))) return;
      if (grantsRes.error || !grantsRes.data) {
        throw grantsRes.error ?? new Error("no data");
      }
      // Chain the PATCH precondition to the token the grant write just produced.
      const afterGrants = grantsRes.data.agentUpdatedAt
        ? String(grantsRes.data.agentUpdatedAt)
        : undefined;
      // The grant write already advanced the server's token AND published an agent-config event.
      // Record it NOW so the realtime echo of our OWN write — or a partial failure of the PATCH below —
      // never trips the "changed elsewhere" banner against the now-stale loaded token.
      if (afterGrants) loadedUpdatedAtRef.current = afterGrants;
      const patchExpected = force ? undefined : afterGrants;
      const agentRes = await api.api.v1.agents({ id }).patch({
        transferWithSummary,
        settings: toolsSettings,
        ...(patchExpected ? { expectedUpdatedAt: patchExpected } : {}),
      });
      if (handleConflict(agentRes.error, () => void saveTools(true))) return;
      if (agentRes.error || !agentRes.data) {
        throw agentRes.error ?? new Error("no data");
      }
      // Sync grants + the saved agent and re-read the tool-coupled state — but NOT applyAgent, which
      // would reset the Behavior sub-forms and drop their unsaved edits. Keep the local settings bag's
      // handoff in step so a later Behavior save (which spreads it) doesn't rewrite a stale value.
      syncedGrantsRef.current = grantsRes.data.grants;
      setGrants(mapGrants(grantsRes.data.grants));
      setCatalog(grantsRes.data.catalog);
      syncedAgentRef.current = agentRes.data.agent;
      syncToolConfig(agentRes.data.agent);
      setSettings((s) => ({
        ...s,
        handoff: handoffJson,
        kanban: kanbanJson,
        toolGuidance: toolGuidanceJson,
        // The SAME value that was just written, not a recomputation. Left out, the shared bag keeps
        // the pre-save map, and the next Behavior save spreads it back over the rules that were just
        // stored — with the Tools tab still showing them as saved.
        toolPreconditions: toolPreconditionsJson,
      }));
      markSynced(String(agentRes.data.agent.updatedAt));
      bumpSync("tools", "knowledge");
      showToast(t("editor.grantsSaved", "Tools updated."), "success");
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("editor.grantsError", "Could not update tools."),
        "error",
      );
    } finally {
      savingRef.current -= 1;
      setSavingGrants(false);
    }
  }

  // Redirect-tab save: the channelRedirect block merged onto the LAST-SYNCED settings (NOT
  // buildSettings(), which reads the live Behavior form) so it can never clobber unsaved Behavior edits
  // — both write the same settings JSON column. Mirrors saveTools' merge-onto-synced approach, minus
  // the grants write. widgetInboxId round-trips untouched (the provision route owns it).
  async function saveChannelRedirect(force = false) {
    savingRef.current += 1;
    setSavingChannelRedirect(true);
    try {
      const expected = expectedFor(force);
      const syncedSettings = (syncedAgentRef.current?.settings ?? {}) as Record<
        string,
        unknown
      >;
      const crJson = fromChannelRedirectForm(channelRedirect);
      const { data, error: err } = await api.api.v1.agents({ id }).patch({
        settings: { ...syncedSettings, channelRedirect: crJson },
        ...(expected ? { expectedUpdatedAt: expected } : {}),
      });
      if (handleConflict(err, () => void saveChannelRedirect(true))) return;
      if (err || !data) throw err ?? new Error("no data");
      applyChannelRedirect(data.agent);
      // Keep the local settings bag's channelRedirect in step so a later Behavior save (which spreads
      // it) doesn't rewrite a stale value.
      setSettings((s) => ({ ...s, channelRedirect: crJson }));
      markSynced(String(data.agent.updatedAt));
      bumpSync("channelRedirect");
      showToast(t("editor.saved", "Agent saved."), "success");
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("editor.saveError", "Could not save the agent."),
        "error",
      );
    } finally {
      savingRef.current -= 1;
      setSavingChannelRedirect(false);
    }
  }

  // Guardrails-tab save: the guardrails block merged onto the LAST-SYNCED settings (same pattern as
  // saveChannelRedirect) so it never clobbers unsaved edits in another tab — both write the same
  // settings JSON column.
  async function saveGuardrails(force = false) {
    savingRef.current += 1;
    setSavingGuardrails(true);
    try {
      const expected = expectedFor(force);
      const syncedSettings = (syncedAgentRef.current?.settings ?? {}) as Record<
        string,
        unknown
      >;
      const { data, error: err } = await api.api.v1.agents({ id }).patch({
        settings: { ...syncedSettings, guardrails },
        ...(expected ? { expectedUpdatedAt: expected } : {}),
      });
      if (handleConflict(err, () => void saveGuardrails(true))) return;
      if (err || !data) throw err ?? new Error("no data");
      applyGuardrails(data.agent);
      setSettings((s) => ({ ...s, guardrails }));
      markSynced(String(data.agent.updatedAt));
      bumpSync("guardrails");
      showToast(t("editor.saved", "Agent saved."), "success");
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("editor.saveError", "Could not save the agent."),
        "error",
      );
    } finally {
      savingRef.current -= 1;
      setSavingGuardrails(false);
    }
  }

  async function doClone() {
    try {
      const { data, error: err } = await api.api.v1
        .agents({ id })
        .clone.post({ name: cloneName.trim() || undefined });
      if (err || !data) throw err ?? new Error("no data");
      cloneModal.close();
      showToast(t("editor.cloned", "Agent cloned (disabled)."), "success");
      navigate(`/agents/${data.agent.id}`);
    } catch (e) {
      // The clone carries the source agent's settings verbatim, so a source written before the text
      // caps is refused by name — the generic message would leave the operator with a button that
      // fails and no field to shorten.
      showToast(
        apiErrorMessage(e) || t("editor.cloneError", "Could not clone."),
        "error",
      );
    }
  }

  // Export the agent's full config as a secret-free JSON download (references by name). The filename
  // is NFD-slugified ("joãozinho" → "joaozinho") and prefixed with the product name (item 2).
  async function doExport(
    includeComponents: boolean,
    includeDocuments: boolean,
  ) {
    try {
      const query: { components?: string; documents?: string } = {};
      if (includeComponents) query.components = "true";
      // Documents ride under components; never request docs without them.
      if (includeComponents && includeDocuments) query.documents = "true";
      const { data, error: err } = await api.api.v1
        .agents({ id })
        .export.get(Object.keys(query).length > 0 ? { query } : undefined);
      if (err || !data) throw err ?? new Error("no data");
      const blob = new Blob([JSON.stringify(data.export, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agents-agent-${slugify(data.export.agent.name) || "agent"}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      showToast(
        apiErrorMessage(caught) || t("editor.exportError", "Could not export."),
        "error",
      );
    }
  }

  // Saves every dirty section sequentially (so the optimistic-concurrency token chains through each
  // write), used by "Save and export". Tools + Knowledge share the grant set, so one saveTools() write
  // persists both. Awaited so the export reads the just-saved version.
  async function saveAllDirty() {
    if (dirty.general) {
      if (!guardModelBeforeSave()) return;
      await saveAgent(
        {
          name: name.trim(),
          systemPrompt,
          enabled,
          mode: agentMode,
          modelConfig: buildModelConfig(),
        },
        "general",
      );
    }
    if (dirty.behavior) {
      await saveAgent(
        {
          businessHoursId: businessHoursId || null,
          followUpHoursId: followUpHoursId || null,
          settings: buildSettings(),
        },
        "behavior",
      );
    }
    if (dirty.channelRedirect) {
      await saveChannelRedirect();
    }
    if (dirty.guardrails) {
      await saveGuardrails();
    }
    if (dirty.tools || dirty.knowledge) {
      await saveTools();
    }
  }

  function askDelete() {
    // Confirm against the PERSISTED name (the backend compares the same), so an unsaved rename can't
    // produce a confirm phrase the operator is unable to match.
    const confirmName = syncedAgentRef.current?.name ?? name;
    strongDelete.open({
      title: t("editor.deleteTitle", "Delete agent"),
      warning: t(
        "editor.deleteWarning",
        'This permanently deletes "{{name}}" (its prompt, tool grants and behavior settings) and detaches every inbox bound to it. It cannot be undone. The shared building blocks (tools, knowledge bases, integrations) are not touched.',
        { name: confirmName },
      ),
      confirmPhrase: confirmName,
      confirmLabel: t("editor.deleteConfirmLabel", "Type {{name}} to confirm", {
        name: confirmName,
      }),
      actionLabel: t("common.delete", "Delete"),
      onConfirm: async (password) => {
        const { error: err } = await api.api.v1
          .agents({ id })
          .delete({ confirmName, password });
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t(
                "editor.deleteError",
                "Could not delete. Check your password and try again.",
              ),
            "error",
          );
          throw err; // keep the dialog open
        }
        showToast(t("editor.deleted", "Agent deleted."), "success");
        navigate("/agents");
      },
    });
  }

  // Shared onScheduleSaved handler: re-fetches hours then sets the saved id.
  const onScheduleSaved = (savedId: string, setter: (v: string) => void) => {
    void loadHours().then(() => setter(savedId));
  };

  const tabs: TabItem[] = [
    {
      key: "general",
      label: t("editor.tab.general", "General"),
      icon: Sparkles,
      dirty: dirty.general,
    },
    {
      key: "channels",
      label: t("editor.tab.channels", "Channels"),
      icon: RadioTower,
    },
    {
      key: "tools",
      label: t("editor.tab.tools", "Tools"),
      icon: Wrench,
      dirty: dirty.tools,
    },
    {
      key: "knowledge",
      label: t("editor.tab.knowledge", "Knowledge"),
      icon: BookOpen,
      dirty: dirty.knowledge,
    },
    {
      key: "behavior",
      label: t("editor.tab.behavior", "Behavior"),
      icon: Clock,
      dirty: dirty.behavior,
    },
    {
      key: "guardrails",
      label: t("editor.tab.guardrails", "Guardrails"),
      icon: ShieldCheck,
      dirty: dirty.guardrails,
    },
    {
      key: "channelRedirect",
      label: t("editor.tab.channelRedirect", "Redirect"),
      icon: Share2,
      dirty: dirty.channelRedirect,
    },
    {
      key: "playground",
      label: t("editor.tab.playground", "Playground"),
      icon: MessageSquare,
    },
  ];

  return (
    <PageContainer className="flex min-h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <Link
          to="/agents"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-text-muted hover:text-text-primary"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t("editor.back", "Back to agents")}
        </Link>
        {backToConversation && (
          <Link
            to={backToConversation}
            className="inline-flex w-fit items-center gap-1.5 text-accent text-sm hover:underline"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t("editor.backToConversation", "Back to the conversation")}
          </Link>
        )}
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        onRetry={load}
        errorLabel={t("editor.error", "Could not load the agent.")}
        skeleton={<AgentEditorSkeleton />}
      >
        {catalog && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Settings2 className="h-6 w-6 text-accent" aria-hidden="true" />
                <h1 className="truncate font-semibold text-text-primary text-xl">
                  {name || t("editor.untitled", "Untitled agent")}
                </h1>
                <Badge variant={enabled ? "success" : "secondary"}>
                  {enabled
                    ? t("common.enabled", "Enabled")
                    : t("common.disabled", "Disabled")}
                </Badge>
                {agentMode === "test" && <TestModeBadge state="agent" />}
                {anyDirty && (
                  <Badge
                    variant="warning"
                    className="inline-flex items-center gap-1.5"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-warning"
                      aria-hidden="true"
                    />
                    {t("editor.unsavedChanges", "Unsaved changes")}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {anyDirty && (
                  <Button variant="secondary" size="sm" onClick={askDiscardAll}>
                    {t("editor.discardAll", "Discard all")}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const suggested = t(
                      "editor.cloneDefaultName",
                      "{{name}} (copy)",
                      { name },
                    );
                    cloneNameDefaultRef.current = suggested;
                    setCloneName(suggested);
                    cloneModal.open();
                  }}
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  {t("editor.clone", "Clone")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => exportModal.open()}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  {t("editor.export", "Export")}
                </Button>
              </div>
            </div>

            <Tabs
              items={tabs}
              value={tab}
              // Preserve the ?from origin across tab switches so the "back to conversation" link
              // survives navigation within the editor.
              onChange={(k) =>
                navigate(
                  `/agents/${id}/${k}${
                    backToConversation ? `?from=${backToConversation}` : ""
                  }`,
                )
              }
              aria-label={t("editor.tabs", "Agent settings")}
            />

            {staleNotice && (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-2">
                  <TriangleAlert
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-text-primary">
                    {t(
                      "editor.staleNotice",
                      "This agent was changed elsewhere (another tab, the API, or the MCP server). Reload to get the latest version before saving.",
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void load()}
                  >
                    {t("editor.reload", "Reload")}
                  </Button>
                  {conflictRetry && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        const retry = conflictRetry;
                        setStaleNotice(false);
                        setConflictRetry(null);
                        retry();
                      }}
                    >
                      {t("editor.overwriteAnyway", "Save anyway")}
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => setStaleNotice(false)}
                    aria-label={t("common.dismiss", "Dismiss")}
                    className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:text-text-primary"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}

            {/* Import warnings (item 1): the exact messages from the import, threaded from AgentsPage.
                Dismissible once — they describe a past action, not the current config state. */}
            {importWarnings.length > 0 && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-4 py-3"
              >
                <TriangleAlert
                  className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                  aria-hidden="true"
                />
                {/* The body fills the row (flex-1) so each warning's "Review" link right-aligns to the
                    section edge, not to the longest message; the X lives in the header beside the title. */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium text-sm text-text-primary">
                      {t(
                        "editor.importWarningsTitle",
                        "Imported with warnings",
                      )}
                    </p>
                    <button
                      type="button"
                      onClick={() => setImportWarnings([])}
                      aria-label={t("common.dismiss", "Dismiss")}
                      className="-mt-0.5 shrink-0 rounded text-text-muted hover:text-text-primary"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {importWarnings.map((w) => (
                      <li
                        // The import de-dupes by (code + params), so this is unique per warning.
                        key={`${w.code}:${JSON.stringify(w.params ?? {})}`}
                        className="flex items-baseline justify-between gap-3"
                      >
                        <span className="min-w-0 text-text-secondary text-xs">
                          {importWarningMessage(w)}
                        </span>
                        {w.target && (
                          <button
                            type="button"
                            onClick={() => goToImportWarning(w)}
                            className="shrink-0 rounded font-medium text-accent text-xs hover:underline focus-visible:underline"
                          >
                            {t("editor.importWarningReview", "Review")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Live config health (item 1): features enabled without a credential to run them. Persists
                (not dismissible) since it reflects the CURRENT config; "Go to" deep-links to the field. */}
            {configIssues.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-soft px-4 py-3">
                <div className="flex items-start gap-2">
                  <TriangleAlert
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <p className="font-medium text-sm text-text-primary">
                    {t("editor.configIssuesTitle", "Configuration warnings")}
                  </p>
                </div>
                <ul className="flex flex-col gap-1">
                  {configIssues.map((issue) => (
                    <li
                      key={issue.field ?? issue.knowledgeBaseId ?? issue.key}
                      className="flex items-baseline justify-between gap-3 pl-6"
                    >
                      <span className="min-w-0 text-text-secondary text-xs">
                        {issueMessage(issue)}
                      </span>
                      {issueHasAction(issue) && (
                        <button
                          type="button"
                          onClick={() => goToIssue(issue)}
                          className="shrink-0 rounded font-medium text-accent text-xs hover:underline focus-visible:underline"
                        >
                          {issue.key === "knowledge"
                            ? t("editor.indexKnowledge", "Index")
                            : issue.pending
                              ? t("editor.fillCredential", "Fill")
                              : t("editor.goToIssue", "Fix")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {tab === "general" && (
              <GeneralTab
                availability={promptAvailability}
                name={name}
                setName={setName}
                systemPrompt={systemPrompt}
                setSystemPrompt={setSystemPrompt}
                enabled={enabled}
                setEnabled={setEnabled}
                mode={agentMode}
                setMode={setAgentMode}
                model={model}
                setModel={setModel}
                modelCredBaseUrl={modelCredBaseUrl}
                dirty={dirty.general}
                saving={savingAgent}
                onSave={() => {
                  if (!guardModelBeforeSave()) return;
                  saveAgent(
                    {
                      name: name.trim(),
                      systemPrompt,
                      enabled,
                      mode: agentMode,
                      modelConfig: buildModelConfig(),
                    },
                    "general",
                  );
                }}
                onDiscard={revertGeneral}
                onOpenPlayground={openPlayground}
                onDelete={askDelete}
                previewVars={playgroundChat.promptVars}
                catalog={catalog}
                grants={grants}
              />
            )}

            {tab === "channels" && (
              <ChannelsTab
                agentId={id}
                agentName={name}
                onBindingChanged={() => {
                  setServerSyncTick((n) => n + 1);
                }}
              />
            )}

            {tab === "tools" && (
              <ToolsTab
                agentId={id}
                catalog={catalog}
                grants={grants}
                onChange={setGrants}
                onCatalogChange={refreshCatalog}
                transferWithSummary={transferWithSummary}
                setTransferWithSummary={setTransferWithSummary}
                handoff={handoff}
                setHandoff={setHandoff}
                kanbanInstructions={kanbanInstructions}
                setKanbanInstructions={setKanbanInstructions}
                customAttributeInstructions={customAttributeInstructions}
                setCustomAttributeInstructions={setCustomAttributeInstructions}
                labelInstructions={labelInstructions}
                setLabelInstructions={setLabelInstructions}
                updateKanbanTaskInstructions={updateKanbanTaskInstructions}
                toolPreconditions={toolPreconditions}
                setToolPreconditions={setToolPreconditions}
                setUpdateKanbanTaskInstructions={
                  setUpdateKanbanTaskInstructions
                }
                mcpTools={mcpTools}
                setMcpTools={setMcpTools}
                mcpInstructions={mcpInstructions}
                setMcpInstructions={setMcpInstructions}
                mcpCollapsed={mcpCollapsed}
                setMcpCollapsed={setMcpCollapsed}
                integrationCollapsed={integrationCollapsed}
                setIntegrationCollapsed={setIntegrationCollapsed}
                dirty={dirty.tools}
                saving={savingGrants}
                onSave={() => saveTools()}
                onDiscard={revertTools}
                onOpenPlayground={openPlayground}
              />
            )}

            {tab === "knowledge" && (
              <KnowledgeTab
                catalog={catalog}
                grants={grants}
                onChange={setGrants}
                onCatalogChange={refreshCatalog}
                dirty={dirty.knowledge}
                saving={savingGrants}
                onSave={() => saveGrants()}
                onDiscard={revertKnowledge}
                onOpenPlayground={openPlayground}
              />
            )}

            {tab === "behavior" && (
              <BehaviorTab
                agentId={id}
                langfuseSendContent={langfuseSendContent}
                savedObservability={savedObservability}
                hours={hours}
                businessHoursId={businessHoursId}
                setBusinessHoursId={setBusinessHoursId}
                awayEnabled={awayEnabled}
                setAwayEnabled={setAwayEnabled}
                awayMessage={awayMessage}
                setAwayMessage={setAwayMessage}
                followUpHoursId={followUpHoursId}
                setFollowUpHoursId={setFollowUpHoursId}
                debounce={debounce}
                setDebounce={setDebounce}
                stt={stt}
                setStt={setStt}
                sttCredBaseUrl={sttCredBaseUrl}
                contactAuth={contactAuth}
                setContactAuth={setContactAuth}
                tts={tts}
                setTts={setTts}
                // The SAVED model, not the one being edited on General (see savedModel above), and
                // its EFFECTIVE endpoint: a credential that carries its own wins over the typed
                // field, exactly as the runtime resolves it.
                agentModelProvider={savedModel.provider}
                agentModelName={savedModel.model}
                agentModelCredentialRef={savedModel.credentialRef}
                agentModelBaseUrl={savedModelBaseUrl}
                ttsNormalizeCredBaseUrl={ttsNormalizeCredBaseUrl}
                split={split}
                setSplit={setSplit}
                serviceWindow={serviceWindow}
                setServiceWindow={setServiceWindow}
                followUp={followUp}
                setFollowUp={setFollowUp}
                redirectSuppressesFollowUp={
                  channelRedirect.enabled &&
                  (channelRedirect.entryInboxId !== "" ||
                    channelRedirect.widgetInboxId !== null)
                }
                vision={vision}
                setVision={setVision}
                visionCredBaseUrl={visionCredBaseUrl}
                memoryCredBaseUrl={memoryCredBaseUrl}
                modelFallbackCredBaseUrl={modelFallbackCredBaseUrl}
                limits={limits}
                setLimits={setLimits}
                memory={memory}
                setMemory={setMemory}
                modelFallback={modelFallback}
                setModelFallback={setModelFallback}
                observability={observability}
                setObservability={setObservability}
                sendImage={sendImage}
                setSendImage={setSendImage}
                attributeContext={attributeContext}
                setAttributeContext={setAttributeContext}
                onScheduleSaved={onScheduleSaved}
                dirty={dirty.behavior}
                saving={savingAgent}
                onSave={() =>
                  saveAgent(
                    {
                      businessHoursId: businessHoursId || null,
                      followUpHoursId: followUpHoursId || null,
                      settings: buildSettings(),
                    },
                    "behavior",
                  )
                }
                onDiscard={revertBehavior}
                onOpenPlayground={openPlayground}
              />
            )}

            {tab === "guardrails" && (
              <GuardrailsTab
                guardrails={guardrails}
                setGuardrails={setGuardrails}
                dirty={dirty.guardrails}
                saving={savingGuardrails}
                onSave={() => saveGuardrails()}
                onDiscard={revertGuardrails}
              />
            )}

            {tab === "channelRedirect" && (
              <ChannelRedirectTab
                channelRedirect={channelRedirect}
                setChannelRedirect={setChannelRedirect}
                agentId={id}
                dirty={dirty.channelRedirect}
                saving={savingChannelRedirect}
                onSave={() => saveChannelRedirect()}
                onDiscard={revertChannelRedirect}
                onOpenPlayground={openPlayground}
                onGoToChannels={() => navigate(`/agents/${id}/channels`)}
              />
            )}

            {tab === "playground" && (
              <PlaygroundTab
                chat={playgroundChat}
                agentId={id}
                missingConfig={playgroundMissing}
                capabilities={playgroundCapabilities}
                toolsDirty={toolsDirty}
              />
            )}

            {/* Floating playground panel over the other tabs (opened from the save bar's "Test in
                playground" button): tweak config + test live without leaving. */}
            {tab !== "playground" && (
              <PlaygroundFab
                chat={playgroundChat}
                agentId={id}
                missingConfig={playgroundMissing}
                capabilities={playgroundCapabilities}
                toolsDirty={toolsDirty}
                open={playgroundOpen}
                onOpenChange={setPlaygroundOpen}
              />
            )}
          </>
        )}
      </DataBoundary>

      <Modal
        modal={fillCredModal}
        title={t("vault.fillTitle", "Fill pending credential")}
      >
        {fillCredModal.payload && (
          <CredentialForm
            mode="update"
            requireValue
            initialId={fillCredModal.payload.id}
            initialName={fillCredModal.payload.name}
            initialKind={fillCredModal.payload.kind ?? "generic"}
            initialBaseUrl={fillCredModal.payload.baseUrl ?? undefined}
            initialParamName={fillCredModal.payload.paramName ?? undefined}
            onSaved={() => {
              fillCredModal.close();
              // Refresh the pending set so the warning clears once the secret is in.
              invalidateVault();
            }}
            onCancel={() => fillCredModal.close()}
          />
        )}
      </Modal>

      <Modal
        modal={cloneModal}
        title={t("editor.cloneTitle", "Clone agent")}
        unsavedChanges={cloneName !== cloneNameDefaultRef.current}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => cloneModal.close()}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button onClick={doClone}>{t("editor.clone", "Clone")}</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {anyDirty && (
            <div className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-text-secondary text-xs">
              {t(
                "editor.cloneUnsavedNote",
                "Cloning uses the last saved version; your unsaved changes won't be included.",
              )}
            </div>
          )}
          <FormField label={t("editor.cloneName", "New agent name")}>
            <Input
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
            />
          </FormField>
        </div>
      </Modal>

      <ExportAgentModal
        modal={exportModal}
        anyDirty={anyDirty}
        onExport={async ({
          includeComponents,
          includeDocuments,
          saveFirst,
        }) => {
          if (saveFirst) await saveAllDirty();
          await doExport(includeComponents, includeDocuments);
        }}
      />

      {/* KB documents manager, opened from the "index" config-health warning. */}
      {knowledgeManager.modals}

      {/* Edit modals opened from the import-warning "Review" deep-links (reused components). They fetch
          by id and refetch the catalog on save so any in-place tweak reflects without a reload. */}
      <ToolEditModal
        modal={toolEditModal}
        onSaved={() => {
          void refreshCatalog();
        }}
      />
      <McpEditModal
        modal={mcpEditModal}
        onSaved={() => {
          void refreshCatalog();
        }}
      />
      <IntegrationEditModal
        modal={integrationEditModal}
        onSaved={() => {
          void refreshCatalog();
        }}
      />
      {/* Schedule review opened from a reused-business-hours import warning. */}
      <Modal
        modal={businessHoursReviewModal}
        size="lg"
        title={t("hours.editTitle", "Edit schedule")}
      >
        {businessHoursReviewItem && (
          <BusinessHoursForm
            mode="update"
            initial={{
              id: businessHoursReviewItem.id,
              name: businessHoursReviewItem.name,
              timezone: businessHoursReviewItem.timezone,
              windows: businessHoursReviewItem.windows.map((w) => ({ ...w })),
              exceptions: businessHoursReviewItem.exceptions.map((e) => ({
                ...e,
                ranges: e.ranges.map((r) => ({ ...r })),
              })),
            }}
            onSaved={() => businessHoursReviewModal.close()}
            onCancel={() => businessHoursReviewModal.close()}
          />
        )}
      </Modal>

      <StrongConfirmModal modal={strongDelete} />
      <ConfirmDialog modal={confirm} />
    </PageContainer>
  );
}
