import { MODEL_FALLBACK_RANGES } from "@/modules/agents/number-ranges";
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
  // How long each attempt may take, the primary's and the fallback's, in ms. null =
  // MODEL_FALLBACK_TIMEOUT_DEFAULT_MS. Read only while a fallback exists: with none, the call keeps
  // its retries under `config.agent.modelCallTimeoutMs`.
  timeoutMs: number | null;
}

// The ceiling before this was configurable, kept as the default (see ./model-fallback). Here, not
// there, because the editor reads it and ./model-fallback pulls in the provider-failure module.
export const MODEL_FALLBACK_TIMEOUT_DEFAULT_MS = 45_000;

// The reader's clamp, for a value stored before the schema refused it. The range itself lives with
// every other configurable number (MODEL_FALLBACK_RANGES).
export const MODEL_FALLBACK_TIMEOUT_RANGE_MS = [
  MODEL_FALLBACK_RANGES.timeoutMs.min,
  MODEL_FALLBACK_RANGES.timeoutMs.max,
] as const;

export function clampModelFallbackTimeout(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const [min, max] = MODEL_FALLBACK_TIMEOUT_RANGE_MS;
  return Math.min(max, Math.max(min, Math.round(value)));
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
    timeoutMs: clampModelFallbackTimeout(f.timeoutMs),
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
