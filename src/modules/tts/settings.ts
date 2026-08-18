import { TTS_PROVIDER_NAMES } from "./providers";

import {
  readVoiceSettings,
  TTS_DEFAULTS,
  TTS_MODES,
  type TtsConfig,
  type TtsMode,
  type TtsVoiceSettings,
} from "./settings-shared";

// TtsConfig and TTS_DEFAULTS live in settings-shared (the browser reads them too); re-exported so the
// server-side importers of this module keep one surface.
export { TTS_DEFAULTS, type TtsConfig } from "./settings-shared";

// Per-agent text-to-speech (audio reply) configuration, read from `agent.settings.tts`. The reply
// MODE is the headline control (the operator's three choices, mirroring the n8n flow):
//   * "never"      → always reply in text (default; audio is opt-in / costs money);
//   * "mirror"     → reply in audio whenever the customer sent audio;
//   * "preference" → follow the per-contact preference (Contact.voiceReply), falling back to mirror
//                    while it is unknown.
// Provider is selectable (ElevenLabs / OpenAI, extensible) and the API key is a vault entry
// referenced by a stable `vault:<id>` ref (renaming the secret never breaks the agent).

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
