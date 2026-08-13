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

export function createChatModel(cfg: ResolvedModelConfig): BaseChatModel {
  const { model, apiKey, temperature } = cfg;
  switch (cfg.provider) {
    case "openai":
      return new ChatOpenAI({
        model,
        apiKey,
        temperature: openaiTemperature(model, temperature),
      });
    case "openai-compatible":
      if (!cfg.baseURL) {
        throw new AppError("openai-compatible provider requires baseURL", 400);
      }
      return new ChatOpenAI({
        // Empty model = "the server's default" (see model-config): send a neutral placeholder so
        // the request is well-formed; llama.cpp-style single-model servers ignore the name.
        model: model.trim() || "default",
        apiKey,
        temperature: openaiTemperature(model, temperature),
        configuration: { baseURL: cfg.baseURL },
      });
    case "openrouter":
      return new ChatOpenAI({
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
