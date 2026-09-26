import type { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import { EMPTY_CONTACT_AUTH_RULE_FORM } from "@/client/pages/agents/contactAuthRuleForm";
import { observationToForm } from "@/client/pages/agents/observationFormState";
import { readTtsFormState } from "@/client/pages/agents/ttsFormState";

// One filled-in prop bag for the Behavior tab, for the tests that have to RENDER it.
//
// ANNOTATED, NOT CAST, and that is the whole point of the shape below. The bag used to end in
// `as unknown as React.ComponentProps<typeof BehaviorTab>`, which absorbs a missing prop by
// absorbing everything: a prop the component REQUIRES and the bag omits is then invisible to tsc
// and surfaces as `TypeError: undefined is not an object` inside `render`, in whichever file
// happens to render the tab. Measured: the fallback-provider block (#143) added three required
// props, the whole suite still type-checked, and seven tests failed on a component they say
// nothing about. The intersection keeps the missing-key check that a cast throws away.
//
// The `Record<string, unknown>` half is what makes it a SUPERSET: the two editions do not carry
// the same props (the observability debug mode reached the Free repo before master), and a bag
// written against one tree throws on render in the other. The extras are absorbed there.
export type BehaviorTabProps = React.ComponentProps<typeof BehaviorTab> &
  Record<string, unknown>;

export function behaviorTabProps(
  over: Partial<BehaviorTabProps> = {},
): BehaviorTabProps {
  const noop = () => {};
  const props: BehaviorTabProps = {
    // Nothing refused: a refusal landing on a field is its own subject, and a caller that wants
    // one passes its own bag.
    refusals: {
      sttCredential: null,
      ttsCredential: null,
      ttsNormalizeCredential: null,
      visionCredential: null,
      visionExtractionPrompt: null,
      ttsSpokenNoticeText: null,
      ttsTextChoiceNote: null,
      contactAuthCredential: null,
      contactAuthDenyMessage: null,
      memoryCredential: null,
      modelFallbackCredential: null,
      awayMessage: null,
      followUpSteps: [],
    },
    agentId: "1",
    agentName: "Recepção",
    companyName: "Clínica Moreira",
    hours: [],
    businessHoursId: "",
    setBusinessHoursId: noop,
    awayEnabled: false,
    setAwayEnabled: noop,
    awayMessage: "",
    setAwayMessage: noop,
    followUpHoursId: "",
    setFollowUpHoursId: noop,
    debounce: {
      enabled: false,
      windowSeconds: "8",
      maxMessagesPerBurst: "10",
      maxWindowSeconds: "60",
    },
    setDebounce: noop,
    stt: {
      enabled: false,
      provider: "openai",
      model: "",
      language: "pt",
      credentialRef: "",
      baseURL: "",
    },
    setStt: noop,
    sttCredBaseUrl: null,
    contactAuth: {
      enabled: false,
      ...EMPTY_CONTACT_AUTH_RULE_FORM,
      url: "",
      credentialRef: "",
      timeoutMs: "5000",
      noticeCooldownSeconds: "60",
      includeMessageText: false,
      denyMessage: "",
      mode: "perMessage",
      grantTtlSeconds: "86400",
      handoffEnabled: false,
      handoffTeamId: "",
      handoffTeamInstanceId: "",
    },
    setContactAuth: noop,
    tts: readTtsFormState(undefined),
    setTts: noop,
    agentModelProvider: "openai",
    agentModelName: "gpt-4o",
    agentModelCredentialRef: "",
    agentModelBaseUrl: "",
    ttsNormalizeCredBaseUrl: null,
    split: {
      enabled: false,
      maxChars: "300",
      typingWpm: "200",
      maxDelayMs: "0",
    },
    setSplit: noop,
    signature: {
      enabled: false,
      text: "",
      position: "top" as const,
      frequency: "all" as const,
      separator: "blank" as const,
    },
    setSignature: () => {},
    vision: {
      enabled: true,
      provider: "openai",
      model: "",
      credentialRef: "",
      baseURL: "",
      extractionPrompt: "Leia.",
    },
    setVision: noop,
    visionCredBaseUrl: null,
    limits: { maxToolCalls: "10", maxHistoryTokens: "" },
    setLimits: noop,
    memory: {
      compactionEnabled: false,
      historyDatesEnabled: true,
      provider: "",
      model: "",
      credentialRef: "",
      baseURL: "",
    },
    setMemory: noop,
    mode: "production",
    observation: observationToForm({}),
    setObservation: noop,
    memoryCredBaseUrl: null,
    modelFallback: {
      provider: "",
      model: "",
      credentialRef: "",
      baseURL: "",
    },
    setModelFallback: noop,
    modelFallbackCredBaseUrl: null,
    observability: {
      logToolValues: false,
      fullDetail: false,
      fullDetailUntil: null,
    },
    savedObservability: {
      logToolValues: false,
      fullDetail: false,
      fullDetailUntil: null,
    },
    langfuseSendContent: false,
    setObservability: noop,
    sendImage: { allowedHosts: "" },
    takeover: { onHumanReply: true },
    setTakeover: () => {},
    setSendImage: noop,
    attributeContext: { conversation: [], contact: [], task: [] },
    setAttributeContext: noop,
    serviceWindow: {
      enabled: false,
      windowHours: "24",
      templateName: "",
      templateLanguage: "",
      templateParams: "",
      templateContent: "",
    },
    setServiceWindow: noop,
    followUp: { enabled: false, steps: [], pauseWhileAppointment: false },
    setFollowUp: noop,
    redirectSuppressesFollowUp: false,
    onScheduleSaved: noop,
    dirty: false,
    saving: false,
    onSave: noop,
    onDiscard: noop,
    onOpenPlayground: noop,
  };
  return { ...props, ...over };
}
