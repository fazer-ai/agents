import { modelOptionalFor } from "./model-defaults";
import {
  type ModelOverrideResolution,
  type OverrideAgentModel,
  resolveModelOverride,
} from "./model-override";

// The second provider, as the operator stored it and as the runtime reads it back. Like
// `modules/tts/normalize-model` and the summariser's read in `modules/memory/compact`, it asks
// `resolveModelOverride` whose key travels where. Unlike them, "everything absent" cannot mean "run on
// the agent's own model", which here would retry the provider that just failed: it means no fallback
// exists and the turn fails as it would without one.

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

// A fallback exists once the operator named a destination, and the provider names it. Without one,
// `resolveModelOverride` would complete it from the agent's own config: a second attempt against the
// provider that just answered 503, indistinguishable in the settings from a real fallback. The model
// is also required unless `modelOptionalFor` (the predicate the schema and the editor's save guard
// share) says the provider needs none: a single-model `openai-compatible` server discards the name it
// is sent, so demanding one would make that fallback impossible to configure.
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
