import { MODEL_PROVIDERS, type ModelConfig } from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import type { TtsConfig } from "./settings";

// WHICH model rewrites the reply for speech. The normalizer is a second, cheaper job than answering
// the customer (it restructures an answer that already exists), so the operator can point it at its
// own model without touching the agent's. Every field is an INDEPENDENT override that falls back to
// the agent's own model config, because the common case is "same account, cheaper model" and forcing
// a full four-field setup to express that would make the feature not worth turning on.
//
// The one place the fallback is not field-by-field is the model name, and only when the provider
// actually CHANGES: inheriting the agent's model name would send an OpenAI model id to Anthropic, so
// there the empty model resolves to the new provider's default instead (the #94 lesson: an empty name
// travels verbatim and the provider refuses the call, so "" is never a safe thing to send). Naming
// the SAME provider explicitly, which is what picking a separate credential on the same vendor looks
// like, keeps inheriting the agent's model: swapping the key is not a request to swap the model.
//
// A provider override with no credential of its own is left alone deliberately: it reaches the
// provider with the agent's key, fails 401, and the turn falls back to the raw text with a `normalize`
// warn on the Logs. That is a visible misconfiguration, which is better than this function silently
// deciding the operator did not mean what they saved. The editor flags it before it can happen.

export interface NormalizeModelSource {
  provider: string;
  model: string;
  // NOTE: null and undefined both mean "unset" here: the settings readers store null, ModelConfig
  // carries undefined, and this sits between the two.
  baseURL: string | null | undefined;
}

function str(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function resolveNormalizeModel(
  tts: TtsConfig,
  agent: NormalizeModelSource,
): NormalizeModelSource {
  const raw = str(tts.normalizeProvider);
  const override =
    raw && (MODEL_PROVIDERS as readonly string[]).includes(raw) ? raw : null;
  const provider = override ?? agent.provider;
  const switched = provider !== agent.provider;
  const model =
    str(tts.normalizeModel) ??
    (switched
      ? (PROVIDER_DEFAULT_MODEL[provider as ModelConfig["provider"]] ?? "")
      : agent.model);
  return {
    provider,
    model,
    baseURL: str(tts.normalizeBaseURL) ?? agent.baseURL,
  };
}
