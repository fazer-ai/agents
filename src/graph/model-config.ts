import { z } from "zod";
import { AppError } from "@/lib/errors";
import { modelOptionalFor } from "./model-defaults";
import { REASONING_EFFORTS } from "./openai-reasoning";
import {
  PROMPT_CACHE_MODES,
  PROMPT_CACHE_TTLS,
  PROVIDERS_WITH_PROMPT_CACHE,
} from "./prompt-cache";

// Per-agent/per-node model config SCHEMA, deliberately LangChain-free so the config/HTTP layer
// can validate a modelConfig without importing the provider SDKs (those live in ./models, which
// builds the actual chat model on top of this).

export const MODEL_PROVIDERS = [
  "openai",
  "openai-compatible",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
] as const;

// The providers whose adapter actually SENDS a configured endpoint. The rest accept one and drop it
// silently (deepseek keeps api.deepseek.com; openai, anthropic and google carry it nowhere), turning
// "route through my proxy" into "send straight to the vendor" with the customer's text, so a caller
// with an endpoint to honor asks here first. tests/graph/model-endpoint-support.test.ts probes each
// built instance, so this list cannot drift from what createChatModel does.
export const PROVIDERS_HONORING_BASE_URL = [
  "openai-compatible",
  "openrouter",
] as const;

// How each provider is asked for a schema-constrained answer, if at all: a claim about the ENDPOINT,
// never the model, read by the guardrail verdict (modules/guardrails/verdict.ts). openai and
// anthropic take json-schema (a `strict` json_schema; a forced tool call); google takes the OpenAPI
// 3.0 subset (asked in json-schema it answers 400 and the analysis is redone in prose, two calls per
// screen); deepseek implements only `json_object`; openrouter's support is per endpoint behind the
// router and changes without notice; openai-compatible is arbitrary, and a server that ignores the
// parameter makes the client retry for a minute. A row wrongly on "prose" costs nothing; one in the
// wrong dialect pays a refusal on every screen.
export type VerdictAskMode = "prose" | "json-schema" | "openapi";

const VERDICT_ASK_MODE: Record<
  (typeof MODEL_PROVIDERS)[number],
  VerdictAskMode
> = {
  openai: "json-schema",
  anthropic: "json-schema",
  google: "openapi",
  deepseek: "prose",
  openrouter: "prose",
  "openai-compatible": "prose",
};

export function verdictAskMode(
  provider: (typeof MODEL_PROVIDERS)[number],
): VerdictAskMode {
  return VERDICT_ASK_MODE[provider];
}

export const modelConfigSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS),
    // Empty (or absent) means "the server's default model" and is valid ONLY for
    // openai-compatible: single-model servers (llama.cpp) ignore the requested name, so forcing a
    // pick there is pure friction. Every other provider requires an explicit model.
    model: z.string().default(""),
    // Vault reference (`vault:<id>`) for the API key, never the key and never an entry name:
    // `vaultRefWhere` turns anything else into a filter that matches nothing, so the runtime
    // finds no credential and the agent produces nothing. Refused at the write boundary.
    credentialRef: z.string().min(1).optional(),
    baseURL: z.string().url().optional(),
    temperature: z.number().min(0).max(2).optional(),
    // How much the model may reason before answering. Absent = the provider's own default.
    // See ./openai-reasoning for the table behind the values and the transport.
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    // Prompt caching on the providers that only cache what the request marks (./prompt-cache).
    // Absent = `auto` there. The two TTLs are apart because the two spans repeat at different rates:
    // the prefix (tools + system) is shared by every conversation of the agent, the conversation
    // tail only by the next turn of the same customer. Absent conversation TTL follows the prefix.
    promptCache: z.enum(PROMPT_CACHE_MODES).optional(),
    promptCacheTtl: z.enum(PROMPT_CACHE_TTLS).optional(),
    promptCacheConversationTtl: z.enum(PROMPT_CACHE_TTLS).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.model.trim() && !modelOptionalFor(cfg.provider)) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "model is required for this provider",
      });
    }
    // NOTE: any effort above "none" needs /v1/responses, OpenAI's own endpoint: OpenAI-shaped servers
    // (openrouter, openai-compatible) mostly do not implement it, and the other providers spell
    // reasoning differently (Anthropic thinking budgets, Google thinkingBudget). Accepting the field
    // there would be a control that either does nothing or fails every turn.
    if (cfg.reasoningEffort !== undefined && cfg.provider !== "openai") {
      ctx.addIssue({
        code: "custom",
        path: ["reasoningEffort"],
        message: `reasoningEffort is only supported on the "openai" provider, not "${cfg.provider}"`,
      });
    }
    // OpenAI and the rest cache a repeated prefix on their own, so the fields would be a control
    // that does nothing there, the same reason reasoningEffort is refused off "openai".
    const cacheFields = [
      "promptCache",
      "promptCacheTtl",
      "promptCacheConversationTtl",
    ] as const;
    if (
      !(PROVIDERS_WITH_PROMPT_CACHE as readonly string[]).includes(cfg.provider)
    ) {
      for (const f of cacheFields)
        if (cfg[f] !== undefined)
          ctx.addIssue({
            code: "custom",
            path: [f],
            message: `${f} is only supported on the ${PROVIDERS_WITH_PROMPT_CACHE.map((p) => `"${p}"`).join(" and ")} providers, not "${cfg.provider}"`,
          });
    }
    // NOTE: the API refuses a longer TTL after a shorter one, and the prefix comes first, so a 1h
    // conversation behind a 5m prefix would fail every call.
    if (
      cfg.promptCacheConversationTtl === "1h" &&
      (cfg.promptCacheTtl ?? "5m") === "5m"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["promptCacheConversationTtl"],
        message:
          'promptCacheConversationTtl "1h" needs promptCacheTtl "1h": a longer cache TTL cannot follow a shorter one',
      });
    }
  });

export type ModelConfig = z.infer<typeof modelConfigSchema>;

// Default config applied to newly created agents when the caller doesn't send one
// (the operator still needs to pick a credential before the agent can run).
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "openai",
  model: "gpt-5.6-luna",
  temperature: 0.7,
};

export function parseModelConfig(raw: unknown): ModelConfig {
  const parsed = modelConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      `invalid agent model config: ${parsed.error.message}`,
      400,
    );
  }
  return parsed.data;
}
