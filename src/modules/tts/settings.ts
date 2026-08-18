import { TTS_PROVIDER_NAMES } from "./providers";

import {
  readVoiceSettings,
  TTS_MODES,
  type TtsMode,
  type TtsVoiceSettings,
  VOICE_SETTINGS_DEFAULTS,
} from "./settings-shared";

// Per-agent text-to-speech (audio reply) configuration, read from `agent.settings.tts`. The reply
// MODE is the headline control (the operator's three choices, mirroring the n8n flow):
//   * "never"      → always reply in text (default; audio is opt-in / costs money);
//   * "mirror"     → reply in audio whenever the customer sent audio;
//   * "preference" → follow the per-contact preference (Contact.voiceReply), falling back to mirror
//                    while it is unknown.
// Provider is selectable (ElevenLabs / OpenAI, extensible) and the API key is a vault entry
// referenced by a stable `vault:<id>` ref (renaming the secret never breaks the agent).

export interface TtsConfig extends TtsVoiceSettings {
  mode: TtsMode;
  provider: string;
  model: string; // "" → provider default
  voice: string; // "" → provider default (required by some providers, e.g. ElevenLabs)
  credentialRef: string | null; // `vault:<id>` ref of the entry holding the API key

  baseURL: string | null;
  // Rewrite the reply for natural speech before synthesizing it. See modules/tts/normalize.ts.
  normalize: boolean;
  // The normalizer's OWN model, as four independent overrides of the agent's model config. The
  // rewrite is a cheaper job than answering, so it can run on a cheaper model. All null/empty (the
  // default) inherits the agent's model, key and baseURL, which is what keeps an existing install
  // unchanged. Flat, not nested, for the mergeBehaviorSettings reason above. resolveNormalizeModel
  // (modules/tts/normalize-model.ts) owns how the four fall back.
  normalizeProvider: string | null;
  normalizeModel: string | null;
  normalizeCredentialRef: string | null;
  normalizeBaseURL: string | null;
}

export const TTS_DEFAULTS: TtsConfig = {
  mode: "never",
  provider: "openai",
  model: "",
  voice: "",
  credentialRef: null,
  baseURL: null,
  normalize: true,
  normalizeProvider: null,
  normalizeModel: null,
  normalizeCredentialRef: null,
  normalizeBaseURL: null,
  ...VOICE_SETTINGS_DEFAULTS,
};

// Accepted ranges, clamped rather than rejected: a value typed slightly outside the band is an
// operator overshooting a slider, not a reason to fail the whole settings write.
// NOTE: `speed` is 0.25-4.0, the band the ElevenLabs REST endpoint accepts. The narrower 0.7-1.2 that
// their docs also quote belongs to the Agents Platform, not to this endpoint, and clamping to it here
// would silently turn a deliberate 1.5 into 1.2 with no error and no trace.
// Source: https://github.com/elevenlabs/skills/blob/main/text-to-speech/references/voice-settings.md
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function readTtsConfig(settings: unknown): TtsConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).tts
      : undefined;
  if (!s || typeof s !== "object") return { ...TTS_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const mode = str(bag.mode);
  const provider = str(bag.provider);
  return {
    mode:
      mode && TTS_MODES.includes(mode as TtsMode) ? (mode as TtsMode) : "never",
    provider:
      provider && TTS_PROVIDER_NAMES.includes(provider)
        ? provider
        : TTS_DEFAULTS.provider,
    model: str(bag.model) ?? "",
    voice: str(bag.voice) ?? "",
    credentialRef: str(bag.credentialRef),
    baseURL: str(bag.baseURL),
    normalize:
      typeof bag.normalize === "boolean"
        ? bag.normalize
        : TTS_DEFAULTS.normalize,
    // NOTE: kept RAW here (validated, not resolved). The provider allowlist and the empty-model
    // default both need the agent's own model config to decide, which this reader does not have:
    // resolveNormalizeModel does that, at build time.
    normalizeProvider: str(bag.normalizeProvider),
    normalizeModel: str(bag.normalizeModel),
    normalizeCredentialRef: str(bag.normalizeCredentialRef),
    normalizeBaseURL: str(bag.normalizeBaseURL),
    ...readVoiceSettings(bag),
  };
}

// Groups the flat delivery knobs for the provider boundary, or null when the operator set none — the
// adapters use that null to omit their settings object entirely, so an untouched agent's request body
// stays byte-identical to what it was before this feature existed.
export function voiceSettingsOf(cfg: TtsConfig): TtsVoiceSettings | null {
  // NOTE: coerce undefined to null before the emptiness test — the fields are optional on the type
  // (so every pre-existing TtsConfig literal still compiles) and `undefined !== null` would otherwise
  // read an untouched config as "the operator set something".
  const v: TtsVoiceSettings = {
    stability: cfg.stability ?? null,
    similarityBoost: cfg.similarityBoost ?? null,
    style: cfg.style ?? null,
    speed: cfg.speed ?? null,
    speakerBoost: cfg.speakerBoost ?? null,
  };
  return Object.values(v).some((x) => x !== null) ? v : null;
}

// The audio-vs-text decision (pure). contactVoiceReply: true=audio, false=text, null=unknown.
export function shouldReplyWithAudio(
  mode: TtsMode,
  userSentAudio: boolean,
  contactVoiceReply: boolean | null,
): boolean {
  switch (mode) {
    case "never":
      return false;
    case "mirror":
      return userSentAudio;
    case "preference":
      if (contactVoiceReply === true) return true;
      if (contactVoiceReply === false) return false;
      return userSentAudio; // unknown → mirror
  }
}
