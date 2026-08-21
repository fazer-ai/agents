import { z } from "zod";
import { AppError } from "@/lib/errors";
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

// The providers a call may ask for a SCHEMA-CONSTRAINED answer, instead of asking in the prompt and
// reading the answer out of prose (see modules/guardrails/verdict.ts, issue #131). This is a claim
// about the endpoint, never about how capable the model is, and each exclusion below was measured
// or read off the vendor's own documentation:
//
//   * deepseek implements `json_object` only, and answers "unavailable now" to a json_schema;
//   * openrouter's support is per ENDPOINT behind the router and changes without notice, so the
//     same model id constrains today and fails the request tomorrow;
//   * openai-compatible is an arbitrary server by definition. Measured against a local one that
//     ignores the parameter: the client retried the same call six times across a minute and never
//     settled, while the unconstrained call made today answered on the first try. One that refuses
//     it outright (llama.cpp does, with a 400) fails immediately. Both of those are a guardrail
//     that stops screening, on installs where it screens fine today;
//   * google is out over a dialect, not a missing feature. Gemini's responseSchema is the OpenAPI
//     3.0 subset, where `type` holds ONE value and nullability is `nullable: true`, and the adapter
//     forwards a `type: ["string", "null"]` unconverted (measured on the wire). The other dialect
//     is not a shared answer either: asked with `nullable`, OpenAI ignores the keyword and the
//     field becomes a required string, so the model is pushed into inventing one — measured, 8 runs
//     on gpt-5.4-nano, `""` seven times and `"/"` once, on the direction whose whole rule is that
//     it must never compose a reply. One schema cannot serve both, and a per-vendor dialect is a
//     mechanism nobody here can exercise against the live endpoint yet.
//
// Getting a row wrong is not symmetric: a provider wrongly on this list stops screening, one
// wrongly off it keeps exactly today's behaviour. When in doubt, leave it off.
export const PROVIDERS_ACCEPTING_CONSTRAINED_OUTPUT = [
  "openai",
  "anthropic",
] as const;

export function acceptsConstrainedOutput(
  provider: (typeof MODEL_PROVIDERS)[number],
): boolean {
  return (PROVIDERS_ACCEPTING_CONSTRAINED_OUTPUT as readonly string[]).includes(
    provider,
  );
}

export const modelConfigSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS),
    // Empty (or absent) means "the server's default model" and is valid ONLY for
    // openai-compatible: single-model servers (llama.cpp) ignore the requested name, so forcing a
    // pick there is pure friction. Every other provider requires an explicit model.
    model: z.string().default(""),
    // Vault entry name holding the API key (resolved by the runtime, never stored here).
    credentialRef: z.string().min(1).optional(),
    baseURL: z.string().url().optional(),
    temperature: z.number().min(0).max(2).optional(),
    // How much the model may reason before answering. Absent = whatever the provider does today.
    // See ./openai-reasoning for the measured table behind the values and the transport.
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.model.trim() && cfg.provider !== "openai-compatible") {
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
