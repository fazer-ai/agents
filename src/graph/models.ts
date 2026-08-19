import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { AppError } from "@/lib/errors";
import { toGeminiTools } from "./gemini-tools";
import type { ModelConfig } from "./model-config";
import {
  type OpenAITransportPlan,
  planOpenAITransport,
} from "./openai-reasoning";

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
export { REASONING_EFFORTS, type ReasoningEffort } from "./openai-reasoning";

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
// preference. The optional "ft:" reads through a fine-tune to its base model ("ft:<base>:<org>:<name>:<id>"),
// which is what actually decides the parameter rules — and since DEFAULT_MODEL_CONFIG ships a
// temperature, a fine-tune of a reasoning model was the DEFAULT config, not an exotic one.
const REASONING_MODEL_RE =
  /^(?:ft:)?(?:[\w.-]+\/)?(?:o\d+(?:-|$)|gpt-5(?!-chat))/i;

function openaiTemperature(
  model: string,
  temperature: number | undefined,
): number | undefined {
  return REASONING_MODEL_RE.test(model.trim()) ? undefined : temperature;
}

type OpenAIChatFields = ConstructorParameters<typeof ChatOpenAI>[0];

// Builds an OpenAI-shaped client from the transport plan (see ./openai-reasoning for what was
// measured and why the endpoint, not the model family, is what decides).
//
// NOTE: `toolEffort` is pinned by binding a SECOND instance's bindTools onto the first, so the
// parameter belongs to the bound model and nowhere else. That case exists only when nobody chose
// an effort and the provider's own default is what breaks function tools. The raw instance is
// invoked on purpose when the tool budget runs out (`hardLimit ? model : llm` in graph.ts) and
// that call writes the final answer to the customer; the guardrail pass, the TTS normalization and
// an agent with no grants never bind tools either. All of them are accepted at the provider's
// default effort, so pinning "none" on the constructor would switch reasoning off exactly where
// nothing required it. An effort the operator DID choose is about the agent, so it goes on the
// constructor and covers those calls too.
//
// NOTE: both efforts travel via `modelKwargs` rather than the typed fields,
// because @langchain/openai decides whether to send those by testing the model NAME
// (isReasoningModel: /^o\d/, or startsWith("gpt-5") minus gpt-5-chat). Any id it does not
// recognise loses the parameter: a routed "openai/gpt-5.6-luna" (OpenRouter), and — worse, because
// it is a legitimate choice of a model that really does reason — a fine-tuned "ft:gpt-5.6-luna:…".
// The request would still go to /v1/responses and arrive with no effort, discarding the operator's
// choice in silence. modelKwargs is spread into the params unconditionally, and the typed path
// overwrites it with the same value when it does fire, so the two can never disagree. A model with
// no reasoning to constrain then answers 400 naming the parameter, which is the outcome the
// operator can act on.
//
// NOTE: this also sidesteps the installed openai SDK typing `ReasoningEffort` without "max", which
// the live API accepts on the gpt-5.6 family (measured 200 with function tools) and names in its
// own rejection message elsewhere. Same shape of gap as issue #64: the measurement is what the
// request has to satisfy, not the SDK's snapshot of it.
//
// NOTE: `zdrEnabled` only sends `store: false` (it does not enable zero data retention on the
// OpenAI account, despite the name). Chat Completions stores nothing unless asked; the Responses
// API stores for 30 days by default. Without this, choosing a reasoning effort would silently
// change what OpenAI keeps of the customer's conversation. Measured: the two-turn tool round-trip
// still works with storage off.
// Whether this call will talk to /v1/responses. @langchain/openai decides that itself, from the
// model id AND from the call: some ids are routed there whatever we ask (_modelPrefersResponsesAPI,
// four substrings tested with case-SENSITIVE `includes` ANYWHERE in the id, so the free-text suffix
// of a fine-tune flips a plain gpt-5.6 agent — and "Codex-support" does not flip it while
// "codex-support" does), and so does any call carrying an OpenAI built-in or custom tool, or a
// Responses-only option. Predicting all that is a copy of their list, plus its case rules, plus its
// option rules, and each round of getting one slightly wrong costs a turn.
//
// NOTE: so the instance is asked instead of guessed, with the SAME options the call will carry.
// `invocationParams` is public and returns the parameter set that will actually be sent, and the
// two endpoints name the token cap differently (`max_output_tokens` on Responses,
// `max_completion_tokens` on Completions).
function usesResponsesEndpoint(chat: ChatOpenAI, options: unknown): boolean {
  return "max_output_tokens" in chat.invocationParams(options as never);
}

function makeOpenAIChat(
  fields: OpenAIChatFields,
  plan: OpenAITransportPlan,
): ChatOpenAI {
  const withPlan: OpenAIChatFields = {
    ...fields,
    ...(plan.responses
      ? {
          useResponsesApi: true,
          zdrEnabled: true,
          modelKwargs: {
            ...fields?.modelKwargs,
            reasoning: { effort: plan.effort },
          },
        }
      : {}),
  };
  const chat = new ChatOpenAI(withPlan);
  if (!plan.toolEffort) return chat;
  const withEffort = new ChatOpenAI({
    ...withPlan,
    modelKwargs: {
      ...withPlan?.modelKwargs,
      reasoning_effort: plan.toolEffort,
    },
  });
  type BindTools = typeof chat.bindTools;
  const bindPinned = withEffort.bindTools.bind(withEffort) as BindTools;
  const bindPlain = chat.bindTools.bind(chat) as BindTools;
  chat.bindTools = ((tools, kwargs) =>
    usesResponsesEndpoint(chat, { ...kwargs, tools })
      ? bindPlain(tools, kwargs)
      : bindPinned(tools, kwargs)) as BindTools;
  return chat;
}

export function createChatModel(cfg: ResolvedModelConfig): BaseChatModel {
  const { model, apiKey, temperature } = cfg;
  switch (cfg.provider) {
    case "openai":
      return makeOpenAIChat(
        {
          model,
          apiKey,
          temperature: openaiTemperature(model, temperature),
        },
        planOpenAITransport(model, cfg.reasoningEffort),
      );
    case "openai-compatible":
      if (!cfg.baseURL) {
        throw new AppError("openai-compatible provider requires baseURL", 400);
      }
      return makeOpenAIChat(
        {
          // Empty model = "the server's default" (see model-config): send a neutral placeholder so
          // the request is well-formed; llama.cpp-style single-model servers ignore the name.
          model: model.trim() || "default",
          apiKey,
          temperature: openaiTemperature(model, temperature),
          configuration: { baseURL: cfg.baseURL },
        },
        // NOTE: no operator choice reaches here — the config schema fences reasoningEffort to the
        // "openai" provider, because /v1/responses is OpenAI's endpoint and these servers mostly do
        // not implement it. What the plan still owns for them is the issue #66 pin, which applies
        // to a routed gpt-5.6 id just the same.
        planOpenAITransport(model, undefined),
      );
    case "openrouter":
      return makeOpenAIChat(
        {
          model,
          apiKey,
          temperature: openaiTemperature(model, temperature),
          configuration: { baseURL: cfg.baseURL || OPENROUTER_BASE_URL },
        },
        planOpenAITransport(model, undefined),
      );
    // NOTE: temperature is DROPPED for this provider, whoever set it. Anthropic's current generation
    // rejects any non-default value of `temperature`, `top_p` and `top_k` with a hard 400 ("`temperature`
    // is deprecated for this model"), and their migration guide for Sonnet 5 says to "remove these
    // parameters ... the default value (or omitting the parameter) is accepted". So this is not a
    // workaround for an error, it is the documented way to call the model: there is no sampling
    // control left to honor. Steering moved to the system prompt.
    //
    // Dropped by PROVIDER rather than by model pattern, unlike `openaiTemperature`, because there is
    // nothing reliable to match on. `claude-haiku-4-5` and `claude-sonnet-4-5` still accept the
    // parameter, `claude-opus-4-5` accepts it while advertising the same `effort` capability as every
    // model that refuses it, and /v1/models never mentions the parameter at all. A pattern would be a
    // copy of a vendor policy that moves without us, and the cost of being wrong is not symmetric:
    // the guardrail pass pins a temperature and is FAIL-OPEN, so one missed id is not a visible
    // error, it is a moderation control that approves everything (measured: `claude-sonnet-5` as the
    // guardrails model returned `violated: false` with a 400 attached, on every message).
    //
    // What the coarser rule costs is the operator's own value on the two models that still take it.
    // Measured on `claude-haiku-4-5`, the guardrail battery is identical with `temperature: 0` and
    // with the field absent: violations caught 16/16 in both arms, and on the output rewrite the
    // customer-facing price survived 16/16 while the internal cost leaked 0/16 in both. Nothing is
    // rewritten in storage either — the value stays as the operator set it, so the day Anthropic
    // takes the parameter back this line is all that has to go.
    case "anthropic":
      return new ChatAnthropic({ model, apiKey });
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
