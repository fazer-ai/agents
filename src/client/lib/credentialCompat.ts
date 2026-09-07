// Per-context credential compatibility: given a model/STT/TTS provider or an integration
// catalogType, which secret-type ids are "compatible" (shown first in the CredentialPicker; the
// rest live behind "show all"). An empty result means "no specific filter" — every credential is
// equally compatible (custom HTTP tools, MCP, unknown providers). Mirrors the provider lists in
// AgentEditorPage and the secret-type services in src/modules/vault/secret-types.ts.

const MODEL_PROVIDER_TYPE: Record<string, string> = {
  openai: "openai",
  "openai-compatible": "openai_compatible",
  anthropic: "anthropic",
  google: "gemini",
  deepseek: "deepseek",
  openrouter: "openrouter",
};

const STT_PROVIDER_TYPE: Record<string, string> = {
  openai: "openai",
  "openai-compatible": "openai_compatible",
  gemini: "gemini",
  elevenlabs: "elevenlabs",
  openrouter: "openrouter",
};

const TTS_PROVIDER_TYPE: Record<string, string> = {
  openai: "openai",
  elevenlabs: "elevenlabs",
  openrouter: "openrouter",
};

const VISION_PROVIDER_TYPE: Record<string, string> = {
  openai: "openai",
  "openai-compatible": "openai_compatible",
  gemini: "gemini",
  anthropic: "anthropic",
  openrouter: "openrouter",
};

const CATALOG_TYPE_TYPE: Record<string, string> = {
  ASAAS: "asaas",
  GOOGLE_CALENDAR: "google_oauth",
  GOOGLE_DRIVE: "google_oauth",
  RESEND: "resend",
};

function single(map: Record<string, string>, key: string): string[] {
  const v = map[key];
  return v ? [v] : [];
}

export const credentialCompat = {
  model: (provider: string) => single(MODEL_PROVIDER_TYPE, provider),
  stt: (provider: string) => single(STT_PROVIDER_TYPE, provider),
  tts: (provider: string) => single(TTS_PROVIDER_TYPE, provider),
  vision: (provider: string) => single(VISION_PROVIDER_TYPE, provider),
  catalog: (catalogType: string) => single(CATALOG_TYPE_TYPE, catalogType),
};
