import type { TFunction } from "i18next";

// Brand names are hardcoded (not i18n-translated) for well-known providers.
// openai-compatible is the only one that warrants translation.
const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google (Gemini)",
  // STT/vision use the key `gemini` (not `google`) for the same vendor; STT/TTS add `elevenlabs`.
  gemini: "Google (Gemini)",
  elevenlabs: "ElevenLabs",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

export function providerLabel(p: string, t: TFunction): string {
  if (p === "openai-compatible") {
    return t("editor.providerOpenAiCompatible", "OpenAI-compatible");
  }
  return PROVIDER_LABELS[p] ?? p;
}
