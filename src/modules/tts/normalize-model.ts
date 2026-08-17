import { MODEL_PROVIDERS, type ModelConfig } from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import type { TtsConfig } from "./settings";

// WHICH model rewrites the reply for speech, and whether that configuration may run at all. The
// rewrite is a cheaper job than answering the customer (it restructures an answer that already
// exists), so the operator can point it at its own model without touching the agent's.
//
// Everything here turns on ONE question: did the provider change?
//
//   * SAME provider (inherited, or named explicitly to attach a separate key on the same vendor):
//     every unset field falls back to the agent's, field by field. Swapping the key is not a request
//     to swap the model, and the agent's endpoint is the same vendor's endpoint. This is the case the
//     feature exists for, and it is what keeps an install that touches nothing behaving as before.
//
//   * DIFFERENT provider: nothing is inherited, because everything the agent holds belongs to the old
//     vendor. Inheriting the model name would send an OpenAI model id to Anthropic; inheriting the
//     endpoint would send the NEW key to the OLD gateway; and inheriting the KEY would transmit one
//     vendor's secret to another, which is a credential leak, not a 401. So a changed provider with
//     no credential of its own is refused outright (`runnable: false`) rather than run with the
//     agent's key, and an unset model resolves to the new provider's own default (the #94 lesson: an
//     empty name travels verbatim and the call is refused).
//
// The editor warns before any of this can be saved, but REST and MCP write the settings bag directly,
// so the refusal has to live here rather than in the UI.

export interface NormalizeModelSource {
  provider: string;
  model: string;
  // NOTE: null and undefined both mean "unset" here: the settings readers store null, ModelConfig
  // carries undefined, and this sits between the two.
  baseURL: string | null | undefined;
}

export interface NormalizeModelResolution extends NormalizeModelSource {
  // False when the saved configuration must not be built at all. The caller skips the rewrite (the
  // audio still goes out, from the raw text) and records the reason.
  runnable: boolean;
  reason?: "provider_without_credential";
  // Whether the call runs on the normalizer's OWN credential rather than the agent's.
  useOwnCredential: boolean;
}

function str(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function resolveNormalizeModel(
  tts: TtsConfig,
  agent: NormalizeModelSource,
): NormalizeModelResolution {
  const raw = str(tts.normalizeProvider);
  const named =
    raw && (MODEL_PROVIDERS as readonly string[]).includes(raw) ? raw : null;
  const provider = named ?? agent.provider;
  const switched = provider !== agent.provider;
  const own = str(tts.normalizeCredentialRef) !== null;
  if (switched && !own) {
    return {
      provider,
      model: "",
      baseURL: null,
      runnable: false,
      reason: "provider_without_credential",
      useOwnCredential: false,
    };
  }
  return {
    provider,
    model:
      str(tts.normalizeModel) ??
      (switched
        ? (PROVIDER_DEFAULT_MODEL[provider as ModelConfig["provider"]] ?? "")
        : agent.model),
    // A switched provider never inherits the agent's endpoint: only what was typed for the normalizer
    // itself (the credential's own baseUrl is layered on top of this by the caller).
    baseURL: str(tts.normalizeBaseURL) ?? (switched ? null : agent.baseURL),
    runnable: true,
    useOwnCredential: own,
  };
}
