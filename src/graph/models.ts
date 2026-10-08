import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import logger from "@/api/lib/logger";
import { AppError } from "@/lib/errors";
import { toGeminiTools } from "./gemini-tools";
import type { ModelConfig } from "./model-config";
import {
  type OpenAITransportPlan,
  planOpenAITransport,
  type ReasoningEffort,
  toolEffortFloorOf,
} from "./openai-reasoning";
import { promptCacheFetch, resolvePromptCache } from "./prompt-cache";

// Per-agent/per-node model factory. The config SCHEMA lives in ./model-config (LangChain-free, so
// the config/HTTP layer validates without importing the provider SDKs); this module turns a
// validated config into a LangChain chat model. The API key is resolved from the vault by the
// caller, never inlined or logged here. An OpenAI-compatible endpoint is reached by setting
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
  // What one call on this model may spend; absent for every caller with no fallback behind it.
  // Absent keeps LangChain's AsyncCaller default (six retries, exponential backoff, no per-attempt
  // ceiling), which is wrong with a fallback behind the provider: one 5xx holds the turn for over a
  // minute. See ./model-fallback for the bounds.
  // A caller with nothing behind the provider bounds the whole CALL instead (callWithDeadline in
  // ./model-limit), because a per-attempt ceiling is retried like any other failure and the Google
  // adapter drops it.
  maxRetries?: number;
  timeoutMs?: number;
}

// The two bounds as each SDK family spells them, checked against the built instances
// (tests/graph/model-limits-transport.test.ts), never read off the option types:
//   maxRetries   all six providers, landing on `caller.maxRetries`
//   the ceiling  `timeout` on the four OpenAI-shaped clients, `clientOptions.timeout` on Anthropic
//                (its option type accepts a plain `timeout` and the instance drops it), and nowhere
//                on Google, whose adapter drops both spellings.
// The ceiling is the only bound a HANG has (no status for the retry count to act on), so on Google
// a hung endpoint still holds the turn and the fallback never gets it.
function limits(cfg: ResolvedModelConfig): {
  maxRetries?: number;
  timeout?: number;
} {
  return {
    ...(cfg.maxRetries !== undefined ? { maxRetries: cfg.maxRetries } : {}),
    ...(cfg.timeoutMs !== undefined ? { timeout: cfg.timeoutMs } : {}),
  };
}

// OpenRouter is OpenAI-compatible with a fixed API root, so it reuses the ChatOpenAI client with this
// base URL instead of asking the operator for one (unlike the generic "openai-compatible" provider).
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// OpenAI's reasoning families reject any non-default `temperature` with a hard 400, which kills
// every call that pins one (the agent turn, the guardrail pass, TTS normalization), so the parameter
// is dropped for those models rather than clamped, and only on the OpenAI-shaped clients. Matches a
// bare id ("o4-mini", "gpt-5-mini"), a routed one ("openai/o4-mini"), and a fine-tune ("ft:<base>:…",
// whose base decides the rules; DEFAULT_MODEL_CONFIG ships a temperature). "gpt-4o", "omni-…",
// "gpt-60" and "gpt-6x" do not match. gpt-5-chat*/gpt-6-chat are the non-reasoning chat families and
// keep the operator's temperature (the same carve-out as @langchain/openai's isReasoningModel).
const REASONING_MODEL_RE =
  /^(?:ft:)?(?:[\w.-]+\/)?(?:o\d+(?:-|$)|gpt-5(?!-chat)|gpt-6(?:[.-]|$)(?!chat))/i;

function openaiTemperature(
  model: string,
  temperature: number | undefined,
): number | undefined {
  return REASONING_MODEL_RE.test(model.trim()) ? undefined : temperature;
}

type OpenAIChatFields = ConstructorParameters<typeof ChatOpenAI>[0];

// Whether this call will talk to /v1/responses. @langchain/openai decides that from the model id
// (case-sensitive substrings anywhere in it, so a fine-tune's free-text suffix can flip it) AND from
// the call (built-in or custom tools, Responses-only options), so the instance is asked with the SAME
// options the call carries rather than a copy of those rules guessed here. `invocationParams` returns
// what will be sent, and the two endpoints name the token cap differently (`max_output_tokens` on
// Responses, `max_completion_tokens` on Completions).
function usesResponsesEndpoint(chat: ChatOpenAI, options: unknown): boolean {
  return "max_output_tokens" in chat.invocationParams(options as never);
}

// Builds an OpenAI-shaped client from the transport plan (see ./openai-reasoning for why the
// endpoint, not the model family, decides). The plan can send a call to /v1/responses but cannot keep
// one off it: @langchain/openai also routes there on its own, by model id and by call options. So
// what the plan owes is written for whichever endpoint the call lands on: `store: false` on every
// instance (it only reaches /v1/responses, which stores for 30 days by default where completions
// stores nothing), and the tool-effort pin in that endpoint's spelling.
function makeOpenAIChat(
  fields: OpenAIChatFields,
  plan: OpenAITransportPlan,
): ChatOpenAI {
  const withPlan: OpenAIChatFields = {
    ...fields,
    // NOTE: this only sends `store: false`; it does not enable zero data retention on the account.
    zdrEnabled: true,
    ...(plan.responses
      ? {
          useResponsesApi: true,
          // NOTE: efforts travel via `modelKwargs`, not the typed fields, because @langchain/openai
          // sends those only for ids it recognises by NAME, which drops a routed or fine-tuned
          // reasoning model's effort in silence. modelKwargs is always sent and the typed path
          // writes the same value, so they never disagree. A model with no reasoning to constrain
          // answers 400 naming the parameter, which is the outcome the operator can act on. It also
          // carries "max", which the live API accepts on gpt-5.6 and the installed SDK type omits.
          modelKwargs: {
            ...fields?.modelKwargs,
            reasoning: { effort: plan.effort },
          },
        }
      : {}),
  };
  const chat = new ChatOpenAI(withPlan);
  if (!plan.toolEffort) return chat;
  // `toolEffort` (only set when nobody chose an effort and the provider's default breaks
  // function tools) is pinned on the bindTools of two more instances, one per spelling, so it
  // reaches only tool-bound calls. The raw instance (the final answer when the tool budget runs out,
  // the guardrail pass, TTS normalization, an agent with no grants) works at the provider default,
  // so pinning it on the constructor would switch reasoning off where nothing required it.
  const pinned = (modelKwargs: Record<string, unknown>) =>
    new ChatOpenAI({
      ...withPlan,
      modelKwargs: { ...withPlan?.modelKwargs, ...modelKwargs },
    });
  type BindTools = typeof chat.bindTools;
  const onCompletions = pinned({ reasoning_effort: plan.toolEffort });
  const onResponses = pinned({ reasoning: { effort: plan.toolEffort } });
  const bindCompletions = onCompletions.bindTools.bind(
    onCompletions,
  ) as BindTools;
  const bindResponses = onResponses.bindTools.bind(onResponses) as BindTools;
  const bindPinned = ((tools, kwargs) =>
    usesResponsesEndpoint(chat, { ...kwargs, tools })
      ? bindResponses(tools, kwargs)
      : bindCompletions(tools, kwargs)) as BindTools;
  // A model that refuses the pin itself (see `toolEffortFloorOf`) gets the lowest effort it named
  // instead, on /v1/responses: completions refuses every effort above "none" alongside tools. Learned
  // from the first refusal and kept for the process: the call that met it is answered by a second
  // request on that shape, and every later call goes there directly. Read per call, not per bind,
  // because the graph binds once per turn and calls once per round of tool calls. Only `invoke` does
  // this, being the only method the graph calls on a bound model.
  const key = `${fields?.configuration?.baseURL ?? ""} ${fields?.model ?? ""}`;
  const bindFloor = (floor: ReasoningEffort): BindTools => {
    const onFloor = new ChatOpenAI({
      ...withPlan,
      useResponsesApi: true,
      modelKwargs: { ...withPlan?.modelKwargs, reasoning: { effort: floor } },
    });
    return onFloor.bindTools.bind(onFloor) as BindTools;
  };
  chat.bindTools = ((tools, kwargs) => {
    const bound = bindPinned(tools, kwargs);
    const invoke = bound.invoke.bind(bound);
    bound.invoke = (async (input, options) => {
      const known = toolEffortFloors.get(key);
      if (known) return bindFloor(known)(tools, kwargs).invoke(input, options);
      try {
        return await invoke(input, options);
      } catch (err) {
        const floor = toolEffortFloorOf(err);
        if (floor === null) throw err;
        if (!toolEffortFloors.has(key)) {
          logger.warn(
            { model: fields?.model, effort: floor },
            "the model refuses reasoning effort none with tools; its tool calls run at the lowest effort it accepts",
          );
        }
        toolEffortFloors.set(key, floor);
        return bindFloor(floor)(tools, kwargs).invoke(input, options);
      }
    }) as typeof bound.invoke;
    return bound;
  }) as BindTools;
  return chat;
}

// What each model refused the tool pin with, keyed by endpoint and model id. Per process: a restart
// pays one refused request per model, which is cheaper than a list of model ids to keep.
const toolEffortFloors = new Map<string, ReasoningEffort>();

export function forgetToolEffortFloorsForTest(): void {
  toolEffortFloors.clear();
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
          ...limits(cfg),
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
          ...limits(cfg),
          configuration: { baseURL: cfg.baseURL },
        },
        // NOTE: no operator effort reaches here: the config schema fences reasoningEffort to the
        // "openai" provider, because these servers mostly do not implement /v1/responses. The plan
        // still owns the tool-effort pin, which applies to a routed gpt-5.6 id just the same.
        planOpenAITransport(model, undefined),
      );
    case "openrouter": {
      const cache = resolvePromptCache(cfg);
      return makeOpenAIChat(
        {
          model,
          apiKey,
          temperature: openaiTemperature(model, temperature),
          ...limits(cfg),
          configuration: {
            baseURL: cfg.baseURL || OPENROUTER_BASE_URL,
            // NOTE: only a Claude model behind OpenRouter gets marks (./prompt-cache); the others
            // cache on their own and the request goes out untouched.
            ...(cache
              ? { fetch: promptCacheFetch(cache, "chat-completions") }
              : {}),
          },
        },
        planOpenAITransport(model, undefined),
      );
    }
    // NOTE: temperature is DROPPED for this provider, whoever set it. Anthropic's current generation
    // rejects any non-default `temperature`, `top_p` and `top_k` with a hard 400, and its migration
    // guide says to omit them. It is dropped by PROVIDER, not by model pattern, because no field
    // tells the models apart and a missed id is invisible: the guardrail pass pins a temperature and
    // is fail-open, so a 400 there approves everything. On the older models that still accept it,
    // omitting it leaves the guardrail results unchanged. The stored value is kept as the operator
    // set it, so if Anthropic takes the parameter back this line is all that has to go.
    case "anthropic": {
      const cache = resolvePromptCache(cfg);
      // `clientOptions`, not the plain `timeout` the OpenAI-shaped clients take: the option
      // type accepts `timeout` and the built instance leaves it undefined.
      const clientOptions = {
        ...(cfg.timeoutMs !== undefined ? { timeout: cfg.timeoutMs } : {}),
        // Anthropic caches only what the request marks (./prompt-cache).
        ...(cache ? { fetch: promptCacheFetch(cache, "anthropic") } : {}),
      };
      return new ChatAnthropic({
        model,
        apiKey,
        ...(cfg.maxRetries !== undefined ? { maxRetries: cfg.maxRetries } : {}),
        ...(Object.keys(clientOptions).length > 0 ? { clientOptions } : {}),
      });
    }
    case "google": {
      const gemini = new ChatGoogleGenerativeAI({
        model,
        apiKey,
        temperature,
        // NOTE: no ceiling here in either spelling, because this adapter drops both. Picked apart
        // rather than passed whole so the omission is visible.
        ...(cfg.maxRetries !== undefined ? { maxRetries: cfg.maxRetries } : {}),
      });
      // The adapter declares tool parameters in the OpenAPI subset, whose closed field set
      // rejects the whole request over one unknown key; ./gemini-tools redeclares them as JSON
      // Schema. Patched on the INSTANCE, not by subclassing: LangChain derives the serialized model
      // id from the constructor name, so a subclass renames the model in every Langfuse payload.
      // An own property also shadows the prototype for the adapter's internal `this.bindTools`.
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
      return new ChatDeepSeek({ model, apiKey, temperature, ...limits(cfg) });
    default:
      throw new AppError(`unknown model provider: ${cfg.provider}`, 400);
  }
}
