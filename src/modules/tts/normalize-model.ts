import { MODEL_PROVIDERS, type ModelConfig } from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";

// WHICH model rewrites the reply for speech, on WHOSE key, at WHICH endpoint, and whether that
// configuration may run at all. One function answers all four, because they are one question: every
// wrong answer here is the same failure, a secret belonging to one vendor arriving at another.
//
// Three rounds of review found three different paths into that failure (the agent's key sent to a
// switched provider; the new key sent to the old gateway; a misspelled provider name silently
// falling back to the agent's while keeping the dedicated key). They were three symptoms of the
// resolution being spread across the runtime, the editor and the health check, each re-deriving it.
// It now lives here, and the editor projects THIS rather than re-implementing it.
//
// The shape of the rule:
//
//   * UNKNOWN provider (a name REST or MCP stored that is not a provider we support): nothing runs.
//     Falling back to the agent's provider while keeping the dedicated credential would send that
//     key to a vendor it does not belong to, which is how a typo becomes a leak.
//   * SAME provider (inherited, or named explicitly to attach a separate key on the same vendor):
//     each unset field falls back to the agent's, field by field. This is the case the feature
//     exists for, and it is what keeps an install that touches nothing behaving as before.
//   * DIFFERENT provider: nothing is inherited, because everything the agent holds belongs to the
//     old vendor. The model would be an id the new one refuses, the endpoint would send the NEW key
//     to the OLD gateway, and the KEY would hand one vendor's secret to another.
//
// And the credential, which is the part that decides whether a switched provider runs at all:
//
//   * `own`   — a credential was configured for the rewrite. Always allowed.
//   * `agent` — the agent's own key, allowed ONLY while the provider is unchanged (same vendor,
//               same account).
//   * `none`  — no key travels at all. Reachable only for `openai-compatible`, which authenticates
//               through its base URL (a local llama.cpp-style server has no key). Without this the
//               only way to run a local rewrite would be to invent a dummy vault entry.

export interface NormalizeModelSource {
  provider: string;
  model: string;
  // NOTE: null and undefined both mean "unset" here: the settings readers store null, ModelConfig
  // carries undefined, and this sits between the two.
  baseURL: string | null | undefined;
}

// The four overrides, as either transport spells them: `TtsConfig` (nullable, from the settings
// reader) and the editor's `TtsFormState` (blank strings) are both assignable to this.
export interface NormalizeOverrides {
  normalizeProvider?: string | null;
  normalizeModel?: string | null;
  normalizeCredentialRef?: string | null;
  normalizeBaseURL?: string | null;
}

export type NormalizeCredentialSource = "own" | "agent" | "none";

export type NormalizeNotRunnableReason =
  // A provider name we do not support. Never falls back, never carries the credential.
  | "provider_unknown"
  // A provider the agent does not use, with no key of its own and no endpoint to authenticate by.
  | "provider_without_credential"
  // openai-compatible with no base URL anywhere: createChatModel refuses it, and an unguarded build
  // would throw inside the TTS branch and cost the customer the whole voice note.
  | "endpoint_missing";

export interface NormalizeModelResolution {
  provider: string;
  model: string;
  baseURL: string | null;
  // False when the saved configuration must not be built at all. The caller skips the rewrite (the
  // audio still goes out, from the raw text) and records the reason.
  runnable: boolean;
  reason?: NormalizeNotRunnableReason;
  credential: NormalizeCredentialSource;
}

function str(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const NOT_RUNNABLE = (
  provider: string,
  reason: NormalizeNotRunnableReason,
): NormalizeModelResolution => ({
  provider,
  model: "",
  baseURL: null,
  runnable: false,
  reason,
  credential: "none",
});

export interface ResolveNormalizeOptions {
  // The base URL stored ON the rewrite's own credential, which outranks the typed field the same way
  // it does everywhere else in the tree. The runtime reads it from the vault; the editor gets it
  // from the credential picker.
  ownCredentialBaseURL?: string | null;
  // What counts as a usable endpoint. The runtime only cares that something is there (an endpoint it
  // cannot parse is the provider's problem to report); the editor passes a stricter http(s) check so
  // it can refuse the save before the fact. Same rule, two strictnesses, one implementation.
  isUsableBaseURL?: (raw: string) => boolean;
}

export function resolveNormalizeModel(
  tts: NormalizeOverrides,
  agent: NormalizeModelSource,
  opts: ResolveNormalizeOptions = {},
): NormalizeModelResolution {
  const usable = opts.isUsableBaseURL ?? ((raw: string) => raw.trim() !== "");
  const raw = str(tts.normalizeProvider);
  if (raw !== null && !(MODEL_PROVIDERS as readonly string[]).includes(raw)) {
    return NOT_RUNNABLE(raw, "provider_unknown");
  }
  const provider = raw ?? agent.provider;
  const switched = provider !== agent.provider;
  const own = str(tts.normalizeCredentialRef) !== null;

  const ownBaseURL =
    str(opts.ownCredentialBaseURL) ?? str(tts.normalizeBaseURL);
  const baseURL = switched ? ownBaseURL : (ownBaseURL ?? str(agent.baseURL));
  const hasEndpoint = baseURL !== null && usable(baseURL);

  // An endpoint is not a courtesy for openai-compatible: it IS the address, and the credential can
  // be nothing more than that address. Both checks below hang off it.
  if (provider === "openai-compatible" && !hasEndpoint) {
    return NOT_RUNNABLE(provider, "endpoint_missing");
  }

  let credential: NormalizeCredentialSource;
  if (own) {
    credential = "own";
  } else if (!switched) {
    credential = "agent";
  } else if (provider === "openai-compatible") {
    // Guaranteed to have an endpoint by the check above, and that endpoint is the whole credential.
    credential = "none";
  } else {
    return NOT_RUNNABLE(provider, "provider_without_credential");
  }

  return {
    provider,
    model:
      str(tts.normalizeModel) ??
      (switched
        ? (PROVIDER_DEFAULT_MODEL[provider as ModelConfig["provider"]] ?? "")
        : agent.model),
    baseURL,
    runnable: true,
    credential,
  };
}
