import type { AgentConfig } from "@/graph/prepare";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { GUARDRAILS_DEFAULTS } from "@/modules/guardrails/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { SERVICE_WINDOW_DEFAULTS } from "@/modules/service-window/service";
import { SPLIT_DEFAULTS } from "@/modules/split/service";
import { TTS_DEFAULTS } from "@/modules/tts/settings";

// The AgentConfig stub `buildModelAndGraph` reads, shared by the two files that drive it. It moved
// out of prepare.test.ts when the fallback tests needed the same twenty-odd fields: a second copy
// would have started identical and drifted the first time AgentConfig grew one.

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
    serviceWindowConfig: SERVICE_WINDOW_DEFAULTS,
    contactAuthConfig: CONTACT_AUTH_DEFAULTS,
    handoffConfig: HANDOFF_DEFAULTS,
    sendImageConfig: SEND_IMAGE_DEFAULTS,
    kanbanConfig: KANBAN_DEFAULTS,
    toolGuidance: {},
    toolPreconditions: {},
    httpToolContext: {},
    contactName: null,
    timezone: "America/Sao_Paulo",
    maxToolCalls: 10,
    maxHistoryTokens: null,
    memoryCompaction: true,
    memoryCompactionOverride: {},
    memoryCompactionApiKey: "",
    memoryCompactionCredentialBaseUrl: null,
    logToolValues: false,
    fullDetail: false,
    ...over,
  } as AgentConfig;
}
