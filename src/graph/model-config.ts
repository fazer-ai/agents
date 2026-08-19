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
  // NOTE: no temperature on purpose. It used to ship 0.7, which was inert where it shipped (the
  // model named here is a gpt-5, and `openaiTemperature` drops the parameter for that family) and
  // only came alive on a provider switch — where Anthropic's current models answer 400 to any
  // temperature and every turn fails. A value the operator never chose must not be the one that
  // breaks their agent, and the editor already creates agents with the field empty, so leaving it
  // unset is also what makes the API and the console agree.
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

// The temperature for the calls WE pin rather than the operator: the guardrail judge
// (`src/graph/runtime.ts`) and the TTS speech rewrite (`src/graph/prepare.ts`). Both want a
// deterministic pass over text that already exists, and neither is a preference anyone expressed.
//
// Anthropic is refused the parameter entirely instead of being pattern-matched. Its current
// generation answers 400 to ANY temperature (`claude-sonnet-5` and `claude-opus-5`: "`temperature`
// is deprecated for this model"; `claude-fable-5`: "not supported ... when set to non-default
// values"), while `claude-haiku-4-5` and `claude-sonnet-4-5` still accept it, and there is no way
// to ask which is which: the /v1/models capabilities never mention the parameter, and
// `claude-opus-4-5` carries the same `effort` capability as the models that reject it while
// accepting temperature. A model-name pattern would be a copy of a vendor policy that moves without
// us, and the cost of being wrong is not symmetric — guardrail analysis is fail-open, so a 400 on
// every call does not read as a broken guardrail, it reads as one that approves everything.
//
// What the blanket drop costs was measured rather than assumed. On `claude-haiku-4-5`, which does
// accept the parameter, the guardrail battery is identical with `temperature: 0` and with the field
// absent: violations caught 16/16 in both arms, and on the output rewrite the customer-facing price
// survived 16/16 while the internal cost leaked 0/16 in both. The operator's own temperature is not
// touched by this and still travels as they set it.
export function pinnedTemperature(
  provider: ModelConfig["provider"],
): 0 | undefined {
  return provider === "anthropic" ? undefined : 0;
}
