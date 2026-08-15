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
