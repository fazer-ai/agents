import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import type { ResolvedModelConfig } from "@/graph/models";
import type { AgentConfig } from "@/graph/prepare";
import { buildModelAndGraph, buildSpeechNormalizer } from "@/graph/prepare";
import { GUARDRAILS_DEFAULTS } from "@/modules/guardrails/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { SERVICE_WINDOW_DEFAULTS } from "@/modules/service-window/service";
import { SPLIT_DEFAULTS } from "@/modules/split/service";
import { TTS_DEFAULTS } from "@/modules/tts/settings";

// Minimal AgentConfig stub for buildModelAndGraph — only fields it reads.
function makeConfig(
  over: Partial<
    Pick<
      AgentConfig,
      | "mc"
      | "credentialBaseUrl"
      | "ttsConfig"
      | "ttsNormalizeApiKey"
      | "ttsNormalizeCredentialBaseUrl"
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
    ragConfig: undefined,
    langfuseCfg: null,
    ttsConfig: TTS_DEFAULTS,
    ttsNormalizeApiKey: "",
    ttsNormalizeCredentialBaseUrl: null,
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
    maxHistoryTokens: null,
    memoryCompaction: true,
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

describe("buildSpeechNormalizer", () => {
  function captureModel() {
    let captured: ResolvedModelConfig | null = null;
    const makeModel = (cfg: ResolvedModelConfig): BaseChatModel => {
      captured = cfg;
      return {
        invoke: async () => ({ content: "" }),
      } as unknown as BaseChatModel;
    };
    return { makeModel, getCaptured: () => captured as ResolvedModelConfig };
  }

  test("returns undefined when the agent turned the rewrite off", () => {
    const { makeModel } = captureModel();
    const cfg = makeConfig({
      ttsConfig: { ...TTS_DEFAULTS, normalize: false },
    });
    expect(buildSpeechNormalizer(cfg, { makeModel })).toBeUndefined();
  });

  test("inherits the agent's model, key and baseURL when nothing of its own is set", () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: { provider: "openai", model: "gpt-5", temperature: 0.7 },
      credentialBaseUrl: "https://credential.example.com/v1",
      ttsConfig: { ...TTS_DEFAULTS, normalize: true },
    });
    expect(buildSpeechNormalizer(cfg, { makeModel })).toBeDefined();
    expect(getCaptured().provider).toBe("openai");
    expect(getCaptured().model).toBe("gpt-5");
    expect(getCaptured().apiKey).toBe("test-key");
    expect(getCaptured().baseURL).toBe("https://credential.example.com/v1");
  });

  // A rewrite of an answer that already exists: deterministic, and not something to spend reasoning
  // tokens (or the customer's waiting time) on, whatever the operator picked for the agent itself.
  test("pins temperature to 0 and drops the agent's reasoning effort", () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: {
        provider: "openai",
        model: "gpt-5",
        temperature: 0.9,
        reasoningEffort: "high",
      },
      ttsConfig: { ...TTS_DEFAULTS, normalize: true },
    });
    buildSpeechNormalizer(cfg, { makeModel });
    expect(getCaptured().temperature).toBe(0);
    expect(getCaptured().reasoningEffort).toBeUndefined();
  });

  // Nothing of the agent's config reaches the factory except what the resolver handed back by name.
  // Pinned as the exact key set, so a field the schema grows later (and a spread would carry across
  // a provider switch) shows up here as an extra key rather than as a silent inheritance.
  test("the factory sees the resolution and nothing else of the agent's config", () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: {
        provider: "openai",
        model: "gpt-5",
        credentialRef: "vault:1",
        temperature: 0.9,
        reasoningEffort: "high",
      },
      ttsConfig: {
        ...TTS_DEFAULTS,
        normalize: true,
        normalizeProvider: "google",
        normalizeModel: "gemini-2.5-flash",
        normalizeCredentialRef: "vault:9",
      },
      ttsNormalizeApiKey: "normalizer-key",
    });
    buildSpeechNormalizer(cfg, { makeModel });
    expect(Object.keys(getCaptured()).sort()).toEqual([
      "apiKey",
      "baseURL",
      "model",
      "provider",
      "temperature",
    ]);
  });

  test("its own credential swaps the key, not just the model name", () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: { provider: "openai", model: "gpt-5" },
      credentialBaseUrl: "https://agent.example.com/v1",
      ttsConfig: {
        ...TTS_DEFAULTS,
        normalize: true,
        normalizeProvider: "google",
        normalizeModel: "gemini-2.5-flash",
        normalizeCredentialRef: "vault:9",
      },
      ttsNormalizeApiKey: "normalizer-key",
    });
    buildSpeechNormalizer(cfg, { makeModel });
    expect(getCaptured().provider).toBe("google");
    expect(getCaptured().model).toBe("gemini-2.5-flash");
    expect(getCaptured().apiKey).toBe("normalizer-key");
    // Not the agent's gateway, and not a Google one either: Google's adapter has no endpoint to
    // give, so the only correct value here is nothing.
    expect(getCaptured().baseURL).toBeUndefined();
  });

  // Where an endpoint IS honored, it has to be the rewrite's own and not the agent's. Same
  // assertion as above, on the provider that can actually carry it.
  test("its own endpoint reaches the factory on a provider that sends one", () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: { provider: "openai", model: "gpt-5" },
      credentialBaseUrl: "https://agent.example.com/v1",
      ttsConfig: {
        ...TTS_DEFAULTS,
        normalize: true,
        normalizeProvider: "openrouter",
        normalizeModel: "openai/gpt-4o-mini",
        normalizeCredentialRef: "vault:9",
      },
      ttsNormalizeApiKey: "normalizer-key",
      ttsNormalizeCredentialBaseUrl: "https://normalizer.example.com/v1",
    });
    buildSpeechNormalizer(cfg, { makeModel });
    expect(getCaptured().apiKey).toBe("normalizer-key");
    expect(getCaptured().baseURL).toBe("https://normalizer.example.com/v1");
  });

  // The runtime wraps the ENTIRE TTS branch in one try/catch, so anything thrown while building the
  // normalizer costs the customer the voice note, not just the rewrite. createChatModel rejects some
  // configurations synchronously (openai-compatible with no base URL), and this config is separately
  // editable, so that throw is reachable with the agent's own model perfectly fine.
  test("a model factory that throws skips the rewrite instead of propagating", () => {
    const cfg = makeConfig({
      ttsConfig: {
        ...TTS_DEFAULTS,
        normalize: true,
        normalizeProvider: "openai-compatible",
      },
    });
    const makeModel = () => {
      throw new Error("openai-compatible provider requires baseURL");
    };
    expect(buildSpeechNormalizer(cfg, { makeModel })).toBeUndefined();
  });

  // A local llama.cpp-style endpoint authenticates by its URL and has no key at all. The resolution
  // says `credential: "none"`, and what that has to mean on the wire is an EMPTY key: falling back
  // to `cfg.apiKey` here would ship the agent's OpenAI secret to that endpoint, which is the exact
  // leak the whole provider rule exists to prevent.
  test("a keyless openai-compatible endpoint sends NO key, not the agent's", () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: { provider: "openai", model: "gpt-5" },
      ttsConfig: {
        ...TTS_DEFAULTS,
        normalize: true,
        normalizeProvider: "openai-compatible",
        normalizeBaseURL: "http://llama:8080/v1",
      },
    });
    expect(buildSpeechNormalizer(cfg, { makeModel })).toBeDefined();
    expect(getCaptured().apiKey).toBe("");
    expect(getCaptured().baseURL).toBe("http://llama:8080/v1");
  });

  // A provider name REST or MCP stored that we do not support. Falling back to the agent's provider
  // while keeping the dedicated credential would hand that key to a vendor it does not belong to.
  test("an unsupported provider name does not run, and no key travels", () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      ttsConfig: {
        ...TTS_DEFAULTS,
        normalize: true,
        normalizeProvider: "anthropik",
        normalizeCredentialRef: "vault:9",
      },
      ttsNormalizeApiKey: "sk-ant-real-key",
    });
    expect(buildSpeechNormalizer(cfg, { makeModel })).toBeUndefined();
    expect(getCaptured()).toBeNull();
  });

  // The operator pointed the rewrite at its own credential and that credential is gone. Reaching for
  // the AGENT's key would be a silent substitution onto a provider that may not even accept it, so
  // the rewrite is skipped and the audio goes out from the raw text.
  //
  // NOTE: the provider is named on purpose. A dedicated credential without one is refused by the
  // resolution itself, which would make this pass without the vault lookup ever mattering — a green
  // test proving the wrong guard.
  test("skips entirely when its own credential did not resolve", () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      ttsConfig: {
        ...TTS_DEFAULTS,
        normalize: true,
        normalizeProvider: "openai",
        normalizeCredentialRef: "vault:404",
      },
      ttsNormalizeApiKey: "",
    });
    expect(buildSpeechNormalizer(cfg, { makeModel })).toBeUndefined();
    expect(getCaptured()).toBeNull();
  });

  // What the rule buys, at the layer where it is spent: the key that travels and the host it travels
  // to. The agent runs behind a gateway; the rewrite has a key of its own on the same vendor. The
  // gateway is NOT inherited, because the day the operator repoints the agent (a different tab, its
  // own save) that inheritance would carry this key along with it.
  test("a dedicated key is not sent to the agent's gateway", () => {
    const { makeModel, getCaptured } = captureModel();
    const cfg = makeConfig({
      mc: { provider: "openai", model: "gpt-5" },
      credentialBaseUrl: "https://gateway.example.com/v1",
      ttsConfig: {
        ...TTS_DEFAULTS,
        normalize: true,
        normalizeProvider: "openai",
        normalizeCredentialRef: "vault:9",
      },
      ttsNormalizeApiKey: "sk-rewriter",
    });
    expect(buildSpeechNormalizer(cfg, { makeModel })).toBeDefined();
    expect(getCaptured().apiKey).toBe("sk-rewriter");
    expect(getCaptured().baseURL).toBeUndefined();
  });
});
