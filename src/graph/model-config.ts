import { z } from "zod";
import { AppError } from "@/lib/errors";
import { modelOptionalFor } from "./model-defaults";
import { REASONING_EFFORTS } from "./openai-reasoning";

// Per-agent/per-node model config SCHEMA — deliberately LangChain-free so the config/HTTP layer
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
// without a word — measured on the built instances: deepseek keeps its own api.deepseek.com, and
// openai/anthropic/google carry the value nowhere at all. That turns "route this through my proxy"
// into "send it straight to the vendor", with the customer's text, which is why a caller that has an
// endpoint to honor must ask here first rather than pass it and hope.
//
// NOTE: tests/graph/model-endpoint-support.test.ts probes each built instance, so this list cannot
// drift away from what createChatModel does.
export const PROVIDERS_HONORING_BASE_URL = [
  "openai-compatible",
  "openrouter",
] as const;

// How each provider is asked for a schema-constrained answer, or that it is not asked at all. A
// claim about the ENDPOINT, never about how capable the model is, and every row was measured or
// read off the vendor's own documentation. The consumer today is the guardrail verdict
// (modules/guardrails/verdict.ts, issue #131):
//
//   * openai and anthropic take the json-schema dialect: a `strict` json_schema on one, a forced
//     tool call on the other;
//   * google takes the OpenAPI 3.0 subset instead, where `type` holds one value and nullability is
//     `nullable: true`. Measured live on gemini-3.5-flash and -flash-lite: asked in the json-schema
//     dialect the request comes back 400 and the analysis is remade in prose, so every screen costs
//     two calls; asked in this one, a single call answers;
//   * deepseek implements `json_object` only, and answers "unavailable now" to a json_schema;
//   * openrouter's support is per ENDPOINT behind the router and changes without notice, so the
//     same model id constrains today and fails the request tomorrow;
//   * openai-compatible is an arbitrary server by definition. Measured against a local one that
//     ignores the parameter: the client retried the same call six times across a minute and never
//     settled, while the unconstrained call made today answered on the first try. One that refuses
//     it outright (llama.cpp does, with a 400) fails immediately.
//
// Getting a row wrong is not symmetric. A provider wrongly on "prose" keeps exactly today's
// behaviour; one asked in the wrong dialect pays a refusal on every screen, and only survives it
// because the analysis is remade in prose when a request comes back refused.
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
    // finds no credential and the agent produces nothing. Refused at the write boundary (#254).
    credentialRef: z.string().min(1).optional(),
    baseURL: z.string().url().optional(),
    temperature: z.number().min(0).max(2).optional(),
    // How much the model may reason before answering. Absent = whatever the provider does today.
    // See ./openai-reasoning for the measured table behind the values and the transport.
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.model.trim() && !modelOptionalFor(cfg.provider)) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "model is required for this provider",
      });
    }
    // Any effort above "none" needs /v1/responses, which is OpenAI's own endpoint: OpenAI-shaped
    // servers (openrouter, openai-compatible) mostly do not implement it, and the other providers
    // spell reasoning differently altogether (Anthropic thinking budgets, Google thinkingBudget).
    // Accepting the field there would be a control that either does nothing or fails every turn.
    if (cfg.reasoningEffort !== undefined && cfg.provider !== "openai") {
      ctx.addIssue({
        code: "custom",
        path: ["reasoningEffort"],
        message: `reasoningEffort is only supported on the "openai" provider, not "${cfg.provider}"`,
      });
    }
  });

export type ModelConfig = z.infer<typeof modelConfigSchema>;

// Default config applied to newly created agents when the caller doesn't send one
// (the operator still needs to pick a credential before the agent can run).
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "openai",
  model: "gpt-5.4-mini",
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
