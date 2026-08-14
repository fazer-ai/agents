import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { AppError } from "@/lib/errors";
import { toGeminiTools } from "./gemini-tools";
import type { ModelConfig } from "./model-config";

// Per-agent/per-node model factory. The config SCHEMA lives in ./model-config (LangChain-free, so
// the config/HTTP layer validates without importing the provider SDKs); this module turns a
// validated config into a LangChain chat model. The API key is resolved from the vault by the
// caller (never inlined here, never logged). An OpenAI-compatible endpoint is reached by setting
// baseURL on the OpenAI client.

export {
  MODEL_PROVIDERS,
  type ModelConfig,
  modelConfigSchema,
  parseModelConfig,
} from "./model-config";

export interface ResolvedModelConfig extends ModelConfig {
  apiKey: string;
}

// OpenRouter is OpenAI-compatible with a fixed API root, so it reuses the ChatOpenAI client with this
// base URL instead of asking the operator for one (unlike the generic "openai-compatible" provider).
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// NOTE: OpenAI's reasoning families reject any `temperature` other than the default with a hard 400
// ("Unsupported value: 'temperature' does not support 0.3 with this model"), which kills the whole
// call — the agent's own turn, the guardrail pass and the TTS speech normalization all pin a
// temperature and would 400 on every request. Drop the parameter for those models instead of clamping
// it, and only for the OpenAI-shaped clients. Matches a bare id ("o4-mini", "gpt-5-mini") and a routed
// one ("openai/o4-mini", OpenRouter); "gpt-4o" and "omni-…" deliberately do not match. gpt-5-chat* is
// exempted: it is the non-reasoning chat family and accepts `temperature` (same carve-out as
// @langchain/openai's isReasoningModel), so dropping it there would silently discard the operator's
// preference.
const REASONING_MODEL_RE = /^(?:[\w.-]+\/)?(?:o\d+(?:-|$)|gpt-5(?!-chat))/i;

function openaiTemperature(
  model: string,
  temperature: number | undefined,
): number | undefined {
  return REASONING_MODEL_RE.test(model.trim()) ? undefined : temperature;
}

// NOTE: OpenAI rejects function tools combined with ANY non-"none" reasoning effort on
// /v1/chat/completions for the gpt-5.6 family: "Function tools with reasoning_effort are not
// supported for gpt-5.6-luna in /v1/chat/completions" (issue #66). We never send an effort, so what
// collides with the tools is the SERVER's own default. Measured against the live API: 400 on luna,
// sol and terra with tools and no effort, 200 with `reasoning_effort: "none"` on the same call, and
// 200 without tools either way.
//
// The carve-out stays on the family that is actually blocked. gpt-5.5, gpt-5.4, gpt-5.2 and
// gpt-5-mini all answered 200 with tools and no effort, and gpt-5.4-mini accepts "none" too — so a
// blanket "none" would silently drop the reasoning those agents get today, trading one regression
// for another. Reasoning TOGETHER with tools needs /v1/responses (measured working there), which is
// a transport change rather than part of this fix.
const TOOL_EFFORT_NONE_RE = /^(?:[\w.-]+\/)?gpt-5\.6(?:-|$)/i;

type OpenAIChatFields = ConstructorParameters<typeof ChatOpenAI>[0];

// Builds an OpenAI-shaped client, pinning the effort ONLY on the tool-bound model.
//
// NOTE: the rejection needs tools, so the parameter belongs to the bound model and nowhere else.
// The raw instance is invoked on purpose when the tool budget runs out (`hardLimit ? model : llm`
// in graph.ts), and that call is the one that writes the final answer to the customer; the
// guardrail pass, the TTS normalization and an agent with no grants never bind tools either. All of
// them are accepted with the provider's default effort (measured: 200 without tools either way), so
// pinning "none" on the constructor would switch reasoning off exactly where nothing required it.
//
// NOTE: the parameter travels via `modelKwargs` rather than the typed `reasoning` field because
// @langchain/openai gates that field behind its own isReasoningModel(), which tests
// `model.startsWith("gpt-5")` and therefore DROPS it for a routed id like "openai/gpt-5.6-luna"
// (OpenRouter). modelKwargs is spread into the request params unconditionally.
function makeOpenAIChat(fields: OpenAIChatFields): ChatOpenAI {
  const chat = new ChatOpenAI(fields);
  if (!TOOL_EFFORT_NONE_RE.test(String(fields?.model ?? "").trim()))
    return chat;
  const withEffort = new ChatOpenAI({
    ...fields,
    modelKwargs: { ...fields?.modelKwargs, reasoning_effort: "none" },
  });
  type BindTools = typeof chat.bindTools;
  const bindTools = withEffort.bindTools.bind(withEffort) as BindTools;
  chat.bindTools = ((tools, kwargs) => bindTools(tools, kwargs)) as BindTools;
  return chat;
}

export function createChatModel(cfg: ResolvedModelConfig): BaseChatModel {
  const { model, apiKey, temperature } = cfg;
  switch (cfg.provider) {
    case "openai":
      return makeOpenAIChat({
        model,
        apiKey,
        temperature: openaiTemperature(model, temperature),
      });
    case "openai-compatible":
      if (!cfg.baseURL) {
        throw new AppError("openai-compatible provider requires baseURL", 400);
      }
      return makeOpenAIChat({
        // Empty model = "the server's default" (see model-config): send a neutral placeholder so
        // the request is well-formed; llama.cpp-style single-model servers ignore the name.
        model: model.trim() || "default",
        apiKey,
        temperature: openaiTemperature(model, temperature),
        configuration: { baseURL: cfg.baseURL },
      });
    case "openrouter":
      return makeOpenAIChat({
        model,
        apiKey,
        temperature: openaiTemperature(model, temperature),
        configuration: { baseURL: cfg.baseURL || OPENROUTER_BASE_URL },
      });
    case "anthropic":
      return new ChatAnthropic({ model, apiKey, temperature });
    case "google": {
      const gemini = new ChatGoogleGenerativeAI({ model, apiKey, temperature });
      // NOTE: the adapter declares tool parameters in the OpenAPI subset, whose closed field set
      // rejects the whole request over a single unknown key (issue #64). Redeclaring them as JSON
      // Schema is the carve-out; see ./gemini-tools for the field set and what was measured.
      // Patched on the INSTANCE rather than by subclassing: LangChain derives the serialized model
      // id from the constructor name, so a subclass renames the model to itself in every payload
      // that reaches Langfuse (measured: the lc_id tail becomes the subclass name). An own property
      // also shadows the prototype for the adapter's own internal `this.bindTools(...)` calls.
      type BindTools = typeof gemini.bindTools;
      const bindTools = gemini.bindTools.bind(gemini) as BindTools;
      gemini.bindTools = ((tools, kwargs) =>
        bindTools(
          toGeminiTools(tools) as Parameters<BindTools>[0],
          kwargs,
        )) as BindTools;
      return gemini;
    }
    case "deepseek":
      return new ChatDeepSeek({ model, apiKey, temperature });
    default:
      throw new AppError(`unknown model provider: ${cfg.provider}`, 400);
  }
}
