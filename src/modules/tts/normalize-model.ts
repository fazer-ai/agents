import {
  type ModelOverrideCredential,
  type ModelOverrideNotRunnableReason,
  type ModelOverrideResolution,
  type OverrideAgentModel,
  type ResolveModelOverrideOptions,
  resolveModelOverride,
} from "@/graph/model-override";

// The speech rewrite's own model, as an override of the agent's. The rule itself is not specific to
// speech — it is "which model does a secondary call run on, on whose key" — and lives in
// graph/model-override.ts, shared with the attendance summariser. This file is the spelling: the
// four overrides are stored on the `tts` block under `normalize*` names, and translating them is all
// that is left here.
//
// The names below are re-exported rather than renamed at the call sites because they are the ones
// the editor, the config-health projection and this module's own tests already speak.

export type NormalizeModelSource = OverrideAgentModel;
export type NormalizeCredentialSource = ModelOverrideCredential;
export type NormalizeNotRunnableReason = ModelOverrideNotRunnableReason;
export type NormalizeModelResolution = ModelOverrideResolution;
export type ResolveNormalizeOptions = ResolveModelOverrideOptions;

// The four overrides, as either transport spells them: `TtsConfig` (nullable, from the settings
// reader) and the editor's `TtsFormState` (blank strings) are both assignable to this.
export interface NormalizeOverrides {
  normalizeProvider?: string | null;
  normalizeModel?: string | null;
  normalizeCredentialRef?: string | null;
  normalizeBaseURL?: string | null;
}

export function resolveNormalizeModel(
  tts: NormalizeOverrides,
  agent: NormalizeModelSource,
  opts: ResolveNormalizeOptions = {},
): NormalizeModelResolution {
  return resolveModelOverride(
    {
      provider: tts.normalizeProvider,
      model: tts.normalizeModel,
      credentialRef: tts.normalizeCredentialRef,
      baseURL: tts.normalizeBaseURL,
    },
    agent,
    opts,
  );
}
