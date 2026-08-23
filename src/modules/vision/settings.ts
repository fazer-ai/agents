import { clipText } from "@/lib/text";
import { EXTRACTION_PROMPT_MAX } from "@/modules/agents/text-caps";
import { DEFAULT_EXTRACTION_PROMPT } from "./prompt-default";
import { VISION_PROVIDER_NAMES } from "./providers";

// Re-exported so server callers keep importing it from ./settings (it now lives in a client-safe leaf).
export { DEFAULT_EXTRACTION_PROMPT } from "./prompt-default";

// Per-agent image/document extraction configuration, read from the free-form `agent.settings.vision`
// bag (same pattern as stt/debounce/grounding). The provider is selectable (OpenAI/Gemini/Anthropic,
// extensible via the registry); the API key is a vault entry referenced by a stable `vault:<id>` ref.
// The extraction prompt is operator-configurable (a sensible default is provided). This reader is the
// single source of defaults + validation, so a malformed value never breaks the webhook.

export interface VisionConfig {
  enabled: boolean;
  provider: string; // see VISION_PROVIDER_NAMES
  model: string; // "" → the provider's default
  credentialRef: string | null; // `vault:<id>` ref of the entry holding the API key
  baseURL: string | null; // for self-hosted / compatible endpoints
  extractionPrompt: string; // instruction sent to the vision model
}

export const VISION_DEFAULTS: VisionConfig = {
  // Opt-in: vision calls cost more than text, so it stays off until the operator enables it.
  enabled: false,
  provider: "openai",
  model: "",
  credentialRef: null,
  baseURL: null,
  extractionPrompt: DEFAULT_EXTRACTION_PROMPT,
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function readVisionConfig(settings: unknown): VisionConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).vision
      : undefined;
  if (!s || typeof s !== "object") return { ...VISION_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const provider = str(bag.provider);
  const prompt = str(bag.extractionPrompt);
  return {
    enabled:
      typeof bag.enabled === "boolean" ? bag.enabled : VISION_DEFAULTS.enabled,
    provider:
      provider && VISION_PROVIDER_NAMES.includes(provider)
        ? provider
        : VISION_DEFAULTS.provider,
    model: str(bag.model) ?? "",
    credentialRef: str(bag.credentialRef),
    baseURL: str(bag.baseURL),
    extractionPrompt: prompt
      ? clipText(prompt, EXTRACTION_PROMPT_MAX)
      : DEFAULT_EXTRACTION_PROMPT,
  };
}
