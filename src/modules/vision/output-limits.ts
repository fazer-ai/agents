// The output ceiling and reasoning effort of a vision call (`settings.vision.maxOutputTokens` and
// `.reasoningEffort`), in a client-safe leaf: the console's Behavior form carries both through its save
// and must read them the way the runtime does, without pulling the provider code into the bundle.

// `none` turns reasoning off where the provider has a switch for it; the others are passed as the
// provider spells them. Gemini has no mapping and ignores the field.
export const VISION_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
] as const;
export type VisionReasoningEffort = (typeof VISION_REASONING_EFFORTS)[number];

// What the anthropic messages API is asked for when the operator set no ceiling. The field is
// required there, and it covers thinking as well as the reply: at the old fixed 2048, Claude Haiku
// 5.5 spent the budget thinking and cut a 6-page PDF mid-transcription. The longest complete read
// measured was 1,900 tokens with thinking included, so this leaves room for the long tail.
export const ANTHROPIC_VISION_DEFAULT_MAX_TOKENS = 8192;

// Ceiling on `settings.vision.maxOutputTokens`: the reader clamps to it. No vision read needs more,
// and a typo with an extra zero should not buy a 100k-token reply.
export const VISION_MAX_OUTPUT_TOKENS_CAP = 64_000;

// A ceiling the provider would refuse (zero, negative) or could not bill (a fraction) reads as unset,
// so the request carries the provider default instead of failing with a 400.
export function readVisionMaxOutputTokens(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return null;
  return Math.min(v, VISION_MAX_OUTPUT_TOKENS_CAP);
}

export function readVisionReasoningEffort(
  v: unknown,
): VisionReasoningEffort | null {
  return typeof v === "string" &&
    (VISION_REASONING_EFFORTS as readonly string[]).includes(v)
    ? (v as VisionReasoningEffort)
    : null;
}
