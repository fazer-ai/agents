import {
  AlertTriangle,
  ArrowRightLeft,
  Brain,
  CalendarClock,
  Gauge,
  Image,
  ImagePlus,
  Layers,
  ListChecks,
  Megaphone,
  Mic,
  Plus,
  Scissors,
  ScrollText,
  Trash2,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { FOLLOW_UP_MAX_STEPS } from "@/modules/followups/settings";
import { DEFAULT_EXTRACTION_PROMPT } from "@/modules/vision/prompt-default";
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

interface FollowUpStepState {
  delayValue: string;
  delayUnit: string;
  instructions: string;
  assignLabels: string[]; // labels added to the conversation when this step fires
  resolve: boolean; // honored only on the last step
}

interface FollowUpState {
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
  memory: { compactionEnabled: boolean };
  setMemory: React.Dispatch<
    React.SetStateAction<{ compactionEnabled: boolean }>
  >;
  observability: { logToolValues: boolean };
  setObservability: React.Dispatch<
    React.SetStateAction<{ logToolValues: boolean }>
  >;
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
  observability,
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
                  <FormField label={t("editor.visionProvider", "Provider")}>
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
                  description={t(
                    "editor.visionModelHint",
                    "Leave blank for the provider default. OpenAI reads images only; Gemini and Anthropic also read PDFs.",
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
              'The agent remembers every conversation it has had with this contact on this channel. When an attendance ends, its messages are replaced by a summary of it, so the memory becomes "N summarized attendances + the current one". What survives a summary is the useful part: who the contact is, what was agreed, what was left open. Exact wording does not, so turn this off if the agent must be able to quote an old conversation word for word. The summary is written by the agent\'s own model, after the reply is sent, so no customer waits for it.',
            )}
          >
            <SwitchField
              checked={memory.compactionEnabled}
              onCheckedChange={(v) => setMemory({ compactionEnabled: v })}
              label={t(
                "editor.memoryCompaction",
                "Summarize attendances that have ended",
              )}
            />
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
            <SwitchField
              checked={observability.logToolValues}
              onCheckedChange={(v) => setObservability({ logToolValues: v })}
              label={t(
                "editor.observabilityLogToolValues",
                "Log the values sent to tools",
              )}
            />
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
          sttBaseUrlInvalid ||
          visionBaseUrlInvalid ||
          normalizeBaseUrlInvalid ||
          normalizeBaseUrlUnsupported
        }
        onOpenPlayground={onOpenPlayground}
      />
    </div>
  );
}
