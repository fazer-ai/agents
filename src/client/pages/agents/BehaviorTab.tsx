import {
  AlertTriangle,
  ArrowRightLeft,
  Brain,
  CalendarClock,
  Gauge,
  Image,
  ImagePlus,
  Layers,
  LifeBuoy,
  ListChecks,
  Megaphone,
  Mic,
  Plus,
  Scissors,
  ScrollText,
  ShieldCheck,
  Trash2,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ComboBox,
  type ComboItem,
  CredentialPicker,
  FormField,
  Input,
  ModelPicker,
  type ScheduleOption,
  SchedulePicker,
  Select,
  SwitchField,
  Textarea,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { credentialCompat } from "@/client/lib/credentialCompat";
import {
  STT_DEFAULT_MODEL,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
  TTS_PROVIDERS,
  VISION_DEFAULT_MODEL,
} from "@/client/lib/providerDefaults";
import { providerLabel } from "@/client/lib/providerLabels";
import { serverNow, serverNowDate } from "@/client/lib/serverClock";
import { isValidHttpUrl } from "@/client/lib/validation";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import {
  EXTRACTION_PROMPT_MAX,
  FOLLOW_UP_INSTRUCTIONS_MAX,
  TEMPLATE_MESSAGE_MAX,
} from "@/modules/agents/text-caps";
import { formatWindowsSummary } from "@/modules/business-hours/announce";
import { SCOPE_MODEL } from "@/modules/chatwoot/attributes";
import { debugModesFrom } from "@/modules/flowlog/debug-mode";
import {
  FULL_DETAIL_ARM_HOURS,
  isFullDetailWindowOpen,
  type ObservabilityConfig,
} from "@/modules/flowlog/settings";
import { FOLLOW_UP_MAX_STEPS } from "@/modules/followups/settings";
import { visionAcceptsDocuments } from "@/modules/vision/document-support";
import { DEFAULT_EXTRACTION_PROMPT } from "@/modules/vision/prompt-default";
import {
  fallbackIsConfigured,
  fallbackModelIsMissing,
} from "./modelFallbackFormState";
import {
  overrideBaseUrlInvalid,
  overrideBaseUrlUnsupported,
  overrideNeedsOwnCredential,
  overridePicked,
  overridePickerSource,
  overrideProviderChanged,
} from "./modelOverrideForm";
import { Section, SectionNav } from "./SectionNav";
import { TabActionBar } from "./TabActionBar";
import {
  type TtsFormState,
  ttsNormalizerBaseUrlInvalid,
  ttsNormalizerBaseUrlUnsupported,
  ttsNormalizerNeedsOwnCredential,
  ttsNormalizerOverridePicked,
  ttsNormalizerPickerSource,
  ttsNormalizerProviderChanged,
} from "./ttsFormState";
import type { Hours } from "./types";

// Transcription providers (mirror src/modules/stt/providers.ts).
const STT_PROVIDERS = [
  "openai",
  "openai-compatible",
  "gemini",
  "elevenlabs",
  "openrouter",
] as const;

// Audio-reply providers (mirror src/modules/tts/providers). The three reply modes are rendered
// inline as <option>s below.

// Image/document extraction providers (mirror src/modules/vision/providers).
const VISION_PROVIDERS = [
  "openai",
  "openai-compatible",
  "gemini",
  "anthropic",
  "openrouter",
] as const;

// Curated ISO-639-1 codes offered for the transcription language, plus an "other" escape that
// reveals a free-text input (any code the provider accepts).
const STT_LANGUAGES = [
  "pt",
  "en",
  "es",
  "fr",
  "de",
  "it",
  "nl",
  "ja",
  "zh",
  "ko",
  "ru",
  "ar",
  "hi",
] as const;

interface DebounceState {
  enabled: boolean;
  windowSeconds: string;
  maxMessagesPerBurst: string;
  maxWindowSeconds: string;
}

interface SttState {
  enabled: boolean;
  provider: string;
  model: string;
  language: string;
  credentialRef: string;
  baseURL: string;
}

// NOTE: The contact authorization gate (agent.settings.contactAuth). Numbers stay text so a
// half-typed value survives editing; the runtime reader clamps on read and the save normalizes.
export interface ContactAuthState {
  enabled: boolean;
  url: string;
  credentialRef: string;
  timeoutMs: string;
  noticeCooldownSeconds: string;
  includeMessageText: boolean;
  denyMessage: string;
  handoffEnabled: boolean;
  handoffTeamId: string;
  // The ChatwootInstance the team above was picked from, recorded with it: a team id belongs to one
  // account, and the runtime only assigns it in that one.
  handoffTeamInstanceId: string;
}

interface SplitState {
  enabled: boolean;
  maxChars: string;
  typingWpm: string;
  maxDelayMs: string;
}

interface VisionState {
  enabled: boolean;
  provider: string;
  model: string;
  credentialRef: string;
  baseURL: string;
  extractionPrompt: string;
}

interface LimitsState {
  maxToolCalls: string;
  // Empty string = no ceiling. Kept as text so an operator can clear the field to disable it; the
  // reader turns anything non-positive into null.
  maxHistoryTokens: string;
}

// NOTE: The allowed-host list is edited as raw textarea text (one per line) and only turns into an
// array on save — the runtime reader normalizes and drops what does not resolve to a hostname, so
// the operator's half-typed line survives editing instead of vanishing under them.
// The summarizer's block. The four model fields are an OVERRIDE of the agent's model: all blank is
// "run on the agent's model", which is what every agent that never touched this means.
export interface MemoryState {
  compactionEnabled: boolean;
  provider: string;
  model: string;
  credentialRef: string;
  baseURL: string;
}

// The second provider behind the agent's own. No `enabled` flag of its own, deliberately: a
// fallback exists exactly when a provider AND a model are named, so the switch would be a third way
// to say the same thing and a way for the two to disagree.
export interface ModelFallbackState {
  provider: string;
  model: string;
  credentialRef: string;
  baseURL: string;
}

export interface SendImageState {
  allowedHosts: string;
}

// NOTE: Which Chatwoot custom attributes the agent sees the CURRENT VALUES of (one key list per
// scope). Mirrors agent.settings.attributeContext / readAttributeContextConfig.
interface AttributeContextState {
  conversation: string[];
  contact: string[];
  task: string[];
}

interface ServiceWindowState {
  enabled: boolean;
  windowHours: string;
  templateName: string;
  templateLanguage: string;
  templateParams: string;
  templateContent: string;
}

export interface FollowUpStepState {
  delayValue: string;
  delayUnit: string;
  instructions: string;
  assignLabels: string[]; // labels added to the conversation when this step fires
  resolve: boolean; // honored only on the last step
  ignoreAppointmentPause: boolean; // fire this step even while an appointment stands
}

export interface FollowUpState {
  enabled: boolean;
  steps: FollowUpStepState[];
  pauseWhileAppointment: boolean;
}

interface BehaviorTabProps {
  agentId: string;
  hours: Hours[];
  businessHoursId: string;
  setBusinessHoursId: (v: string) => void;
  awayEnabled: boolean;
  setAwayEnabled: (v: boolean) => void;
  awayMessage: string;
  setAwayMessage: (v: string) => void;
  followUpHoursId: string;
  setFollowUpHoursId: (v: string) => void;
  debounce: DebounceState;
  setDebounce: React.Dispatch<React.SetStateAction<DebounceState>>;
  stt: SttState;
  setStt: React.Dispatch<React.SetStateAction<SttState>>;
  sttCredBaseUrl: string | null;
  contactAuth: ContactAuthState;
  setContactAuth: React.Dispatch<React.SetStateAction<ContactAuthState>>;
  tts: TtsFormState;
  setTts: React.Dispatch<React.SetStateAction<TtsFormState>>;
  // The agent's own model, to render the speech rewrite's inherited default honestly (blank there
  // means "the agent's model" while the provider is unchanged) and to let the rewrite's model picker
  // authenticate with the key the rewrite will actually run on.
  agentModelProvider: string;
  agentModelName: string;
  agentModelCredentialRef: string;
  agentModelBaseUrl: string;
  ttsNormalizeCredBaseUrl: string | null;
  split: SplitState;
  setSplit: React.Dispatch<React.SetStateAction<SplitState>>;
  vision: VisionState;
  setVision: React.Dispatch<React.SetStateAction<VisionState>>;
  visionCredBaseUrl: string | null;
  limits: LimitsState;
  memory: MemoryState;
  setMemory: React.Dispatch<React.SetStateAction<MemoryState>>;
  modelFallback: ModelFallbackState;
  setModelFallback: React.Dispatch<React.SetStateAction<ModelFallbackState>>;
  modelFallbackCredBaseUrl: string | null;
  // The base URL stored on the summarizer's OWN credential, when it has one. Outranks the typed
  // field, exactly as it does for the speech rewrite.
  memoryCredBaseUrl: string | null;
  observability: ObservabilityConfig;
  setObservability: React.Dispatch<React.SetStateAction<ObservabilityConfig>>;
  // What the SERVER is recording right now, which is not what the switches say once one is touched.
  // The warning reads this and the switches read `observability`, because a switch flipped off stops
  // recording when the save lands: a warning driven by the form goes quiet on the touch and tells
  // the operator recording stopped while it is still running — and an operator who then leaves
  // without saving takes that answer with them.
  savedObservability: ObservabilityConfig;
  // Whether the tenant asked for trace CONTENT to reach Langfuse. It is the third switch that
  // widens what is recorded, it lives on another page entirely (Resources > Advanced), and it is
  // therefore the one an operator forgets — so the warning here reads it too. Null while it is
  // still loading, which reads as "not known yet" and never as "off".
  langfuseSendContent: boolean | null;
  setLimits: React.Dispatch<React.SetStateAction<LimitsState>>;
  sendImage: SendImageState;
  setSendImage: React.Dispatch<React.SetStateAction<SendImageState>>;
  attributeContext: AttributeContextState;
  setAttributeContext: React.Dispatch<
    React.SetStateAction<AttributeContextState>
  >;
  serviceWindow: ServiceWindowState;
  setServiceWindow: React.Dispatch<React.SetStateAction<ServiceWindowState>>;
  followUp: FollowUpState;
  setFollowUp: React.Dispatch<React.SetStateAction<FollowUpState>>;
  // True when the WhatsApp→chat redirect is enabled with an inbox wired: the follow-up below is then
  // suppressed for the redirect's entry + widget inboxes (a callout in the section explains it).
  redirectSuppressesFollowUp: boolean;
  onScheduleSaved: (savedId: string, setter: (v: string) => void) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onOpenPlayground: () => void;
}

function toScheduleOption(h: Hours): ScheduleOption {
  return {
    id: String(h.id),
    name: h.name,
    windows: (h.windows ?? []) as ScheduleOption["windows"],
    exceptions: (h.exceptions ?? []) as ScheduleOption["exceptions"],
    timezone: h.timezone,
  };
}

// Service-window HSM template field: a picker populated with the approved templates of the agent's
// inbox(es) (live from Chatwoot), over a free-text input that stays the source of truth. With no
// templates (e.g. baileys channels have none) only the input shows, plus a note. Derived Eden type.
type SwTemplate = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<
        (typeof api.api.v1.chatwoot)["service-window-templates"]
      >["get"]
    >
  >["data"]
>["templates"][number];

function ServiceWindowTemplateField({
  agentId,
  serviceWindow,
  setServiceWindow,
}: {
  agentId: string;
  serviceWindow: ServiceWindowState;
  setServiceWindow: React.Dispatch<React.SetStateAction<ServiceWindowState>>;
}) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<SwTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot["service-window-templates"]({
          agentId,
        }).get();
        if (!cancelled && data) setTemplates(data.templates);
      } catch {
        // best-effort: leave the free-text field as the fallback
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  return (
    <FormField
      label={t("editor.svcWindowTemplate", "Template name (HSM)")}
      group
      description={t(
        "editor.svcWindowTemplateHint",
        "Approved template sent outside the window. Blank → skip (private note).",
      )}
    >
      <div className="flex flex-col gap-2">
        {templates.length > 0 && (
          <Select
            value={
              templates.some((x) => x.name === serviceWindow.templateName)
                ? serviceWindow.templateName
                : ""
            }
            onChange={(e) => {
              const tpl = templates.find((x) => x.name === e.target.value);
              if (tpl) {
                setServiceWindow({
                  ...serviceWindow,
                  templateName: tpl.name,
                  templateLanguage:
                    tpl.language || serviceWindow.templateLanguage,
                });
              }
            }}
            aria-label={t("editor.svcWindowTemplate", "Template name (HSM)")}
          >
            <option value="">
              {t(
                "editor.svcWindowTemplatePick",
                "Choose an approved template…",
              )}
            </option>
            {templates.map((tpl) => (
              <option key={tpl.name} value={tpl.name}>
                {tpl.language ? `${tpl.name} (${tpl.language})` : tpl.name}
              </option>
            ))}
          </Select>
        )}
        <Input
          value={serviceWindow.templateName}
          onChange={(e) =>
            setServiceWindow({
              ...serviceWindow,
              templateName: e.target.value,
            })
          }
          placeholder="reengajamento"
        />
        {loaded && templates.length === 0 && (
          <span className="text-text-muted text-xs">
            {t(
              "editor.svcWindowNoTemplates",
              "No approved templates found for this agent's inbox. Type a name manually.",
            )}
          </span>
        )}
      </div>
    </FormField>
  );
}

// TTS voice/model picker backed by the live listing endpoint (item 10): OpenAI returns a curated set,
// ElevenLabs is fetched with the vault credential so the operator picks a real per-account voice by
// name. Eager-loads (when it won't error for lack of a credential) so the trigger shows the human
// label; typing a custom value still works (parity with the old free input).
function TtsOptionPicker({
  kind,
  provider,
  credentialRef,
  baseURL,
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  kind: "voices" | "models";
  provider: string;
  credentialRef?: string;
  baseURL?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  const loaderKey = `${kind}||${provider}||${credentialRef ?? ""}||${baseURL ?? ""}`;
  const loader = useCallback(async (): Promise<ComboItem[]> => {
    const { data, error } = await api.api.v1.agents.tts.list.post({
      provider,
      kind,
      credentialRef,
      baseURL,
    });
    if (error || !data) throw new Error("tts list failed");
    return data.items.map((i) => ({
      id: i.id,
      label: i.label ?? undefined,
      hint: i.label && i.label !== i.id ? i.id : undefined,
    }));
  }, [provider, kind, credentialRef, baseURL]);
  return (
    <ComboBox
      value={value}
      onChange={onChange}
      loader={loader}
      loaderKey={loaderKey}
      eager
      needsCredential={provider === "elevenlabs" && !credentialRef}
      placeholder={placeholder}
      searchPlaceholder={t("common.search", "Search")}
      aria-label={ariaLabel}
    />
  );
}

type InboxLabelOption = { title: string; color: string | null };

// Multi-select label picker for a follow-up step's "assign label" action (item 4): one ComboBox over
// the agent inbox's known labels (with their Chatwoot color), where the operator picks any number of
// labels and can still type one that doesn't exist yet. When the agent spans more than one Chatwoot
// account (item 5) the label set can't be listed coherently, so it shows a warning and stays free-text.
function LabelPicker({
  values,
  onChange,
  labels,
  multiAccount,
  ariaLabel,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  labels: InboxLabelOption[];
  multiAccount: boolean;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <ComboBox
        multiple
        values={values}
        onChange={onChange}
        items={labels.map((l) => ({
          id: l.title,
          color: l.color ?? undefined,
        }))}
        placeholder={t("editor.followUpLabelPlaceholder", "Add a label…")}
        searchPlaceholder={t("editor.followUpLabelSearch", "Search labels…")}
        aria-label={ariaLabel}
      />
      {multiAccount && (
        <span className="text-text-muted text-xs">
          {t(
            "editor.followUpLabelMultiAccount",
            "This agent serves more than one Chatwoot account, so labels can't be listed. Type each label exactly as it appears.",
          )}
        </span>
      )}
    </div>
  );
}

// NOTE: Chatwoot attribute definition (Eden-derived), for the attribute-context pickers below.
type InboxCustomAttribute = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<(typeof api.api.v1.chatwoot)["custom-attributes"]>["get"]
    >
  >["data"]
>["attributes"][number];

// NOTE: The three attribute pickers (conversation / contact / kanban card). Each lists the account's
// definitions for that scope, and still accepts a typed key the listing doesn't know (an unreachable
// Chatwoot, or an attribute created after this page loaded) — the runtime only needs the key.
function AttributeContextPickers({
  agentId,
  attributeContext,
  setAttributeContext,
}: {
  agentId: string;
  attributeContext: AttributeContextState;
  setAttributeContext: React.Dispatch<
    React.SetStateAction<AttributeContextState>
  >;
}) {
  const { t } = useTranslation();
  const [defs, setDefs] = useState<InboxCustomAttribute[]>([]);
  const [multiAccount, setMultiAccount] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // NOTE: Drop the previous agent's definitions BEFORE fetching. If the new request fails (the
    // catch below is deliberately silent), keeping them would offer one agent's attribute keys —
    // and the multi-account warning — while editing another.
    setDefs([]);
    setMultiAccount(false);
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot["custom-attributes"]({
          agentId,
        }).get();
        if (!cancelled && data) {
          setDefs(data.attributes);
          setMultiAccount(data.accountCount > 1);
        }
      } catch {
        // NOTE: best-effort — the pickers still accept typed keys
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const scopes: Array<{
    scope: keyof AttributeContextState;
    label: string;
    hint: string;
  }> = [
    {
      scope: "conversation",
      label: t("editor.attributeContextConversation", "Conversation"),
      hint: t(
        "editor.attributeContextConversationHint",
        "Attributes of this conversation (reset with each new conversation).",
      ),
    },
    {
      scope: "contact",
      label: t("editor.attributeContextContact", "Contact"),
      hint: t(
        "editor.attributeContextContactHint",
        "Attributes of the customer, kept across every conversation they have.",
      ),
    },
    {
      scope: "task",
      label: t("editor.attributeContextTask", "Kanban card"),
      hint: t(
        "editor.attributeContextTaskHint",
        "Attributes of the card linked to this conversation, when there is one.",
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {scopes.map(({ scope, label, hint }) => (
        <FormField key={scope} group label={label} description={hint}>
          <ComboBox
            multiple
            values={attributeContext[scope]}
            onChange={(values) =>
              setAttributeContext((prev) => ({ ...prev, [scope]: values }))
            }
            items={defs
              .filter((d) => d.model === SCOPE_MODEL[scope])
              .map((d) => ({
                id: d.key,
                label: d.displayName || d.key,
                hint: d.displayName && d.displayName !== d.key ? d.key : "",
              }))}
            placeholder={t(
              "editor.attributeContextPlaceholder",
              "Add an attribute…",
            )}
            searchPlaceholder={t(
              "editor.attributeContextSearch",
              "Search attributes…",
            )}
            aria-label={label}
          />
        </FormField>
      ))}
      {multiAccount && (
        <span className="text-text-muted text-xs">
          {t(
            "editor.attributeContextMultiAccount",
            "This agent serves more than one Chatwoot account, so the listed attributes mix accounts. Type each key exactly as it appears.",
          )}
        </span>
      )}
    </div>
  );
}

// Team a refused conversation is assigned to after the open. Fed by the same live listing the
// handoff pinned-target picker uses, which only lists when the agent serves exactly ONE Chatwoot
// account (teams are account-scoped). A stored id that is not in the listing still shows, so a
// saved choice is never silently hidden.
function ContactAuthTeamSelect({
  agentId,
  value,
  onChange,
}: {
  agentId: string;
  value: string;
  // The team AND the account it came from: stored together, because the id alone means nothing
  // outside it.
  onChange: (teamId: string, instanceId: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    teams: Array<{ id: number; name: string }>;
    accountCount: number;
    // Our ChatwootInstance id of the single account, when there is exactly one.
    instanceId: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: d } = await api.api.v1.chatwoot["agents-teams"]({
          agentId,
        }).get();
        if (!cancelled) {
          setData(
            d
              ? {
                  teams: d.teams,
                  accountCount: d.accounts.length,
                  instanceId: d.accounts[0]?.instanceId ?? "",
                }
              : { teams: [], accountCount: 0, instanceId: "" },
          );
        }
      } catch {
        if (!cancelled) setData({ teams: [], accountCount: 0, instanceId: "" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  const teams = data?.teams ?? [];
  const listed = teams.some((tm) => String(tm.id) === value);
  // Populated only when the agent serves exactly one account, which is the only case the picker
  // offers teams in.
  const instanceId = data?.accountCount === 1 ? data.instanceId : "";
  // A Chatwoot team id means something inside ONE account. When the agent serves several, the
  // listing deliberately comes back empty, and keeping the stored id as a "(not listed)" option
  // re-saved a target that the runtime then applies through EVERY account's client: in the other
  // accounts that number is a different team or none, so refused contacts are routed nowhere.
  // Cleared here rather than at save time, so the operator sees the field empty and the warning
  // saying why, and still has to press save.
  const multiAccount = data !== null && data.accountCount > 1;
  useEffect(() => {
    if (multiAccount && value) onChange("", "");
  }, [multiAccount, value, onChange]);
  return (
    <FormField
      label={t("editor.contactAuthTeam", "Assign to team")}
      group
      description={t(
        "editor.contactAuthTeamHint",
        "Optional. Without a team, Chatwoot's inbox routing decides who takes it.",
      )}
    >
      <div className="flex flex-col gap-1.5">
        <Select
          value={value}
          onChange={(e) => onChange(e.target.value, instanceId)}
          aria-label={t("editor.contactAuthTeam", "Assign to team")}
        >
          <option value="">
            {t("editor.contactAuthNoTeam", "No team (inbox routing)")}
          </option>
          {!listed && value && !multiAccount && (
            <option value={value}>
              {t("editor.contactAuthTeamStored", "Team #{{id}} (not listed)", {
                id: value,
              })}
            </option>
          )}
          {teams.map((tm) => (
            <option key={tm.id} value={String(tm.id)}>
              {tm.name}
            </option>
          ))}
        </Select>
        {data && data.accountCount !== 1 && (
          <span className="text-text-muted text-xs">
            {data.accountCount === 0
              ? t(
                  "editor.handoffPinnedNoInbox",
                  "Bind at least one inbox in the Channels tab first.",
                )
              : t(
                  "editor.contactAuthTeamMultiAccount",
                  "This agent serves more than one Chatwoot account. A team id belongs to one account, so no team can be targeted here — Chatwoot's inbox routing decides who takes a refused conversation.",
                )}
          </span>
        )}
      </div>
    </FormField>
  );
}

// The multi-step follow-up editor: an ordered list of step cards (delay + instructions + optional
// label, and a resolve toggle on the LAST step). Labels are fetched once per agent from the inbox.
function FollowUpStepsEditor({
  agentId,
  followUp,
  setFollowUp,
}: {
  agentId: string;
  followUp: FollowUpState;
  setFollowUp: React.Dispatch<React.SetStateAction<FollowUpState>>;
}) {
  const { t } = useTranslation();
  const [labels, setLabels] = useState<InboxLabelOption[]>([]);
  const [multiAccount, setMultiAccount] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot.labels({ agentId }).get();
        if (!cancelled && data) {
          setLabels(data.labels);
          setMultiAccount(data.accountCount > 1);
        }
      } catch {
        // best-effort: leave the free-text field as the fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const steps = followUp.steps;
  const updateStep = (index: number, patch: Partial<FollowUpStepState>) =>
    setFollowUp((prev) => ({
      ...prev,
      steps: prev.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  const addStep = () =>
    setFollowUp((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        {
          delayValue: "1",
          delayUnit: "days",
          instructions: "",
          assignLabels: [],
          resolve: false,
          ignoreAppointmentPause: false,
        },
      ],
    }));
  const removeStep = (index: number) =>
    setFollowUp((prev) => ({
      ...prev,
      steps: prev.steps.filter((_, i) => i !== index),
    }));

  return (
    <div className="flex flex-col gap-3">
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional (no stable id); reorder is add/remove only
            key={index}
            className="flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h5 className="font-medium text-sm text-text-secondary">
                {t("editor.followUpStep", "Step {{n}}", { n: index + 1 })}
              </h5>
              {steps.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeStep(index)}
                  aria-label={t("editor.followUpRemoveStep", "Remove step")}
                  className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:text-error"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
            <FormField
              label={
                index === 0
                  ? t("editor.followUpDelay", "Inactivity delay")
                  : t("editor.followUpStepDelay", "Wait after previous step")
              }
              group
            >
              <div className="flex items-stretch gap-2">
                <Input
                  type="number"
                  min={1}
                  value={step.delayValue}
                  onChange={(e) =>
                    updateStep(index, { delayValue: e.target.value })
                  }
                  className="w-24 text-sm"
                />
                <Select
                  value={step.delayUnit}
                  onChange={(e) =>
                    updateStep(index, { delayUnit: e.target.value })
                  }
                >
                  <option value="minutes">
                    {t("editor.followUpMinutes", "Minutes")}
                  </option>
                  <option value="hours">
                    {t("editor.followUpHoursUnit", "Hours")}
                  </option>
                  <option value="days">
                    {t("editor.followUpDays", "Days")}
                  </option>
                </Select>
              </div>
            </FormField>
            <FormField
              label={t("editor.followUpInstructions", "Follow-up instructions")}
            >
              <Textarea
                value={step.instructions}
                onChange={(e) =>
                  updateStep(index, { instructions: e.target.value })
                }
                maxLength={FOLLOW_UP_INSTRUCTIONS_MAX}
                rows={3}
                placeholder={t(
                  "editor.followUpInstructionsPlaceholder",
                  "E.g.: Greet the customer warmly, remind them of the open question, and offer to help.",
                )}
              />
            </FormField>
            <FormField
              label={t("editor.followUpAssignLabel", "Assign label")}
              group
              description={t(
                "editor.followUpAssignLabelHint",
                "Added to the conversation when this step fires (even if the agent stays silent).",
              )}
            >
              <LabelPicker
                values={step.assignLabels}
                onChange={(v) => updateStep(index, { assignLabels: v })}
                labels={labels}
                multiAccount={multiAccount}
                ariaLabel={t("editor.followUpAssignLabel", "Assign label")}
              />
            </FormField>
            {/* Only while the agent-wide pause is ON: with it off nothing pauses, so this switch
                would decide nothing. Hidden is not off — the value is kept and saved either way. */}
            {followUp.pauseWhileAppointment && (
              <div className="flex flex-col gap-1.5">
                <SwitchField
                  checked={step.ignoreAppointmentPause}
                  onCheckedChange={(v) =>
                    updateStep(index, { ignoreAppointmentPause: v })
                  }
                  label={t(
                    "editor.followUpIgnorePause",
                    "Send this step even during an appointment",
                  )}
                />
                <p className="text-text-muted text-xs">
                  {t(
                    "editor.followUpIgnorePauseHint",
                    "Exempts THIS step from the pause below. Use it for a step that only means anything while the appointment stands, such as a payment deadline; the other steps keep waiting.",
                  )}
                </p>
              </div>
            )}
            {isLast && (
              <SwitchField
                checked={step.resolve}
                onCheckedChange={(v) => updateStep(index, { resolve: v })}
                label={t(
                  "editor.followUpResolve",
                  "Resolve the conversation on this step",
                )}
              />
            )}
          </div>
        );
      })}
      {steps.length < FOLLOW_UP_MAX_STEPS && (
        <Button variant="secondary" size="sm" onClick={addStep}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("editor.followUpAddStep", "Add step")}
        </Button>
      )}
    </div>
  );
}

export function BehaviorTab({
  agentId,
  hours,
  businessHoursId,
  setBusinessHoursId,
  awayEnabled,
  setAwayEnabled,
  awayMessage,
  setAwayMessage,
  followUpHoursId,
  setFollowUpHoursId,
  debounce,
  setDebounce,
  stt,
  setStt,
  sttCredBaseUrl,
  contactAuth,
  setContactAuth,
  tts,
  setTts,
  agentModelProvider,
  agentModelName,
  agentModelCredentialRef,
  agentModelBaseUrl,
  ttsNormalizeCredBaseUrl,
  split,
  setSplit,
  vision,
  setVision,
  visionCredBaseUrl,
  limits,
  memory,
  setMemory,
  modelFallback,
  setModelFallback,
  modelFallbackCredBaseUrl,
  memoryCredBaseUrl,
  observability,
  savedObservability,
  langfuseSendContent,
  setObservability,
  setLimits,
  sendImage,
  setSendImage,
  attributeContext,
  setAttributeContext,
  serviceWindow,
  setServiceWindow,
  followUp,
  setFollowUp,
  redirectSuppressesFollowUp,
  onScheduleSaved,
  dirty,
  saving,
  onSave,
  onDiscard,
  onOpenPlayground,
}: BehaviorTabProps) {
  const { t, i18n } = useTranslation();

  // NOTE: the `enabled` guards are load-bearing, not defensive. Each block is HIDDEN when its
  // feature is off, so a leftover openai-compatible provider with no endpoint would disable Save for
  // the whole tab with nothing on screen to explain it — including the save that turns the feature
  // off. A disabled feature cannot be misconfigured.
  const sttBaseUrlInvalid =
    stt.enabled &&
    stt.provider === "openai-compatible" &&
    !sttCredBaseUrl &&
    !isValidHttpUrl(stt.baseURL);

  // Required while the gate is on: an enabled gate with no reachable URL fails closed on every
  // message, which is the whole agent going silent with nothing on screen to explain it. A URL
  // carrying `user:pass@` is refused here for the same reason the reader refuses it (credentials
  // belong in the vault); without this check the save would succeed and the runtime would read the
  // field as unconfigured.
  // The shared warning of #58. It reads all three switches that widen what is recorded, INCLUDING
  // the tenant-level one that lives on another page, because an operator does not remember which of
  // three unrelated screens they touched last week. Empty (falsy) when nothing is on, so the block
  // renders only when there is something to say.
  // The saved config was read at load or at save, and one of its fields STOPS BEING TRUE ON ITS OWN:
  // the size switch expires. An editor left open past the deadline would otherwise keep saying full
  // detail is being recorded while the runtime already stopped, which is the same lie as the one
  // this warning was just fixed for, arriving by the clock instead of by a click. So the state is
  // re-derived once, exactly when the window closes.
  const [judgedAt, setJudgedAt] = useState(() => serverNowDate());
  const savedUntilMs = savedObservability.fullDetailUntil?.getTime() ?? null;
  const formUntilMs = observability.fullDetailUntil?.getTime() ?? null;
  // The deadlines are TRIGGERS here, not reads: the body uses neither, and their changing is the
  // whole signal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger, not a read
  useEffect(() => {
    // Re-judged whenever a deadline CHANGES, not only when one expires. A tab left open overnight
    // still holds its mount-time instant, and a deadline armed 12h ahead of NOW reads as more than
    // 24h ahead of THAT — so the reader's far-side bound would refuse it and the warning would stay
    // silent for the whole window it was just armed for.
    setJudgedAt(serverNowDate());
  }, [savedUntilMs, formUntilMs]);
  // `judgedAt` is a TRIGGER here, not a read: it is what re-runs this after a timer fires, so the
  // next deadline gets scheduled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger, not a read
  useEffect(() => {
    // The next moment either answer changes: the saved deadline governs the warning, the form's
    // governs the switch, and whichever comes first is when something on screen stops being true.
    const next = [savedUntilMs, formUntilMs]
      .filter((v): v is number => v !== null && v > serverNow())
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const ms = next - serverNow();
    // `setTimeout` saturates past ~24.9 days, and a delay it cannot represent fires IMMEDIATELY,
    // which would read as an expiry that already happened. The window is bounded far below that,
    // so this only ever guards a hand-written deadline.
    if (ms > 2_147_483_647) return;
    const timer = setTimeout(() => setJudgedAt(serverNowDate()), ms);
    return () => clearTimeout(timer);
    // `judgedAt` is a dependency so this re-runs AFTER a timer fires and schedules whatever comes
    // next. Without it the effect arms the earlier of the two deadlines and then never runs again,
    // because neither deadline changed — so a form deadline of 12h and a saved one of 20h would
    // leave the warning standing after the saved window closed.
  }, [savedUntilMs, formUntilMs, judgedAt]);

  const debugModesOn = useMemo(() => {
    // Through the shared derivation, never a second copy of the same `||`: a switch added to it
    // would light the indicator everywhere except in the copy, and the copy is the one place the
    // tests that cover that file cannot see.
    const m = debugModesFrom(
      savedObservability,
      langfuseSendContent === true,
      judgedAt,
    );
    if (!m.any) return null;
    const on: string[] = [];
    if (m.logToolValues)
      on.push(t("editor.observabilityOnToolValues", "tool values"));
    if (m.fullDetail)
      on.push(t("editor.observabilityOnFullDetail", "full log detail"));
    if (m.langfuseSendContent)
      on.push(t("editor.observabilityOnLangfuse", "content sent to Langfuse"));
    return on;
  }, [savedObservability, langfuseSendContent, judgedAt, t]);

  const contactAuthUrlHasCredentials = (() => {
    try {
      const u = new URL(contactAuth.url.trim());
      return Boolean(u.username || u.password);
    } catch {
      return false;
    }
  })();
  const contactAuthUrlInvalid =
    contactAuth.enabled &&
    (!contactAuth.url.trim() ||
      !isValidHttpUrl(contactAuth.url) ||
      contactAuthUrlHasCredentials);

  const visionBaseUrlInvalid =
    vision.enabled &&
    vision.provider === "openai-compatible" &&
    !visionCredBaseUrl &&
    !isValidHttpUrl(vision.baseURL);

  // The speech rewrite's model, resolved the way the RUNTIME will resolve it (inherited field by
  // field while the provider is the agent's own), so the picker queries with a key that works and
  // the endpoint check covers the inherited case too.
  const agentModel = {
    provider: agentModelProvider,
    credentialRef: agentModelCredentialRef,
    baseURL: agentModelBaseUrl,
  };
  const normalizeSource = ttsNormalizerPickerSource(
    tts,
    agentModel,
    ttsNormalizeCredBaseUrl,
  );
  // Blank means "the agent's", both here and in the resolver, so the fields below follow THIS
  // rather than the raw override: an openai-compatible agent whose rewrite inherits the provider
  // still runs against an endpoint, and hiding that field made it un-inspectable.
  const normalizeEffectiveProvider =
    tts.normalizeProvider || agentModelProvider;

  // The summarizer's model, resolved the SAME way, through the shared projection rather than a
  // second copy of the rule.
  const memoryOverride = {
    provider: memory.provider,
    model: memory.model,
    credentialRef: memory.credentialRef,
    baseURL: memory.baseURL,
  };
  const memorySource = overridePickerSource(
    memoryOverride,
    agentModel,
    memoryCredBaseUrl,
  );
  const memoryEffectiveProvider = memory.provider || agentModelProvider;
  const memoryNeedsOwnCredential = overrideNeedsOwnCredential(
    memoryOverride,
    agentModel,
    memoryCredBaseUrl,
  );
  // The endpoint half of the same resolution, and the reason it is here rather than only on the
  // field: the summariser is the second override in this tab, and the first one already blocks the
  // save on both of these. A section that renders the picker without them saves a configuration the
  // runtime refuses, and the operator's only signal is attendances quietly staying raw.
  const memoryBaseUrlInvalid = overrideBaseUrlInvalid(
    memoryOverride,
    agentModel,
    memoryCredBaseUrl,
    memory.compactionEnabled,
  );
  const memoryBaseUrlUnsupported = overrideBaseUrlUnsupported(
    memoryOverride,
    agentModel,
    memoryCredBaseUrl,
    memory.compactionEnabled,
  );
  const fallbackOverride = {
    provider: modelFallback.provider,
    model: modelFallback.model,
    credentialRef: modelFallback.credentialRef,
    baseURL: modelFallback.baseURL,
  };
  // A fallback is CONFIGURED once a destination is named, and that is the flag every check below
  // reads — including the endpoint ones, which is why it has to agree with the backend rather than
  // approximate it. Written as "both halves are named", it answered NO for a model-less
  // `openai-compatible` fallback, which the backend calls configured: the base-URL checks switched
  // themselves off, Save went through on a missing or malformed endpoint, the server stored it, and
  // the runtime could not build it. Same rule, same predicate, one place.
  const fallbackConfigured = fallbackIsConfigured(modelFallback);
  // Named, and on the save gate, because the round trip does not survive it: `modelFallbackToStored`
  // persists `{provider: "openai", model: null}`, `hasModelFallback` answers false, and the form
  // reader maps that straight back to "No fallback" — so the provider the operator picked is gone on
  // the next load with nothing on screen to say why. The write boundary refuses it too
  // (`assertSettingsModelFallback`, which is what covers the MCP patch); this is what keeps the
  // operator from meeting that refusal as a 400 on a button they were never stopped from pressing.
  const fallbackModelMissing = fallbackModelIsMissing(modelFallback);
  const fallbackSource = overridePickerSource(
    fallbackOverride,
    agentModel,
    modelFallbackCredBaseUrl,
  );
  const fallbackEffectiveProvider =
    modelFallback.provider || agentModelProvider;
  const fallbackNeedsOwnCredential = overrideNeedsOwnCredential(
    fallbackOverride,
    agentModel,
    modelFallbackCredBaseUrl,
  );
  const fallbackBaseUrlInvalid = overrideBaseUrlInvalid(
    fallbackOverride,
    agentModel,
    modelFallbackCredBaseUrl,
    fallbackConfigured,
  );
  const fallbackBaseUrlUnsupported = overrideBaseUrlUnsupported(
    fallbackOverride,
    agentModel,
    modelFallbackCredBaseUrl,
    fallbackConfigured,
  );
  const normalizeBaseUrlInvalid = ttsNormalizerBaseUrlInvalid(
    tts,
    agentModel,
    ttsNormalizeCredBaseUrl,
  );
  const normalizeBaseUrlUnsupported = ttsNormalizerBaseUrlUnsupported(
    tts,
    agentModel,
    ttsNormalizeCredBaseUrl,
  );

  // Transcription language: a curated dropdown with an "other" escape to a free-text ISO code.
  const sttLangKnown = (STT_LANGUAGES as readonly string[]).includes(
    stt.language,
  );
  const langNames = (() => {
    try {
      return new Intl.DisplayNames([i18n.language], { type: "language" });
    } catch {
      return null;
    }
  })();
  const langLabel = (code: string) => {
    const name = langNames?.of(code);
    return name && name !== code ? `${name} (${code})` : code;
  };

  // Section index (item 9): the left-rail nav + scroll-spy track these in order. Labels reuse the
  // section titles; icons are thematic.
  const sections = [
    {
      id: "availability",
      icon: CalendarClock,
      label: t("editor.availability", "Availability"),
    },
    {
      id: "debounce",
      icon: Layers,
      label: t("editor.debounce", "Message grouping (debounce)"),
    },
    {
      id: "stt",
      icon: Mic,
      label: t("editor.stt", "Voice transcription (audio)"),
    },
    {
      id: "vision",
      icon: Image,
      label: t("editor.vision", "Image & document reading"),
    },
    {
      id: "tts",
      icon: Volume2,
      label: t("editor.tts", "Audio replies (text-to-speech)"),
    },
    {
      id: "split",
      icon: Scissors,
      label: t("editor.split", "Reply in multiple messages"),
    },
    {
      id: "attributeContext",
      icon: ListChecks,
      label: t("editor.attributeContext", "Data in context"),
    },
    {
      id: "sendImage",
      icon: ImagePlus,
      label: t("editor.sendImage", "Sending images"),
    },
    // Last of the behaviour sections and before the operational ones: most agents never turn this
    // on, so it does not belong above the grouping/audio/memory settings every agent uses — but it
    // decides whether the agent speaks at all, so it does not belong at the very bottom either.
    {
      id: "contactAuth",
      icon: ShieldCheck,
      label: t("editor.contactAuth", "Contact authorization"),
    },
    {
      id: "limits",
      icon: Gauge,
      label: t("editor.limits", "Execution limits"),
    },
    {
      id: "memory",
      icon: Brain,
      label: t("editor.memory", "Memory"),
    },
    {
      id: "modelFallback",
      icon: LifeBuoy,
      label: t("editor.modelFallback", "Fallback provider"),
    },
    {
      id: "observability",
      icon: ScrollText,
      label: t("editor.observability", "Logs"),
    },
    {
      id: "proactive",
      icon: Megaphone,
      label: t("editor.proactiveSection", "Proactive messages"),
    },
  ];

  return (
    <div className="flex grow flex-col gap-4">
      <div className="flex gap-6">
        <SectionNav sections={sections} />
        <div className="flex min-w-0 grow flex-col gap-4">
          <Section
            id="availability"
            icon={CalendarClock}
            title={t("editor.availability", "Availability")}
            description={t(
              "editor.availabilityHint",
              "When the agent is active and answering. Outside these hours it stays silent, notifies the operator with a private note, and, if you turn it on below, tells the customer too.",
            )}
          >
            <FormField
              label={t("editor.businessHours", "Business hours")}
              group
            >
              <SchedulePicker
                value={businessHoursId}
                onChange={setBusinessHoursId}
                schedules={hours.map(toScheduleOption)}
                emptyLabel={t("editor.always", "Always on")}
                aria-label={t("editor.businessHours", "Business hours")}
                onScheduleSaved={(savedId) => {
                  onScheduleSaved(savedId, setBusinessHoursId);
                }}
              />
            </FormField>
            <SwitchField
              checked={awayEnabled}
              onCheckedChange={setAwayEnabled}
              label={t(
                "editor.awayEnabled",
                "Reply to the customer while closed",
              )}
            />
            {awayEnabled && (
              <FormField
                label={t("editor.awayMessage", "Out-of-hours message")}
                description={t(
                  "editor.awayMessageHint",
                  'Sent to the customer while the agent is outside these hours, at most once a day per conversation. Write {next_open} (or {proximo_atendimento} for a Portuguese message) where the next opening should appear: the customer reads something like "Monday, 08/25, 09:00".',
                )}
              >
                <Textarea
                  value={awayMessage}
                  onChange={(e) => setAwayMessage(e.target.value)}
                  rows={2}
                  maxLength={TEMPLATE_MESSAGE_MAX}
                  placeholder={t(
                    "editor.awayMessagePlaceholder",
                    "We are closed right now. We will be back {next_open}.",
                  )}
                />
              </FormField>
            )}
          </Section>

          <Section
            id="debounce"
            icon={Layers}
            title={t("editor.debounce", "Message grouping (debounce)")}
            description={t(
              "editor.debounceHint",
              "Wait for the customer to stop typing, then answer their whole burst in one reply.",
            )}
          >
            <SwitchField
              checked={debounce.enabled}
              onCheckedChange={(v) => setDebounce({ ...debounce, enabled: v })}
              label={t(
                "editor.debounceEnabled",
                "Group rapid messages before replying",
              )}
            />
            {debounce.enabled && (
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField
                  label={t("editor.debounceWindow", "Wait window (s)")}
                  description={t(
                    "editor.debounceWindowHint",
                    "Idle time after the last message before replying (3-120).",
                  )}
                >
                  <Input
                    type="number"
                    min={3}
                    max={120}
                    value={debounce.windowSeconds}
                    onChange={(e) =>
                      setDebounce({
                        ...debounce,
                        windowSeconds: e.target.value,
                      })
                    }
                  />
                </FormField>
                <FormField
                  label={t(
                    "editor.debounceMaxMessages",
                    "Max messages / reply",
                  )}
                  description={t(
                    "editor.debounceMaxMessagesHint",
                    "Cap on messages grouped into one turn (1-50).",
                  )}
                >
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    value={debounce.maxMessagesPerBurst}
                    onChange={(e) =>
                      setDebounce({
                        ...debounce,
                        maxMessagesPerBurst: e.target.value,
                      })
                    }
                  />
                </FormField>
                <FormField
                  label={t("editor.debounceMaxWindow", "Max total wait (s)")}
                  description={t(
                    "editor.debounceMaxWindowHint",
                    "Reply at most this long after the first message, even if more keep arriving.",
                  )}
                >
                  <Input
                    type="number"
                    min={3}
                    max={600}
                    value={debounce.maxWindowSeconds}
                    onChange={(e) =>
                      setDebounce({
                        ...debounce,
                        maxWindowSeconds: e.target.value,
                      })
                    }
                  />
                </FormField>
              </div>
            )}
          </Section>

          <Section
            id="stt"
            icon={Mic}
            title={t("editor.stt", "Voice transcription (audio)")}
            description={t(
              "editor.sttHint",
              "Transcribe customer voice notes so the agent can read and answer them.",
            )}
          >
            <SwitchField
              checked={stt.enabled}
              onCheckedChange={(v) => setStt({ ...stt, enabled: v })}
              label={t("editor.sttEnabled", "Transcribe voice notes")}
            />
            {stt.enabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label={t("editor.sttProvider", "Provider")}>
                    <Select
                      value={stt.provider}
                      onChange={(e) =>
                        setStt({ ...stt, provider: e.target.value })
                      }
                    >
                      {STT_PROVIDERS.map((p) => (
                        <option key={p} value={p}>
                          {providerLabel(p, t)}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField label={t("editor.sttCredential", "API key")} group>
                    <CredentialPicker
                      value={stt.credentialRef}
                      onChange={(v) => setStt({ ...stt, credentialRef: v })}
                      required={stt.provider !== "openai-compatible"}
                      compatibleTypes={credentialCompat.stt(stt.provider)}
                      defaultCreateType={credentialCompat.stt(stt.provider)[0]}
                      ariaLabel={t("editor.sttCredential", "API key")}
                    />
                  </FormField>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label={t("editor.sttModel", "Model")}
                    group
                    description={t(
                      "editor.sttModelHint",
                      "Leave blank for the provider default.",
                    )}
                  >
                    <ModelPicker
                      value={stt.model}
                      onChange={(v) => setStt({ ...stt, model: v })}
                      provider={stt.provider}
                      capability="transcription"
                      credentialRef={stt.credentialRef || undefined}
                      baseURL={sttCredBaseUrl ?? (stt.baseURL || undefined)}
                      placeholder={STT_DEFAULT_MODEL[stt.provider] ?? ""}
                      aria-label={t("editor.sttModel", "Model")}
                    />
                  </FormField>
                  <FormField label={t("editor.sttLanguage", "Language")} group>
                    <div className="flex flex-col gap-2">
                      <Select
                        value={sttLangKnown ? stt.language : "other"}
                        onChange={(e) =>
                          setStt({
                            ...stt,
                            language:
                              e.target.value === "other" ? "" : e.target.value,
                          })
                        }
                      >
                        {STT_LANGUAGES.map((l) => (
                          <option key={l} value={l}>
                            {langLabel(l)}
                          </option>
                        ))}
                        <option value="other">
                          {t("editor.sttLanguageOther", "Other (custom code)")}
                        </option>
                      </Select>
                      {!sttLangKnown && (
                        <Input
                          value={stt.language}
                          onChange={(e) =>
                            setStt({ ...stt, language: e.target.value })
                          }
                          placeholder="pt-BR"
                          aria-label={t(
                            "editor.sttLanguageCustom",
                            "Custom language code",
                          )}
                        />
                      )}
                    </div>
                  </FormField>
                </div>
                {stt.provider === "openai-compatible" && (
                  <FormField
                    label={t("editor.sttBaseURL", "Base URL")}
                    description={
                      sttCredBaseUrl
                        ? t(
                            "editor.baseURLFromCredential",
                            "Defined by the selected credential.",
                          )
                        : t(
                            "editor.sttBaseURLHint",
                            "Required for OpenAI-compatible transcription endpoints.",
                          )
                    }
                    error={
                      sttBaseUrlInvalid && stt.baseURL.trim()
                        ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                        : null
                    }
                  >
                    <Input
                      value={sttCredBaseUrl ?? stt.baseURL}
                      onChange={(e) =>
                        setStt({ ...stt, baseURL: e.target.value })
                      }
                      disabled={!!sttCredBaseUrl}
                      placeholder="https://api.groq.com/openai/v1"
                    />
                  </FormField>
                )}
              </>
            )}
          </Section>

          <Section
            id="vision"
            icon={Image}
            title={t("editor.vision", "Image & document reading")}
            description={t(
              "editor.visionHint",
              "Extract the content of images and PDFs the customer sends so the agent can read them.",
            )}
          >
            <SwitchField
              checked={vision.enabled}
              onCheckedChange={(v) => setVision({ ...vision, enabled: v })}
              label={t("editor.visionEnabled", "Read images and documents")}
            />
            {vision.enabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label={t("editor.visionProvider", "Provider")}
                    // Said here, and not only in the docs, because the alternative way to learn it
                    // is a PDF that comes back unextracted mid-attendance (issue #324).
                    hint={
                      visionAcceptsDocuments(
                        vision.provider,
                        visionCredBaseUrl ?? vision.baseURL,
                      )
                        ? undefined
                        : t(
                            "editor.visionImageOnly",
                            "PDF attachments are skipped with this setup; only images are read.",
                          )
                    }
                  >
                    <Select
                      value={vision.provider}
                      onChange={(e) =>
                        setVision({ ...vision, provider: e.target.value })
                      }
                    >
                      {VISION_PROVIDERS.map((p) => (
                        <option key={p} value={p}>
                          {providerLabel(p, t)}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField
                    label={t("editor.visionCredential", "API key")}
                    group
                  >
                    <CredentialPicker
                      value={vision.credentialRef}
                      onChange={(v) =>
                        setVision({ ...vision, credentialRef: v })
                      }
                      required={vision.provider !== "openai-compatible"}
                      compatibleTypes={credentialCompat.vision(vision.provider)}
                      defaultCreateType={
                        credentialCompat.vision(vision.provider)[0]
                      }
                      ariaLabel={t("editor.visionCredential", "API key")}
                    />
                  </FormField>
                </div>
                <FormField
                  label={t("editor.visionModel", "Model")}
                  group
                  // The per-provider sentence used to live here, as a static list naming which
                  // providers read PDFs. It went stale the moment one of them changed (issue #324),
                  // and it was in the wrong field anyway: what a provider reads is a property of the
                  // provider, so it is said above, next to the provider.
                  description={t(
                    "editor.visionModelHint",
                    "Leave blank for the provider default.",
                  )}
                >
                  <ModelPicker
                    value={vision.model}
                    onChange={(v) => setVision({ ...vision, model: v })}
                    provider={vision.provider}
                    capability="vision"
                    credentialRef={vision.credentialRef || undefined}
                    baseURL={visionCredBaseUrl ?? (vision.baseURL || undefined)}
                    placeholder={VISION_DEFAULT_MODEL[vision.provider] ?? ""}
                    aria-label={t("editor.visionModel", "Model")}
                  />
                </FormField>
                {vision.provider === "openai-compatible" && (
                  <FormField
                    label={t("editor.visionBaseURL", "Base URL")}
                    description={
                      visionCredBaseUrl
                        ? t(
                            "editor.baseURLFromCredential",
                            "Defined by the selected credential.",
                          )
                        : t(
                            "editor.visionBaseURLHint",
                            "Required for OpenAI-compatible vision endpoints (e.g. a self-hosted Qwen-VL).",
                          )
                    }
                    error={
                      visionBaseUrlInvalid && vision.baseURL.trim()
                        ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                        : null
                    }
                  >
                    <Input
                      value={visionCredBaseUrl ?? vision.baseURL}
                      onChange={(e) =>
                        setVision({ ...vision, baseURL: e.target.value })
                      }
                      disabled={!!visionCredBaseUrl}
                      placeholder="https://your-qwen-endpoint/v1"
                    />
                  </FormField>
                )}
                <FormField
                  label={
                    <span className="flex items-center justify-between gap-2">
                      <span>
                        {t("editor.visionPrompt", "Extraction prompt")}
                      </span>
                      {vision.extractionPrompt.trim() !==
                        DEFAULT_EXTRACTION_PROMPT && (
                        <button
                          type="button"
                          className="font-normal text-accent text-xs hover:underline"
                          onClick={() =>
                            setVision({
                              ...vision,
                              extractionPrompt: DEFAULT_EXTRACTION_PROMPT,
                            })
                          }
                        >
                          {t("editor.visionPromptReset", "Restore default")}
                        </button>
                      )}
                    </span>
                  }
                  description={t(
                    "editor.visionPromptHint",
                    "How the model should read the file.",
                  )}
                >
                  <Textarea
                    value={vision.extractionPrompt}
                    onChange={(e) =>
                      setVision({ ...vision, extractionPrompt: e.target.value })
                    }
                    rows={3}
                    maxLength={EXTRACTION_PROMPT_MAX}
                    placeholder={DEFAULT_EXTRACTION_PROMPT}
                  />
                </FormField>
              </>
            )}
          </Section>

          <Section
            id="tts"
            icon={Volume2}
            title={t("editor.tts", "Audio replies (text-to-speech)")}
            description={t(
              "editor.ttsHint",
              "Optionally answer with a voice note.",
            )}
          >
            <FormField label={t("editor.ttsMode", "When to reply with audio")}>
              <Select
                value={tts.mode}
                onChange={(e) => setTts({ ...tts, mode: e.target.value })}
              >
                <option value="never">
                  {t("editor.ttsModeNever", "Never (text only)")}
                </option>
                <option value="mirror">
                  {t("editor.ttsModeMirror", "When the customer sends audio")}
                </option>
                <option value="preference">
                  {t(
                    "editor.ttsModePreference",
                    "Follow the customer's preference",
                  )}
                </option>
              </Select>
            </FormField>
            {tts.mode !== "never" && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label={t("editor.ttsProvider", "Provider")}>
                    <Select
                      value={tts.provider}
                      onChange={(e) =>
                        setTts({ ...tts, provider: e.target.value })
                      }
                    >
                      {TTS_PROVIDERS.map((p) => (
                        <option key={p} value={p}>
                          {providerLabel(p, t)}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField label={t("editor.ttsCredential", "API key")} group>
                    <CredentialPicker
                      value={tts.credentialRef}
                      onChange={(v) => setTts({ ...tts, credentialRef: v })}
                      required
                      compatibleTypes={credentialCompat.tts(tts.provider)}
                      defaultCreateType={credentialCompat.tts(tts.provider)[0]}
                      ariaLabel={t("editor.ttsCredential", "API key")}
                    />
                  </FormField>
                </div>
                {tts.provider === "openrouter" && (
                  <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                      aria-hidden="true"
                    />
                    <span>
                      {t(
                        "editor.ttsOpenRouterFileWarning",
                        "OpenRouter doesn't output Ogg/Opus, so replies arrive as a regular audio file attachment, not a native WhatsApp voice note (PTT).",
                      )}
                    </span>
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label={t("editor.ttsVoice", "Voice")}
                    description={t(
                      "editor.ttsVoiceHint",
                      "Voice id/name (required for ElevenLabs).",
                    )}
                  >
                    <TtsOptionPicker
                      kind="voices"
                      provider={tts.provider}
                      credentialRef={tts.credentialRef}
                      value={tts.voice}
                      onChange={(v) => setTts({ ...tts, voice: v })}
                      placeholder={
                        TTS_DEFAULT_VOICE[tts.provider] ||
                        t("editor.ttsVoiceRequired", "required")
                      }
                      ariaLabel={t("editor.ttsVoice", "Voice")}
                    />
                  </FormField>
                  <FormField
                    label={t("editor.ttsModel", "Model")}
                    description={t(
                      "editor.ttsModelHint",
                      "Leave blank for the provider default.",
                    )}
                  >
                    <TtsOptionPicker
                      kind="models"
                      provider={tts.provider}
                      credentialRef={tts.credentialRef}
                      value={tts.model}
                      onChange={(v) => setTts({ ...tts, model: v })}
                      placeholder={TTS_DEFAULT_MODEL[tts.provider] ?? ""}
                      ariaLabel={t("editor.ttsModel", "Model")}
                    />
                  </FormField>
                </div>
                <div className="flex flex-col gap-1.5">
                  <SwitchField
                    checked={tts.normalize}
                    onCheckedChange={(v) => setTts({ ...tts, normalize: v })}
                    label={t(
                      "editor.ttsNormalize",
                      "Rewrite the reply to be spoken, not read",
                    )}
                  />
                  <p className="text-text-muted text-xs">
                    {t(
                      "editor.ttsNormalizeHint",
                      "One extra model call per audio reply: numbers, dates and amounts come out in words, and a list of options becomes a sentence a person would say out loud. It appears on the Logs as its own step and on the dashboard as its own usage.",
                    )}
                  </p>
                </div>
                {tts.normalize && (
                  <div className="flex flex-col gap-3">
                    <div>
                      <p className="font-medium text-sm">
                        {t("editor.ttsNormalizeModel", "Rewrite model")}
                      </p>
                      <p className="text-text-muted text-xs">
                        {t(
                          "editor.ttsNormalizeModelHint",
                          "Leave it on the agent's model to change nothing. Rewriting an answer that already exists is a simpler job than writing it, so a cheaper model usually does it just as well, on every audio reply.",
                        )}
                      </p>
                    </div>
                    <FormField label={t("editor.provider", "Provider")}>
                      <Select
                        value={tts.normalizeProvider}
                        onChange={(e) =>
                          setTts((prev) =>
                            ttsNormalizerProviderChanged(prev, e.target.value),
                          )
                        }
                      >
                        <option value="">
                          {t(
                            "editor.ttsNormalizeSameAsAgent",
                            "Same as the agent",
                          )}
                        </option>
                        {MODEL_PROVIDERS.map((p) => (
                          <option key={p} value={p}>
                            {providerLabel(p, t)}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <FormField
                      label={t("editor.credential", "API key")}
                      description={t(
                        "editor.ttsNormalizeCredentialHint",
                        "Required when the provider differs from the agent's: the agent's key is never sent to another vendor, so without a key of its own the rewrite is skipped and the audio goes out unrewritten.",
                      )}
                      group
                    >
                      <CredentialPicker
                        value={tts.normalizeCredentialRef}
                        onChange={(v) =>
                          setTts(
                            ttsNormalizerOverridePicked(
                              tts,
                              "normalizeCredentialRef",
                              v,
                              agentModelProvider,
                            ),
                          )
                        }
                        required={ttsNormalizerNeedsOwnCredential(
                          tts,
                          agentModel,
                          ttsNormalizeCredBaseUrl,
                        )}
                        compatibleTypes={credentialCompat.model(
                          normalizeEffectiveProvider,
                        )}
                        defaultCreateType={
                          credentialCompat.model(normalizeEffectiveProvider)[0]
                        }
                        ariaLabel={t("editor.credential", "API key")}
                      />
                    </FormField>
                    <FormField label={t("editor.model", "Model")} group>
                      <ModelPicker
                        value={tts.normalizeModel}
                        onChange={(v) =>
                          setTts(
                            ttsNormalizerOverridePicked(
                              tts,
                              "normalizeModel",
                              v,
                              agentModelProvider,
                            ),
                          )
                        }
                        provider={normalizeEffectiveProvider}
                        // The picker lists models by CALLING the provider, so it has to use the
                        // credential the rewrite will actually run on: the agent's own, while
                        // the provider is unchanged and no dedicated key was picked.
                        credentialRef={
                          normalizeSource.credentialRef || undefined
                        }
                        baseURL={normalizeSource.baseURL || undefined}
                        // NOTE: blank inherits the AGENT's model while the provider is unchanged,
                        // and only falls back to the provider default once it differs (see
                        // resolveNormalizeModel). The placeholder has to say the same thing, or
                        // the operator reads one model here and another one runs.
                        placeholder={
                          normalizeEffectiveProvider === agentModelProvider
                            ? agentModelName ||
                              (PROVIDER_DEFAULT_MODEL[
                                normalizeEffectiveProvider
                              ] ??
                                "")
                            : (PROVIDER_DEFAULT_MODEL[
                                normalizeEffectiveProvider
                              ] ?? "")
                        }
                        aria-label={t("editor.model", "Model")}
                      />
                    </FormField>
                    {(normalizeEffectiveProvider === "openai-compatible" ||
                      !!ttsNormalizeCredBaseUrl ||
                      !!tts.normalizeBaseURL.trim()) && (
                      <FormField
                        label={t("editor.baseURL", "Base URL")}
                        description={
                          ttsNormalizeCredBaseUrl
                            ? t(
                                "editor.baseURLFromCredential",
                                "Defined by the selected credential.",
                              )
                            : t(
                                "editor.ttsNormalizeBaseURLHint",
                                "Required for OpenAI-compatible endpoints, unless the credential already carries one.",
                              )
                        }
                        error={
                          normalizeBaseUrlUnsupported
                            ? t(
                                "editor.baseURLNotSentByProvider",
                                "This provider does not send a base URL: the request would go to its own endpoint instead. Pick a credential without one, or use an OpenAI-compatible provider.",
                              )
                            : normalizeBaseUrlInvalid &&
                                tts.normalizeBaseURL.trim()
                              ? t(
                                  "common.invalidUrl",
                                  "Must be a valid http(s) URL.",
                                )
                              : null
                        }
                      >
                        <Input
                          value={
                            ttsNormalizeCredBaseUrl ?? tts.normalizeBaseURL
                          }
                          onChange={(e) =>
                            setTts({
                              ...tts,
                              normalizeBaseURL: e.target.value,
                            })
                          }
                          disabled={!!ttsNormalizeCredBaseUrl}
                          placeholder="https://api.groq.com/openai/v1"
                        />
                      </FormField>
                    )}
                  </div>
                )}
                {tts.provider === "elevenlabs" && (
                  <div className="flex flex-col gap-3">
                    <div>
                      <p className="font-medium text-sm">
                        {t("editor.ttsDelivery", "Voice delivery")}
                      </p>
                      <p className="text-text-muted text-xs">
                        {t(
                          "editor.ttsDeliveryHint",
                          "Leave a field blank to use the voice's own saved setting. Lower stability makes the delivery more expressive; high stability sounds monotone.",
                        )}
                      </p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormField
                        label={t("editor.ttsStability", "Stability")}
                        description={t(
                          "editor.ttsStabilityHint",
                          "0 = expressive, 1 = monotone (0-1).",
                        )}
                      >
                        <Input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={tts.stability}
                          onChange={(e) =>
                            setTts({ ...tts, stability: e.target.value })
                          }
                        />
                      </FormField>
                      <FormField
                        label={t("editor.ttsSimilarity", "Similarity")}
                        description={t(
                          "editor.ttsSimilarityHint",
                          "How closely to match the original voice (0-1).",
                        )}
                      >
                        <Input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={tts.similarityBoost}
                          onChange={(e) =>
                            setTts({ ...tts, similarityBoost: e.target.value })
                          }
                        />
                      </FormField>
                      <FormField
                        label={t("editor.ttsStyle", "Style")}
                        description={t(
                          "editor.ttsStyleHint",
                          "Extra emphasis. Costs latency and can destabilize (0-1).",
                        )}
                      >
                        <Input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={tts.style}
                          onChange={(e) =>
                            setTts({ ...tts, style: e.target.value })
                          }
                        />
                      </FormField>
                      <FormField
                        label={t("editor.ttsSpeed", "Speed")}
                        description={t(
                          "editor.ttsSpeedHint",
                          "Speaking rate, 1 being natural speed (0.25-4).",
                        )}
                      >
                        <Input
                          type="number"
                          min={0.25}
                          max={4}
                          step={0.05}
                          value={tts.speed}
                          onChange={(e) =>
                            setTts({ ...tts, speed: e.target.value })
                          }
                        />
                      </FormField>
                      <FormField
                        label={t("editor.ttsSpeakerBoost", "Speaker boost")}
                        description={t(
                          "editor.ttsSpeakerBoostHint",
                          "The provider enables it by default; pick a value only to override that.",
                        )}
                      >
                        {/* NOTE: a Select, not a Switch: this knob has THREE states, and a switch
                            would render the untouched "leave it to the voice" as visibly off while
                            the provider actually turns it on. */}
                        <Select
                          value={
                            tts.speakerBoost === null
                              ? ""
                              : String(tts.speakerBoost)
                          }
                          onChange={(e) =>
                            setTts({
                              ...tts,
                              speakerBoost:
                                e.target.value === ""
                                  ? null
                                  : e.target.value === "true",
                            })
                          }
                        >
                          <option value="">
                            {t("editor.ttsVoiceDefault", "Voice default")}
                          </option>
                          <option value="true">
                            {t("common.enabled", "Enabled")}
                          </option>
                          <option value="false">
                            {t("common.disabled", "Disabled")}
                          </option>
                        </Select>
                      </FormField>
                    </div>
                  </div>
                )}
              </>
            )}
          </Section>

          <Section
            id="split"
            icon={Scissors}
            title={t("editor.split", "Reply in multiple messages")}
            description={t(
              "editor.splitHint",
              "Break long replies into smaller messages, with a typing pause between them (feels more human).",
            )}
          >
            <SwitchField
              checked={split.enabled}
              onCheckedChange={(v) => setSplit({ ...split, enabled: v })}
              label={t(
                "editor.splitEnabled",
                "Split replies into several messages with a typing delay",
              )}
            />
            {split.enabled && (
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField
                  label={t("editor.splitMaxChars", "Max chars / message")}
                  description={t(
                    "editor.splitMaxCharsHint",
                    "Longer paragraphs are split further.",
                  )}
                >
                  <Input
                    type="number"
                    min={80}
                    max={4000}
                    value={split.maxChars}
                    onChange={(e) =>
                      setSplit({ ...split, maxChars: e.target.value })
                    }
                  />
                </FormField>
                <FormField
                  label={t("editor.splitWpm", "Typing speed (wpm)")}
                  description={t(
                    "editor.splitWpmHint",
                    "Higher = shorter pauses.",
                  )}
                >
                  <Input
                    type="number"
                    min={40}
                    max={1000}
                    value={split.typingWpm}
                    onChange={(e) =>
                      setSplit({ ...split, typingWpm: e.target.value })
                    }
                  />
                </FormField>
                <FormField
                  label={t("editor.splitMaxDelay", "Max pause (ms)")}
                  description={t(
                    "editor.splitMaxDelayHint",
                    "Cap on the typing pause per message.",
                  )}
                >
                  <Input
                    type="number"
                    min={0}
                    max={30000}
                    step={500}
                    value={split.maxDelayMs}
                    onChange={(e) =>
                      setSplit({ ...split, maxDelayMs: e.target.value })
                    }
                  />
                </FormField>
              </div>
            )}
          </Section>

          <Section
            id="attributeContext"
            icon={ListChecks}
            title={t("editor.attributeContext", "Data in context")}
            description={t(
              "editor.attributeContextHint",
              'Chatwoot custom attributes whose CURRENT values the agent sees on every turn, so it knows what has already been collected and what is still missing. Pick only what matters to the conversation — everything selected goes into the prompt. The agent only writes them back when it has the "Set attribute" tool; without it they are read-only context.',
            )}
          >
            <AttributeContextPickers
              agentId={agentId}
              attributeContext={attributeContext}
              setAttributeContext={setAttributeContext}
            />
          </Section>

          <Section
            id="sendImage"
            icon={ImagePlus}
            title={t("editor.sendImage", "Sending images")}
            description={t(
              "editor.sendImageHint",
              'Hosts the agent may fetch an image from when it uses the "Send image" tool. The agent chooses the URL, so this list is what decides where it can actually go: leave it empty and every attempt is refused. Output guardrails read text and never the picture itself, so this list is the only control over what an image may show. It has no effect unless the tool is granted on the Tools tab.',
            )}
          >
            <FormField
              label={t("editor.sendImageHosts", "Allowed hosts")}
              description={t(
                "editor.sendImageHostsHint",
                'One per line, e.g. cdn.minhaloja.com.br. Start with "*." to cover a domain and its subdomains (*.minhaloja.com.br). Paste a full URL and only its host is kept.',
              )}
            >
              <Textarea
                value={sendImage.allowedHosts}
                onChange={(e) => setSendImage({ allowedHosts: e.target.value })}
                rows={4}
                placeholder="cdn.minhaloja.com.br"
              />
            </FormField>
          </Section>

          <Section
            id="contactAuth"
            icon={ShieldCheck}
            title={t("editor.contactAuth", "Contact authorization")}
            description={t(
              "editor.contactAuthHint",
              "Before answering, ask an external system whether this contact may be served, by the identity Chatwoot holds for them (phone, email, identifier). Every message is re-checked, so revoking on your side takes effect immediately. While the check denies or cannot answer, the agent stays silent to the customer and the operator gets a private note. It does not run in the playground.",
            )}
          >
            <SwitchField
              checked={contactAuth.enabled}
              onCheckedChange={(v) =>
                setContactAuth({ ...contactAuth, enabled: v })
              }
              label={t(
                "editor.contactAuthEnabled",
                "Only answer contacts the external check authorizes",
              )}
            />
            {contactAuth.enabled && (
              <>
                <FormField
                  label={t("editor.contactAuthUrl", "Authorization URL")}
                  description={t(
                    "editor.contactAuthUrlHint",
                    'Receives a POST with the identity in a JSON body (contact, conversation, message) and answers { "authorized": true | false }.',
                  )}
                  error={
                    contactAuthUrlInvalid
                      ? t(
                          "editor.contactAuthUrlInvalid",
                          "Required: a valid http(s) URL, with any credential in the vault rather than in the URL.",
                        )
                      : null
                  }
                >
                  <Input
                    value={contactAuth.url}
                    onChange={(e) =>
                      setContactAuth({ ...contactAuth, url: e.target.value })
                    }
                    placeholder="https://api.example.com/contacts/authorize"
                  />
                </FormField>
                <FormField
                  label={t("editor.contactAuthCredential", "Credential")}
                  group
                  description={t(
                    "editor.contactAuthCredentialHint",
                    "Optional. Sent the way the credential's type declares (Bearer, header or query parameter).",
                  )}
                >
                  <CredentialPicker
                    value={contactAuth.credentialRef}
                    onChange={(v) =>
                      setContactAuth({ ...contactAuth, credentialRef: v })
                    }
                    compatibleTypes={[
                      "bearer_token",
                      "header",
                      "query",
                      "basic_auth",
                    ]}
                    defaultCreateType="bearer_token"
                    ariaLabel={t("editor.contactAuthCredential", "Credential")}
                  />
                </FormField>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label={t("editor.contactAuthTimeout", "Timeout (ms)")}
                    description={t(
                      "editor.contactAuthTimeoutHint",
                      "1,000-10,000. Past it the check counts as failed and the agent stays silent.",
                    )}
                  >
                    <Input
                      type="number"
                      min={1000}
                      max={10000}
                      value={contactAuth.timeoutMs}
                      onChange={(e) =>
                        setContactAuth({
                          ...contactAuth,
                          timeoutMs: e.target.value,
                        })
                      }
                    />
                  </FormField>
                  <FormField
                    label={t(
                      "editor.contactAuthNoticeCooldown",
                      "Notice cooldown (s)",
                    )}
                    description={t(
                      "editor.contactAuthNoticeCooldownHint",
                      "Every message is re-checked; this only spaces the deny message and the private note for the same conversation. 0-3,600; 0 notifies on every refused message.",
                    )}
                  >
                    <Input
                      type="number"
                      min={0}
                      max={3600}
                      value={contactAuth.noticeCooldownSeconds}
                      onChange={(e) =>
                        setContactAuth({
                          ...contactAuth,
                          noticeCooldownSeconds: e.target.value,
                        })
                      }
                    />
                  </FormField>
                </div>
                <div className="flex flex-col gap-1.5">
                  <SwitchField
                    checked={contactAuth.includeMessageText}
                    onCheckedChange={(v) =>
                      setContactAuth({ ...contactAuth, includeMessageText: v })
                    }
                    label={t(
                      "editor.contactAuthIncludeText",
                      "Send the customer's message text",
                    )}
                  />
                  <p className="text-text-muted text-xs">
                    {t(
                      "editor.contactAuthIncludeTextHint",
                      "The triggering message travels as its own message.text field, apart from the mirrored identity, so your endpoint can accept an unlock code the customer sends. It is never logged.",
                    )}
                  </p>
                </div>
                <FormField
                  label={t(
                    "editor.contactAuthDenyMessage",
                    "Message to a denied contact",
                  )}
                  description={t(
                    "editor.contactAuthDenyMessageHint",
                    "Sent when the check denies the contact, at most once per notice cooldown. Leave empty to send nothing.",
                  )}
                >
                  <Textarea
                    value={contactAuth.denyMessage}
                    onChange={(e) =>
                      setContactAuth({
                        ...contactAuth,
                        denyMessage: e.target.value,
                      })
                    }
                    rows={2}
                    maxLength={TEMPLATE_MESSAGE_MAX}
                    placeholder={t(
                      "editor.contactAuthDenyMessagePlaceholder",
                      "This channel serves registered customers only.",
                    )}
                  />
                </FormField>
                <SwitchField
                  checked={contactAuth.handoffEnabled}
                  onCheckedChange={(v) =>
                    setContactAuth({ ...contactAuth, handoffEnabled: v })
                  }
                  label={t(
                    "editor.contactAuthHandoff",
                    "Open refused conversations for humans",
                  )}
                />
                {contactAuth.handoffEnabled && (
                  <ContactAuthTeamSelect
                    agentId={agentId}
                    value={contactAuth.handoffTeamId}
                    onChange={(v, instanceId) =>
                      setContactAuth({
                        ...contactAuth,
                        handoffTeamId: v,
                        // Cleared with the team: a recorded account with no team pins nothing, and
                        // a stale one would outlive the choice it belonged to.
                        handoffTeamInstanceId: v ? instanceId : "",
                      })
                    }
                  />
                )}
              </>
            )}
          </Section>

          <Section
            id="limits"
            icon={Gauge}
            title={t("editor.limits", "Execution limits")}
            description={t(
              "editor.limitsHint",
              "Cap how much work the agent does in a single turn before it must answer.",
            )}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t("editor.limitsMaxToolCalls", "Max tool calls / turn")}
                description={t(
                  "editor.limitsMaxToolCallsHint",
                  "After this many tool uses the agent is forced to reply with what it has (no error). 1-50.",
                )}
              >
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={limits.maxToolCalls}
                  onChange={(e) =>
                    setLimits({ ...limits, maxToolCalls: e.target.value })
                  }
                />
              </FormField>
              <FormField
                label={t("editor.limitsMaxHistoryTokens", "History ceiling")}
                description={t(
                  "editor.limitsMaxHistoryTokensHint",
                  "The agent remembers every conversation it has had with this contact on this channel, and sends all of it on every turn, so a returning customer gets slower and more expensive the more they talk. This caps how much of that memory travels: older attendances stop being sent once the cap is reached, and the conversation being answered is never dropped. The count is an estimate and runs low on tool-heavy threads, and the instructions and tool definitions are not counted at all, so set it below the budget you actually have. Empty = no ceiling. 2,000-1,000,000.",
                )}
              >
                <Input
                  type="number"
                  min={2000}
                  max={1000000}
                  placeholder={t("editor.limitsNoCeiling", "No ceiling")}
                  value={limits.maxHistoryTokens}
                  onChange={(e) =>
                    setLimits({ ...limits, maxHistoryTokens: e.target.value })
                  }
                />
              </FormField>
            </div>
          </Section>

          <Section
            id="memory"
            icon={Brain}
            title={t("editor.memory", "Memory")}
            description={t(
              "editor.memoryHint",
              'The agent remembers every conversation it has had with this contact on this channel. When an attendance ends, its messages are replaced by a summary of it, so the memory becomes "N summarized attendances + the current one". What survives a summary is the useful part: who the contact is, what was agreed, what was left open. Exact wording does not, so turn this off if the agent must be able to quote an old conversation word for word. The summary is written by the agent\'s own model, after the reply is sent, so no customer waits for it. It runs once for every attendance that ends, including the ones your team handled without the agent.',
            )}
          >
            <SwitchField
              checked={memory.compactionEnabled}
              onCheckedChange={(v) =>
                setMemory((prev) => ({ ...prev, compactionEnabled: v }))
              }
              label={t(
                "editor.memoryCompaction",
                "Summarize attendances that have ended",
              )}
            />
            {memory.compactionEnabled && (
              <div className="flex flex-col gap-3">
                <div>
                  <p className="font-medium text-sm">
                    {t("editor.memoryModel", "Summary model")}
                  </p>
                  <p className="text-text-muted text-xs">
                    {t(
                      "editor.memoryModelHint",
                      "Leave it on the agent's model to change nothing. This is the one place where a cheaper model is usually the wrong trade: the summary is not read once, it becomes what the agent knows about this contact from then on, it is never rewritten, and a weaker model tends to drop the customer's name while writing more. Measured on one vendor's cheapest model: the name was lost on one attendance in five. Change it only with a model you have compared yourself.",
                    )}
                  </p>
                </div>
                <FormField label={t("editor.provider", "Provider")}>
                  <Select
                    value={memory.provider}
                    onChange={(e) =>
                      setMemory((prev) => ({
                        ...prev,
                        ...overrideProviderChanged(
                          {
                            provider: prev.provider,
                            model: prev.model,
                            credentialRef: prev.credentialRef,
                            baseURL: prev.baseURL,
                          },
                          e.target.value,
                        ),
                      }))
                    }
                  >
                    <option value="">
                      {t("editor.memorySameAsAgent", "Same as the agent")}
                    </option>
                    {MODEL_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {providerLabel(p, t)}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label={t("editor.credential", "API key")}
                  description={t(
                    "editor.memoryCredentialHint",
                    "Required when the provider differs from the agent's: the agent's key is never sent to another vendor, so without a key of its own the summary is not written and the attendance stays in the thread raw.",
                  )}
                  group
                >
                  <CredentialPicker
                    value={memory.credentialRef}
                    onChange={(v) =>
                      setMemory((prev) => ({
                        ...prev,
                        ...overridePicked(
                          {
                            provider: prev.provider,
                            model: prev.model,
                            credentialRef: prev.credentialRef,
                            baseURL: prev.baseURL,
                          },
                          "credentialRef",
                          v,
                          agentModelProvider,
                        ),
                      }))
                    }
                    required={memoryNeedsOwnCredential}
                    compatibleTypes={credentialCompat.model(
                      memoryEffectiveProvider,
                    )}
                    defaultCreateType={
                      credentialCompat.model(memoryEffectiveProvider)[0]
                    }
                    ariaLabel={t("editor.credential", "API key")}
                  />
                </FormField>
                <FormField label={t("editor.model", "Model")} group>
                  <ModelPicker
                    value={memory.model}
                    onChange={(v) =>
                      setMemory((prev) => ({
                        ...prev,
                        ...overridePicked(
                          {
                            provider: prev.provider,
                            model: prev.model,
                            credentialRef: prev.credentialRef,
                            baseURL: prev.baseURL,
                          },
                          "model",
                          v,
                          agentModelProvider,
                        ),
                      }))
                    }
                    provider={memoryEffectiveProvider}
                    credentialRef={memorySource.credentialRef || undefined}
                    baseURL={memorySource.baseURL || undefined}
                    // NOTE: blank inherits the AGENT's model while the provider is unchanged, and
                    // only falls back to the provider default once it differs. The placeholder has
                    // to say the same thing, or the operator reads one model here and another runs.
                    placeholder={
                      memoryEffectiveProvider === agentModelProvider
                        ? t("editor.memorySameAsAgent", "Same as the agent")
                        : undefined
                    }
                  />
                </FormField>
                {(memoryEffectiveProvider === "openai-compatible" ||
                  !!memoryCredBaseUrl ||
                  !!memory.baseURL.trim()) && (
                  <FormField
                    label={t("editor.baseURL", "Base URL")}
                    description={
                      memoryCredBaseUrl
                        ? t(
                            "editor.baseURLFromCredential",
                            "Defined by the selected credential.",
                          )
                        : t(
                            "editor.memoryBaseURLHint",
                            "Required for OpenAI-compatible endpoints, unless the credential already carries one.",
                          )
                    }
                    error={
                      memoryBaseUrlUnsupported
                        ? t(
                            "editor.baseURLNotSentByProvider",
                            "This provider does not send a base URL: the request would go to its own endpoint instead. Pick a credential without one, or use an OpenAI-compatible provider.",
                          )
                        : memoryBaseUrlInvalid && memory.baseURL.trim()
                          ? t(
                              "common.invalidUrl",
                              "Must be a valid http(s) URL.",
                            )
                          : null
                    }
                  >
                    <Input
                      value={memoryCredBaseUrl ?? memory.baseURL}
                      onChange={(e) =>
                        setMemory((prev) => ({
                          ...prev,
                          baseURL: e.target.value,
                        }))
                      }
                      disabled={!!memoryCredBaseUrl}
                      placeholder="https://api.groq.com/openai/v1"
                    />
                  </FormField>
                )}
              </div>
            )}
          </Section>

          <Section
            id="modelFallback"
            icon={LifeBuoy}
            title={t("editor.modelFallback", "Fallback provider")}
            description={t(
              "editor.modelFallbackHint",
              "Where a turn goes when the agent's own provider cannot take it: rate-limited, overloaded, or not answering. Only those. A key the provider rejected, a model id it does not know, or a request it refused are NOT failed over, because the second provider would answer them fine and you would never find out the first one is broken \u2014 you would just be billed by both. Leave it empty and nothing changes: a turn that fails today keeps failing the same way.",
            )}
          >
            <FormField
              label={t("editor.provider", "Provider")}
              description={t(
                "editor.modelFallbackProviderHint",
                "Pick a different vendor than the agent's whenever you can. The same vendor rate-limits your account as a whole, so a second model there is usually down for the same reason at the same moment.",
              )}
            >
              <Select
                value={modelFallback.provider}
                onChange={(e) =>
                  setModelFallback((prev) => ({
                    ...prev,
                    ...overrideProviderChanged(
                      {
                        provider: prev.provider,
                        model: prev.model,
                        credentialRef: prev.credentialRef,
                        baseURL: prev.baseURL,
                      },
                      e.target.value,
                    ),
                  }))
                }
              >
                <option value="">
                  {t("editor.modelFallbackNone", "No fallback")}
                </option>
                {MODEL_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {providerLabel(p, t)}
                  </option>
                ))}
              </Select>
            </FormField>
            {!!modelFallback.provider && (
              <div className="flex flex-col gap-3">
                <FormField
                  label={t("editor.credential", "API key")}
                  description={t(
                    "editor.modelFallbackCredentialHint",
                    "Required when the provider differs from the agent's: the agent's key is never sent to another vendor, so without a key of its own there is nothing behind the provider and the turn fails as it would with no fallback at all.",
                  )}
                  group
                >
                  <CredentialPicker
                    value={modelFallback.credentialRef}
                    onChange={(v) =>
                      setModelFallback((prev) => ({
                        ...prev,
                        ...overridePicked(
                          {
                            provider: prev.provider,
                            model: prev.model,
                            credentialRef: prev.credentialRef,
                            baseURL: prev.baseURL,
                          },
                          "credentialRef",
                          v,
                          agentModelProvider,
                        ),
                      }))
                    }
                    required={fallbackNeedsOwnCredential}
                    compatibleTypes={credentialCompat.model(
                      fallbackEffectiveProvider,
                    )}
                    defaultCreateType={
                      credentialCompat.model(fallbackEffectiveProvider)[0]
                    }
                    ariaLabel={t("editor.credential", "API key")}
                  />
                </FormField>
                <FormField
                  label={t("editor.model", "Model")}
                  // The same predicate the save gate reads, so the red field and the disabled button
                  // cannot drift apart: a provider with no model stores cleanly, comes back as "No
                  // fallback", and builds nothing.
                  error={
                    fallbackModelMissing
                      ? t(
                          "editor.modelFallbackModelRequired",
                          "Pick a model, or the fallback is saved and never runs.",
                        )
                      : null
                  }
                  group
                >
                  <ModelPicker
                    value={modelFallback.model}
                    onChange={(v) =>
                      setModelFallback((prev) => ({
                        ...prev,
                        ...overridePicked(
                          {
                            provider: prev.provider,
                            model: prev.model,
                            credentialRef: prev.credentialRef,
                            baseURL: prev.baseURL,
                          },
                          "model",
                          v,
                          agentModelProvider,
                        ),
                      }))
                    }
                    provider={fallbackEffectiveProvider}
                    credentialRef={fallbackSource.credentialRef || undefined}
                    baseURL={fallbackSource.baseURL || undefined}
                  />
                </FormField>
                {(fallbackEffectiveProvider === "openai-compatible" ||
                  !!modelFallbackCredBaseUrl ||
                  !!modelFallback.baseURL.trim()) && (
                  <FormField
                    label={t("editor.baseURL", "Base URL")}
                    description={
                      modelFallbackCredBaseUrl
                        ? t(
                            "editor.baseURLFromCredential",
                            "Defined by the selected credential.",
                          )
                        : t(
                            "editor.modelFallbackBaseURLHint",
                            "Required for OpenAI-compatible endpoints, unless the credential already carries one.",
                          )
                    }
                    error={
                      fallbackBaseUrlUnsupported
                        ? t(
                            "editor.baseURLNotSentByProvider",
                            "This provider does not send a base URL: the request would go to its own endpoint instead. Pick a credential without one, or use an OpenAI-compatible provider.",
                          )
                        : fallbackBaseUrlInvalid && modelFallback.baseURL.trim()
                          ? t(
                              "common.invalidUrl",
                              "Must be a valid http(s) URL.",
                            )
                          : null
                    }
                  >
                    <Input
                      value={modelFallbackCredBaseUrl ?? modelFallback.baseURL}
                      onChange={(e) =>
                        setModelFallback((prev) => ({
                          ...prev,
                          baseURL: e.target.value,
                        }))
                      }
                      disabled={!!modelFallbackCredBaseUrl}
                      placeholder="https://..."
                    />
                  </FormField>
                )}
              </div>
            )}
          </Section>

          <Section
            id="observability"
            icon={ScrollText}
            title={t("editor.observability", "Logs")}
            description={t(
              "editor.observabilityHint",
              'By default a tool line on the Logs page records the SHAPE of each argument and result ({ cpf: "string(11)" }): enough to see which arguments the agent sent, which it left out and whether a format is wrong, with no customer data. Turning the switch on records the values themselves, which is what answers which record it actually looked up, and keeps those values for the whole log retention window, including in every log export. Turn it on while investigating, off afterwards.',
            )}
          >
            {debugModesOn && (
              <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                  aria-hidden="true"
                />
                <span>
                  {t(
                    "editor.observabilityDebugOn",
                    "Recording more than the default right now:",
                  )}{" "}
                  {debugModesOn.join(" · ")}
                </span>
              </div>
            )}
            <SwitchField
              checked={observability.logToolValues}
              onCheckedChange={(v) =>
                setObservability((o) => ({ ...o, logToolValues: v }))
              }
              label={t(
                "editor.observabilityLogToolValues",
                "Log the values sent to tools",
              )}
            />
            <SwitchField
              // Derived, not read off the form: `fullDetail` was computed when the config was read,
              // and the one thing it describes turns itself off. A switch frozen at that answer
              // stays checked past its own deadline and shows a hint naming a moment that has gone,
              // and re-arming then takes two clicks because the first only sets it to what it
              // already claims to be.
              checked={isFullDetailWindowOpen(
                observability.fullDetailUntil,
                judgedAt,
              )}
              onCheckedChange={(v) =>
                setObservability((o) => ({
                  ...o,
                  fullDetail: v,
                  // The stored value IS the end of the window, so turning the switch on is choosing
                  // an instant. It cannot be armed for longer than the schema accepts, and it stops
                  // on its own, which is the point: an operator who forgets loses at most one day of
                  // full-size rows instead of the whole retention window.
                  //
                  // Chosen on the SERVER's clock, because the server is what enforces it. Off the
                  // browser's, a wrong machine arms a window of a different length than the one the
                  // screen names, and a machine wrong by more than the arming gap arms one that was
                  // already over.
                  fullDetailUntil: v
                    ? new Date(serverNow() + FULL_DETAIL_ARM_HOURS * 3_600_000)
                    : null,
                }))
              }
              label={t(
                "editor.observabilityFullDetail",
                "Store log detail in full (expires on its own)",
              )}
            />
            <p className="text-text-secondary text-xs">
              {/* Which of the two sentences depends on whether this deadline is the SAVED one.
                  Both are "the window is open until X", and only the unsaved one is waiting on a
                  click: an armed-and-saved window that kept saying "Save to apply" contradicted the
                  warning above it, which speaks for the server, and left an operator no way to tell
                  a mode that is running from one that is merely typed. */}
              {isFullDetailWindowOpen(observability.fullDetailUntil, judgedAt)
                ? formUntilMs === savedUntilMs
                  ? t("editor.observabilityFullDetailUntil", {
                      defaultValue: "On until {{when}}.",
                      when:
                        observability.fullDetailUntil?.toLocaleString() ?? "",
                    })
                  : t("editor.observabilityFullDetailUntilUnsaved", {
                      defaultValue: "On until {{when}} once you save.",
                      when:
                        observability.fullDetailUntil?.toLocaleString() ?? "",
                    })
                : t("editor.observabilityFullDetailHint", {
                    defaultValue:
                      "A log line cuts every stored string at 2,000 characters, which is where a long system prompt stops being readable on the Logs page. This keeps them whole for the next {{hours}}h, then goes back to cutting them without anyone having to remember.",
                    hours: FULL_DETAIL_ARM_HOURS,
                  })}
            </p>
          </Section>

          <Section
            id="proactive"
            icon={Megaphone}
            title={t("editor.proactiveSection", "Proactive messages")}
            description={t(
              "editor.proactiveSectionHint",
              "Reach out first when a conversation goes silent. On WhatsApp, a message sent outside the 24h window needs an approved template (HSM).",
            )}
          >
            {/* When to reach out */}
            <div className="flex flex-col gap-4">
              <div>
                <h4 className="font-medium text-sm text-text-secondary">
                  {t("editor.followUp", "Follow-up")}
                </h4>
                <p className="text-text-muted text-xs">
                  {t(
                    "editor.followUpSectionHint",
                    "Proactively re-engage conversations that go silent after the agent's last message.",
                  )}
                </p>
              </div>
              {redirectSuppressesFollowUp && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-text-secondary text-xs">
                  <ArrowRightLeft
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent"
                    aria-hidden="true"
                  />
                  <span>
                    {t(
                      "editor.followUpRedirectSuppressed",
                      "Redirect is on for this agent, so the follow-up below does not run for the WhatsApp entry inbox or the website-chat inbox. The redirect handles re-engagement there. It still applies to any other channel this agent answers.",
                    )}
                  </span>
                </div>
              )}
              <SwitchField
                checked={followUp.enabled}
                onCheckedChange={(v) =>
                  setFollowUp({ ...followUp, enabled: v })
                }
                label={t(
                  "editor.followUpEnabled",
                  "Send a follow-up when the conversation goes silent",
                )}
              />
              {followUp.enabled && (
                <>
                  <FormField
                    label={t("editor.followUpWindowField", "Allowed schedule")}
                    group
                    description={t(
                      "editor.followUpScheduleHint",
                      "Applies to the whole sequence. Steps only fire inside this schedule.",
                    )}
                  >
                    <SchedulePicker
                      value={followUpHoursId}
                      onChange={setFollowUpHoursId}
                      schedules={hours.map(toScheduleOption)}
                      emptyLabel={t(
                        "editor.followUpHoursDefault",
                        "Follow agent's main schedule",
                      )}
                      emptySummary={(() => {
                        if (businessHoursId) {
                          const inherited = hours.find(
                            (h) => String(h.id) === businessHoursId,
                          );
                          if (inherited) {
                            const summary = formatWindowsSummary(
                              toScheduleOption(inherited).windows,
                              t("schedule.noWindows", "No windows"),
                              i18n.language,
                            );
                            return `${t("editor.followUpHoursInherited", "Inherited:")} ${inherited.name} — ${summary}`;
                          }
                        }
                        return t(
                          "editor.followUpHoursAnyTime",
                          "No schedule set — follow-up may fire at any time.",
                        );
                      })()}
                      aria-label={t(
                        "editor.followUpWindowField",
                        "Allowed schedule",
                      )}
                      onScheduleSaved={(savedId) => {
                        onScheduleSaved(savedId, setFollowUpHoursId);
                      }}
                    />
                  </FormField>
                  <FollowUpStepsEditor
                    agentId={agentId}
                    followUp={followUp}
                    setFollowUp={setFollowUp}
                  />
                  <div className="flex flex-col gap-1.5">
                    <SwitchField
                      checked={followUp.pauseWhileAppointment}
                      onCheckedChange={(v) =>
                        setFollowUp({
                          ...followUp,
                          pauseWhileAppointment: v,
                        })
                      }
                      label={t(
                        "editor.followUpPauseAppointment",
                        "Pause while the customer has an upcoming appointment",
                      )}
                    />
                    <p className="text-text-muted text-xs">
                      {t(
                        "editor.followUpPauseAppointmentHint",
                        "When the customer has a booked appointment (a scheduled reminder), hold the follow-up until it passes or is cancelled. The appointment reminders take over.",
                      )}
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* How it is delivered: WhatsApp's 24h window governs every proactive send */}
            <div className="flex flex-col gap-4 border-border border-t pt-4">
              <div>
                <h4 className="font-medium text-sm text-text-secondary">
                  {t("editor.svcWindow", "WhatsApp 24h window")}
                </h4>
                <p className="text-text-muted text-xs">
                  {t(
                    "editor.svcWindowHint",
                    "WhatsApp only allows free-form messages within 24h of the customer's last message. Outside it, proactive messages need an approved template (HSM).",
                  )}
                </p>
              </div>
              <SwitchField
                checked={serviceWindow.enabled}
                onCheckedChange={(v) =>
                  setServiceWindow({ ...serviceWindow, enabled: v })
                }
                label={t(
                  "editor.svcWindowEnabled",
                  "Enforce the 24h window for proactive messages",
                )}
              />
              {serviceWindow.enabled && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      label={t("editor.svcWindowHours", "Window (hours)")}
                    >
                      <Input
                        type="number"
                        min={1}
                        max={168}
                        value={serviceWindow.windowHours}
                        onChange={(e) =>
                          setServiceWindow({
                            ...serviceWindow,
                            windowHours: e.target.value,
                          })
                        }
                      />
                    </FormField>
                    <ServiceWindowTemplateField
                      agentId={agentId}
                      serviceWindow={serviceWindow}
                      setServiceWindow={setServiceWindow}
                    />
                  </div>
                  {serviceWindow.templateName.trim() !== "" && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormField
                        label={t("editor.svcWindowLang", "Template language")}
                      >
                        <Input
                          value={serviceWindow.templateLanguage}
                          onChange={(e) =>
                            setServiceWindow({
                              ...serviceWindow,
                              templateLanguage: e.target.value,
                            })
                          }
                          placeholder="pt_BR"
                        />
                      </FormField>
                      <FormField
                        label={t("editor.svcWindowParams", "Body params")}
                        description={t(
                          "editor.svcWindowParamsHint",
                          "Comma-separated; variables like nome_contato / primeiro_nome are interpolated.",
                        )}
                      >
                        <Input
                          value={serviceWindow.templateParams}
                          onChange={(e) =>
                            setServiceWindow({
                              ...serviceWindow,
                              templateParams: e.target.value,
                            })
                          }
                          placeholder="{{primeiro_nome}}"
                        />
                      </FormField>
                    </div>
                  )}
                </>
              )}
            </div>
          </Section>
        </div>
      </div>

      <TabActionBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onDiscard={onDiscard}
        saveDisabled={
          contactAuthUrlInvalid ||
          sttBaseUrlInvalid ||
          visionBaseUrlInvalid ||
          normalizeBaseUrlInvalid ||
          normalizeBaseUrlUnsupported ||
          memoryBaseUrlInvalid ||
          memoryBaseUrlUnsupported ||
          fallbackBaseUrlInvalid ||
          fallbackBaseUrlUnsupported ||
          fallbackModelMissing
        }
        onOpenPlayground={onOpenPlayground}
      />
    </div>
  );
}
