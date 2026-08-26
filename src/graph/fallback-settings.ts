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

// A fallback exists only when the operator named BOTH halves of a destination. Half a destination is
// what `resolveModelOverride` would happily complete from the agent's own config, and completing it
// here produces the one configuration that must never exist: a second attempt against the provider
// that just answered 503, indistinguishable in the settings from a real fallback.
export function hasModelFallback(cfg: FallbackConfig): boolean {
  return cfg.provider !== null && cfg.model !== null;
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
