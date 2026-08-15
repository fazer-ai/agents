import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import type { ResolvedModelConfig } from "@/graph/models";
import type { AgentConfig } from "@/graph/prepare";
import { buildModelAndGraph } from "@/graph/prepare";
import { GUARDRAILS_DEFAULTS } from "@/modules/guardrails/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { SERVICE_WINDOW_DEFAULTS } from "@/modules/service-window/service";
import { SPLIT_DEFAULTS } from "@/modules/split/service";
import { TTS_DEFAULTS } from "@/modules/tts/settings";

// Minimal AgentConfig stub for buildModelAndGraph — only fields it reads.
function makeConfig(
  over: Partial<Pick<AgentConfig, "mc" | "credentialBaseUrl">> = {},
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
    ragConfig: undefined,
    langfuseCfg: null,
    ttsConfig: TTS_DEFAULTS,
    contactVoiceReply: null,
    splitConfig: SPLIT_DEFAULTS,
    serviceWindowConfig: SERVICE_WINDOW_DEFAULTS,
    handoffConfig: HANDOFF_DEFAULTS,
    sendImageConfig: SEND_IMAGE_DEFAULTS,
    kanbanConfig: KANBAN_DEFAULTS,
    toolGuidance: {},
    httpToolContext: {},
    contactName: null,
    timezone: "America/Sao_Paulo",
    maxToolCalls: 10,
    logToolValues: false,
    ...over,
  } as AgentConfig;
}

describe("buildModelAndGraph — effective baseURL resolution", () => {
  function captureModel() {
    let captured: ResolvedModelConfig | null = null;
    const makeModel = (cfg: ResolvedModelConfig): BaseChatModel => {
      captured = cfg;
      // Minimal stub: graph building only needs the model object to exist.
      return { bindTools: () => ({}) } as unknown as BaseChatModel;
    };
    return { makeModel, getCaptured: () => captured };
  }

  test("credential entry.baseUrl overrides mc.baseURL when present", async () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "https://fallback.example.com/v1",
      },
      credentialBaseUrl: "https://credential.example.com/v1",
    });
    await buildModelAndGraph(cfg, [], {
      makeModel,
      checkpointer: new MemorySaver(),
    });
    expect(getCaptured()?.baseURL).toBe("https://credential.example.com/v1");
  });

  test("mc.baseURL is used when credentialBaseUrl is null", async () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "https://fallback.example.com/v1",
      },
      credentialBaseUrl: null,
    });
    await buildModelAndGraph(cfg, [], {
      makeModel,
      checkpointer: new MemorySaver(),
    });
    expect(getCaptured()?.baseURL).toBe("https://fallback.example.com/v1");
  });

  test("both null/undefined → undefined baseURL passed to factory", async () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: { provider: "openai", model: "gpt-4o-mini" },
      credentialBaseUrl: null,
    });
    await buildModelAndGraph(cfg, [], {
      makeModel,
      checkpointer: new MemorySaver(),
    });
    expect(getCaptured()?.baseURL).toBeUndefined();
  });
});
