import { TTS_PROVIDERS } from "@/client/lib/providerDefaults";
import type { ModelOverride } from "@/graph/model-override";
import type {
  NormalizeModelResolution,
  NormalizeOverrides,
} from "@/modules/tts/normalize-model";
import {
  clampVoiceSetting,
  readVoiceSettings,
  TTS_DEFAULTS,
  TTS_MODES,
  type TtsMode,
} from "@/modules/tts/settings-shared";
import {
  type AgentModelSource,
  overrideBaseUrlInvalid,
  overrideBaseUrlUnsupported,
  overrideNeedsOwnCredential,
  overridePicked,
  overridePickerSource,
  overrideProviderChanged,
  overrideResolution,
} from "./modelOverrideForm";

// The agent editor's TTS block, as a pair of pure functions: stored settings → form state → stored
// settings. It lives outside the page because the Behavior save REPLACES the whole `tts` block with
// what the form holds, so a field the form does not carry is not merely un-editable, it is DELETED on
// the next save. That happened to `normalizeBaseURL`, which the REST and MCP transports accept: the
// round-trip test over this pair is what makes the next one impossible to add silently.

export interface TtsFormState {
  mode: string;
  provider: string;
  model: string;
  voice: string;
  credentialRef: string;
  // No field in the form renders this one: none of the TTS providers is openai-compatible, so only
  // REST/MCP set it (a proxy in front of the vendor). It is carried anyway because the save replaces
  // the block, and a value the form drops is a value the next save deletes.
  baseURL: string;
  normalize: boolean;
  normalizeProvider: string;
  normalizeModel: string;
  normalizeCredentialRef: string;
  normalizeBaseURL: string;
  // Numeric knobs are strings in the form (an empty one means "leave it to the provider", which
  // Number("") would turn into 0).
  stability: string;
  similarityBoost: string;
  style: string;
  speed: string;
  speakerBoost: boolean | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): string {
  return typeof v === "number" ? String(v) : "";
}

function numOrNull(v: string): number | null {
  const n = Number(v.trim());
  return v.trim() && Number.isFinite(n) ? n : null;
}

export function readTtsFormState(block: unknown): TtsFormState {
  const tt = (block ?? {}) as Record<string, unknown>;
  // The delivery knobs are hydrated through the RUNTIME's reader, not off the raw bag: REST and
  // import store whatever they are handed, and synthesis clamps it on the way out. Reading the raw
  // number would put a 9 on screen for a voice that speaks at 4, with nothing admitting the
  // difference, and it would stay there, since nothing rewrites the bag until the tab is saved.
  const voice = readVoiceSettings(tt);
  // Mode and provider are ALLOWLISTED, exactly as the runtime reader allowlists them. A bag can
  // carry anything (REST and import store what they are handed, and "Mirror" is one keystroke from
  // "mirror"): the runtime falls back to "never" and to openai, while a raw value here puts an
  // empty `<select>` on screen above a fully-rendered audio section for an agent that will never
  // send audio, and saves the same string straight back.
  const mode = str(tt.mode);
  const provider = str(tt.provider);
  return {
    mode: mode && TTS_MODES.includes(mode as TtsMode) ? mode : "never",
    provider:
      provider && (TTS_PROVIDERS as readonly string[]).includes(provider)
        ? provider
        : "openai",
    model: str(tt.model),
    voice: str(tt.voice),
    credentialRef: str(tt.credentialRef),
    baseURL: str(tt.baseURL),
    normalize:
      typeof tt.normalize === "boolean" ? tt.normalize : TTS_DEFAULTS.normalize,
    normalizeProvider: str(tt.normalizeProvider),
    normalizeModel: str(tt.normalizeModel),
    normalizeCredentialRef: str(tt.normalizeCredentialRef),
    normalizeBaseURL: str(tt.normalizeBaseURL),
    stability: num(voice.stability),
    similarityBoost: num(voice.similarityBoost),
    style: num(voice.style),
    speed: num(voice.speed),
    speakerBoost: voice.speakerBoost ?? null,
  };
}

export function ttsSettingsFrom(tts: TtsFormState): Record<string, unknown> {
  return {
    mode: tts.mode,
    provider: tts.provider,
    model: tts.model.trim(),
    voice: tts.voice.trim(),
    credentialRef: tts.credentialRef || null,
    baseURL: tts.baseURL.trim() || null,
    normalize: tts.normalize,
    normalizeProvider: tts.normalizeProvider || null,
    normalizeModel: tts.normalizeModel.trim() || null,
    normalizeCredentialRef: tts.normalizeCredentialRef || null,
    normalizeBaseURL: tts.normalizeBaseURL.trim() || null,
    // NOTE: blank clears the knob (null), so the operator can hand a field back to the provider
    // after having set it. The clamp is the READER's, applied here too because the save persists
    // what the form holds, and what the form holds is whatever was TYPED: without this the bag
    // would carry a number synthesis never uses, out to every other reader of it (MCP, export).
    stability: clampVoiceSetting("stability", numOrNull(tts.stability)),
    similarityBoost: clampVoiceSetting(
      "similarityBoost",
      numOrNull(tts.similarityBoost),
    ),
    style: clampVoiceSetting("style", numOrNull(tts.style)),
    speed: clampVoiceSetting("speed", numOrNull(tts.speed)),
    speakerBoost: tts.speakerBoost,
  };
}

// Switching the rewrite's provider invalidates everything that was picked FOR the old one: the model
// id (another vendor refuses it), the API key (same), and the base URL, which is the dangerous one
// because its field only renders for openai-compatible. Left behind, it keeps steering the new
// provider's client at an endpoint the operator can no longer see, and the rewrite fails or hangs.
// The rule these project is not specific to speech — "which model does a secondary call run on, on
// whose key" — so it lives in ./modelOverrideForm and the summariser shares it. What is specific to
// speech is the SPELLING: the four overrides are stored on the `tts` block under `normalize*` names,
// and translating them is all that is left here.
function toOverride(tts: NormalizeOverrides): ModelOverride {
  return {
    provider: tts.normalizeProvider ?? "",
    model: tts.normalizeModel ?? "",
    credentialRef: tts.normalizeCredentialRef ?? "",
    baseURL: tts.normalizeBaseURL ?? "",
  };
}

export function ttsNormalizerProviderChanged(
  tts: TtsFormState,
  provider: string,
): TtsFormState {
  const o = overrideProviderChanged(toOverride(tts), provider);
  return {
    ...tts,
    normalizeProvider: o.provider ?? "",
    normalizeModel: o.model ?? "",
    normalizeCredentialRef: o.credentialRef ?? "",
    normalizeBaseURL: o.baseURL ?? "",
  };
}

export function ttsNormalizerOverridePicked(
  tts: TtsFormState,
  field: "normalizeModel" | "normalizeCredentialRef",
  value: string,
  agentProvider: string,
): TtsFormState {
  const o = overridePicked(
    toOverride(tts),
    field === "normalizeModel" ? "model" : "credentialRef",
    value,
    agentProvider,
  );
  return {
    ...tts,
    [field]: value,
    normalizeProvider: o.provider ?? "",
  };
}

export type { AgentModelSource } from "./modelOverrideForm";

export function ttsNormalizerResolution(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): NormalizeModelResolution {
  return overrideResolution(toOverride(tts), agent, ownCredBaseUrl);
}

export function ttsNormalizerNeedsOwnCredential(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): boolean {
  return overrideNeedsOwnCredential(toOverride(tts), agent, ownCredBaseUrl);
}

export function ttsNormalizerPickerSource(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): { credentialRef: string; baseURL: string } {
  return overridePickerSource(toOverride(tts), agent, ownCredBaseUrl);
}

// The two guards below answer the shared rule's `sectionOn` question: with audio replies off, or the
// rewrite switched off, the whole block is hidden, so blocking Save would freeze the Behavior tab
// with nothing on screen to explain it — including the save that turns audio off in the first place.
// That precondition used to live here as an early return, which is why the summariser's override
// arrived without it; it is a required argument of the shared helper now, so the next feature to add
// one has to answer it.
export function ttsNormalizerBaseUrlUnsupported(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): boolean {
  return overrideBaseUrlUnsupported(
    toOverride(tts),
    agent,
    ownCredBaseUrl,
    tts.mode !== "never" && tts.normalize,
  );
}

export function ttsNormalizerBaseUrlInvalid(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): boolean {
  return overrideBaseUrlInvalid(
    toOverride(tts),
    agent,
    ownCredBaseUrl,
    tts.mode !== "never" && tts.normalize,
  );
}
