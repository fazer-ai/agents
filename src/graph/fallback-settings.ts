import { modelOptionalFor } from "./model-defaults";
import {
  type ModelOverrideResolution,
  type OverrideAgentModel,
  resolveModelOverride,
} from "./model-override";

// THE SECOND PROVIDER, as the operator stored it and as the runtime reads it back.
//
// Sibling of `modules/tts/normalize-model` and of the summariser's read in `modules/memory/compact`:
// all three name a model that is not the agent's own, and all three ask `resolveModelOverride` the
// same four questions, because the answer that matters is the one about whose key travels where.
//
// What is NOT shared is the meaning of "everything absent". For the rewrite and the summariser that
// means "run this on the agent's own model", which is the useful default that lets a feature ship on
// by default. Here it would mean falling back to the provider that just failed, so it means the
// opposite: no fallback exists, and the turn fails exactly as it does today.

export interface FallbackOverrides {
  provider?: string | null;
  model?: string | null;
  credentialRef?: string | null;
  baseURL?: string | null;
}

export interface FallbackConfig {
  provider: string | null;
  model: string | null;
  credentialRef: string | null;
  baseURL: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function readModelFallbackConfig(settings: unknown): FallbackConfig {
  const bag =
    settings && typeof settings === "object"
      ? ((settings as Record<string, unknown>).modelFallback ?? {})
      : {};
  const f = (bag && typeof bag === "object" ? bag : {}) as Record<
    string,
    unknown
  >;
  return {
    provider: str(f.provider),
    model: str(f.model),
    credentialRef: str(f.credentialRef),
    baseURL: str(f.baseURL),
  };
}

// A fallback exists once the operator named a DESTINATION, and the provider is what names it. Absent,
// `resolveModelOverride` would happily complete the destination from the agent's own config and
// produce the one configuration that must never exist: a second attempt against the provider that
// just answered 503, indistinguishable in the settings from a real fallback.
//
// The model is required on top of that for every provider that needs one, which is the repo's
// existing rule and not a rule of this block's own — `modelOptionalFor` is the single predicate the
// model config's schema and the editor's save guard read too. This asked for BOTH halves for one
// round, which made an `openai-compatible` fallback pointed at a single-model server impossible to
// configure: that server discards the model name it is sent, so the operator would have had to
// invent one, and the write boundary and the save gate were both refusing the empty field.
export function hasModelFallback(cfg: FallbackConfig): boolean {
  if (cfg.provider === null) return false;
  return cfg.model !== null || modelOptionalFor(cfg.provider);
}

export function resolveFallbackModel(
  cfg: FallbackConfig,
  agent: OverrideAgentModel,
  opts: { ownCredentialBaseURL?: string | null } = {},
): ModelOverrideResolution {
  return resolveModelOverride(
    {
      provider: cfg.provider,
      model: cfg.model,
      credentialRef: cfg.credentialRef,
      baseURL: cfg.baseURL,
    },
    agent,
    opts,
  );
}
