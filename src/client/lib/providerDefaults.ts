// Client-side mirror of the per-provider default model/voice resolved server-side when the operator
// leaves the field blank. Used to show the REAL default as the field placeholder (instead of a
// hardcoded one that drifts). The server registries in src/modules/{stt,vision,tts}/providers.ts are
// the source of truth; `tests/client/provider-defaults.test.ts` fails if this mirror drifts from them.

export const STT_DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-4o-transcribe",
  "openai-compatible": "whisper-1",
  gemini: "gemini-3.5-flash",
  elevenlabs: "scribe_v2",
  openrouter: "openai/whisper-1",
};

export const VISION_DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-4o",
  "openai-compatible": "",
  gemini: "gemini-3.5-flash",
  anthropic: "claude-sonnet-4-6",
  openrouter: "openai/gpt-4o",
};

export const TTS_DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini-tts",
  elevenlabs: "eleven_flash_v2_5",
  openrouter: "hexgrad/kokoro-82m",
};

// ElevenLabs has no default voice (a voice id is mandatory) → empty string here, surfaced in the UI
// as a "required" hint rather than a fake default.
// The TTS providers the editor offers, mirrored here rather than imported so the browser does not
// pull the synthesis registry in (see modules/tts/settings-shared.ts). The mirror test asserts the
// two lists are EQUAL, in both directions: an entry missing here hides a provider the runtime
// supports, and an extra one is worse, because the form reader uses this as its allowlist.
export const TTS_PROVIDERS = ["openai", "elevenlabs", "openrouter"] as const;

export const TTS_DEFAULT_VOICE: Record<string, string> = {
  openai: "alloy",
  elevenlabs: "",
  openrouter: "af_alloy",
};
