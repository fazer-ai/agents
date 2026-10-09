import type { AgentConfig } from "@/graph/prepare";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";
import { GUARDRAILS_DEFAULTS } from "@/modules/guardrails/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { SERVICE_WINDOW_DEFAULTS } from "@/modules/service-window/service";
import { SIGNATURE_DEFAULTS } from "@/modules/signature/service";
import { SPLIT_DEFAULTS } from "@/modules/split/service";
import { TTS_DEFAULTS } from "@/modules/tts/settings";

// The AgentConfig stub `buildModelAndGraph` reads, shared by the files that drive it: a second copy
// would drift the first time AgentConfig grew a field.

// Minimal AgentConfig stub for buildModelAndGraph — only fields it reads.
export function makeConfig(
  over: Partial<
    Pick<
      AgentConfig,
      | "mc"
      | "credentialBaseUrl"
      | "ttsConfig"
      | "ttsNormalizeApiKey"
      | "ttsNormalizeCredentialBaseUrl"
      | "modelFallback"
      | "modelFallbackApiKey"
      | "modelFallbackCredentialBaseUrl"
      // As entradas de que o prompt foi renderizado, para o teste da recomposição da idade poder
      // montar uma config com template, vars e seções coerentes entre si.
      | "systemPrompt"
      | "promptTemplate"
      | "promptVars"
      | "promptOpts"
      | "promptSections"
      | "auditedSections"
    >
  > = {},
): AgentConfig {
  return {
    agentId: 1n,
    agentBotId: null,
    agentBotToken: null,
    conversationDbId: null,
    inboxDbId: null,
    channelType: null,
    whatsappProvider: null,
    contactDbId: null,
    contactInboxId: null,
    systemPrompt: "Você é um assistente.",
    systemPromptAudit: "Você é um assistente.",
    mc: {
      provider: "openai",
      model: "gpt-4o-mini",
    },
    apiKey: "test-key",
    credentialBaseUrl: null,
    guardrails: GUARDRAILS_DEFAULTS,
    guardrailsApiKey: "",
    guardrailsCredentialBaseUrl: null,
    transferWithSummary: false,
    nativeToolsAllow: undefined,
    httpToolDefs: [],
    codeToolDefs: [],
    mcpSelections: [],
    integrationSelections: [],
    documentSelections: [],
    ragConfig: undefined,
    langfuseCfg: null,
    ttsConfig: TTS_DEFAULTS,
    ttsNormalizeApiKey: "",
    ttsNormalizeCredentialBaseUrl: null,
    modelFallback: {
      provider: null,
      model: null,
      credentialRef: null,
      baseURL: null,
    },
    modelFallbackApiKey: "",
    modelFallbackCredentialBaseUrl: null,
    contactVoiceReply: null,
    splitConfig: SPLIT_DEFAULTS,
    signatureConfig: SIGNATURE_DEFAULTS,
    promptVars: {},
    promptOpts: { now: new Date() },
    promptTemplate: "Você é um assistente.",
    promptSections: [],
    auditedSections: [],
    serviceWindowConfig: SERVICE_WINDOW_DEFAULTS,
    contactAuthConfig: CONTACT_AUTH_DEFAULTS,
    handoffConfig: HANDOFF_DEFAULTS,
    sendImageConfig: SEND_IMAGE_DEFAULTS,
    crossInboxCaseConfig: { ...CROSS_INBOX_CASE_DEFAULTS },
    contactFieldsConfig: { context: [], writable: [] },
    chatwootContactId: null,
    kanbanConfig: KANBAN_DEFAULTS,
    toolGuidance: {},
    protectedLabels: [],
    resolveLabels: [],
    resolveCaseHold: null,
    allowedLabels: [],
    outsideAllowedLabels: "refuse",
    toolPreconditions: {},
    httpToolContext: {},
    contactName: null,
    timezone: "America/Sao_Paulo",
    maxToolCalls: 10,
    maxHistoryTokens: null,
    retrySilence: true,
    maxTurnsPerHour: 0,
    memoryCompaction: true,
    historyDates: true,
    memoryCompactionOverride: {},
    memoryCompactionApiKey: "",
    memoryCompactionCredentialBaseUrl: null,
    suggestionReviewOverride: {},
    suggestionReviewApiKey: "",
    suggestionReviewCredentialBaseUrl: null,
    logToolValues: false,
    fullDetail: false,
    ...over,
  } as AgentConfig;
}
