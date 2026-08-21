import { STT_PROVIDER_NAMES } from "./providers";

// Per-agent speech-to-text configuration, read from the free-form `agent.settings.stt` bag (same
// pattern as debounce/grounding). The provider is selectable (Whisper/OpenAI-compatible, Gemini,
// ElevenLabs — extensible via the registry) and the API key is a vault entry referenced by a
// stable `vault:<id>` ref (so renaming the secret never breaks the agent).
// This reader is the single source of defaults + validation, so a malformed value never breaks the
// webhook. Surfaced in the agent editor.

export interface SttConfig {
  enabled: boolean;
  provider: string; // see STT_PROVIDER_NAMES
  model: string; // "" → the provider's default
  language: string; // ISO-639-1, e.g. "pt"
  credentialRef: string | null; // `vault:<id>` ref of the entry holding the API key
  baseURL: string | null; // for openai-compatible / self-hosted endpoints
}

export const STT_DEFAULTS: SttConfig = {
  enabled: true,
  provider: "openai",
  model: "",
  language: "pt",
  credentialRef: null,
  baseURL: null,
};

// Exported for the MCP argument schema (see modules/agents/settings-schema): the reader TESTS a
// language and falls back to "pt" without saying so, so the boundary declares the same pattern.
// NOTE: the case classes are spelled out rather than carried by an `i` flag. JSON Schema has no
// regex flags, so the flag is DROPPED when this is published in `tools/list` — a client validating
// against the published pattern would have rejected "pt-BR" while the server accepted it.
export const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function readSttConfig(settings: unknown): SttConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).stt
      : undefined;
  if (!s || typeof s !== "object") return { ...STT_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const provider = str(bag.provider);
  const language = str(bag.language);
  return {
    enabled:
      typeof bag.enabled === "boolean" ? bag.enabled : STT_DEFAULTS.enabled,
    provider:
      provider && STT_PROVIDER_NAMES.includes(provider)
        ? provider
        : STT_DEFAULTS.provider,
    model: str(bag.model) ?? "",
    language:
      language && LANG_RE.test(language) ? language : STT_DEFAULTS.language,
    credentialRef: str(bag.credentialRef),
    baseURL: str(bag.baseURL),
  };
}
