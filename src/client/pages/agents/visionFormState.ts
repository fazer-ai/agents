import {
  readVisionMaxOutputTokens,
  readVisionReasoningEffort,
  type VisionReasoningEffort,
} from "@/modules/vision/output-limits";
import { DEFAULT_EXTRACTION_PROMPT } from "@/modules/vision/prompt-default";
import type { VisionState } from "./BehaviorTab";

// The agent editor's vision block, as a pair of pure functions: stored settings → form state →
// stored settings. The Behavior save REPLACES the whole `vision` block with what the form holds, so a
// key the form does not carry is DELETED on the next save. `maxOutputTokens` and `reasoningEffort`
// have no control on the tab and ride through the form untouched; the round-trip test checks the pair
// against the runtime reader's keys, so the next key cannot be added and forgotten here.

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function visionToForm(settings: unknown): VisionState {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).vision
      : undefined;
  const vi = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  return {
    enabled: typeof vi.enabled === "boolean" ? vi.enabled : false,
    provider: str(vi.provider) || "openai",
    model: str(vi.model),
    credentialRef: str(vi.credentialRef),
    baseURL: str(vi.baseURL),
    // NOTE: Prefill the field with the default so the operator sees (and can tweak) the real
    // instruction; visionToStored stores null when it stays the default.
    extractionPrompt: str(vi.extractionPrompt) || DEFAULT_EXTRACTION_PROMPT,
    // Through the runtime's own readers, so the form holds what the runtime acts on.
    maxOutputTokens: readVisionMaxOutputTokens(vi.maxOutputTokens),
    reasoningEffort: readVisionReasoningEffort(vi.reasoningEffort),
  };
}

export function visionToStored(form: VisionState): {
  enabled: boolean;
  provider: string;
  model: string;
  credentialRef: string | null;
  baseURL: string | null;
  extractionPrompt: string | null;
  maxOutputTokens: number | null;
  reasoningEffort: VisionReasoningEffort | null;
} {
  const prompt = form.extractionPrompt.trim();
  return {
    enabled: form.enabled,
    provider: form.provider,
    model: form.model.trim(),
    credentialRef: form.credentialRef || null,
    // NOTE: When the credential carries a baseUrl, the runtime uses it; keep the user's own value
    // (or null) instead of persisting the displayed credential URL (mirror STT).
    baseURL: form.baseURL.trim() || null,
    // NOTE: Store null when the prompt is empty or still the default (keeps storage clean; the
    // reader re-prefills the default on load — no false-dirty).
    extractionPrompt:
      prompt && prompt !== DEFAULT_EXTRACTION_PROMPT ? prompt : null,
    maxOutputTokens: form.maxOutputTokens,
    reasoningEffort: form.reasoningEffort,
  };
}
