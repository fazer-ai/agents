// The part of the TTS configuration the BROWSER also reads, kept apart from the rest for one
// measured reason: nothing here may import `./providers`.
//
// `TTS_PROVIDER_NAMES` is `Object.keys(PROVIDERS)`, so touching `settings.ts` from client code pulls
// the whole synthesis registry into the bundle. It happened: importing the voice clamp for the agent
// editor put the ElevenLabs HTTP client and the WAV header writer in `dist/index-*.js` (`grep -c
// api.elevenlabs.io` went 0 → 1, and the bundle shed 4386 bytes when the import moved here) with
// no caller for either. The editor needs the shape and the clamps; it has no business shipping the
// code that talks to the vendors.

export type TtsMode = "never" | "mirror" | "preference";

export const TTS_MODES: TtsMode[] = ["never", "mirror", "preference"];

// Delivery knobs for the synthesis itself: HOW the words are spoken, as opposed to WHICH words the
// model picked. Every field is nullable and null means "omit it and let the provider decide" — an
// install that never touches this keeps sending the exact same request body it sent before.
// Currently consumed only by ElevenLabs (`voice_settings`); OpenAI's /audio/speech has no equivalent
// bag, so the provider mapper simply ignores what it cannot express.
// NOTE: these live FLAT on TtsConfig, not in a nested object, because mergeBehaviorSettings merges a
// block shallowly — a nested bag would make a patch of one knob null out the others, breaking the
// partial-patch contract the REST/MCP transports promise. Grouping happens at the provider boundary
// (voiceSettingsOf) instead.
export interface TtsVoiceSettings {
  // 0 = maximum variation (expressive, occasionally unstable), 1 = flat and monotone. The single
  // biggest lever on "sounds robotic": a voice left at a high stability reads a well-written,
  // conversational line in the same even tone as a list of numbers.
  stability?: number | null;
  // How tightly the output sticks to the original voice's timbre.
  similarityBoost?: number | null;
  // Emphasis/expressiveness exaggeration. Costs latency and destabilizes at high values, so it stays
  // off (null) unless the operator asks for it.
  style?: number | null;
  // Speaking rate, 1.0 being natural speed.
  speed?: number | null;
  speakerBoost?: boolean | null;
}

export const VOICE_SETTINGS_DEFAULTS: TtsVoiceSettings = {
  stability: null,
  similarityBoost: null,
  style: null,
  speed: null,
  speakerBoost: null,
};

// Bands the providers accept. Outside them the request is refused (422), so a stored value that
// overshoots is not a preference to honour: it is a number nobody can use.
const VOICE_SETTING_RANGES = {
  stability: [0, 1],
  similarityBoost: [0, 1],
  style: [0, 1],
  speed: [0.25, 4],
} as const;

function clamped(v: unknown, [min, max]: readonly [number, number]) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

// The same clamp, for ONE knob, so a writer can normalize before storing instead of storing a value
// the reader will quietly correct later. The editor needs it: it persists what the form holds, and
// what the form holds is whatever was typed, which would leave the operator looking at a 9 forever
// while synthesis runs at 4, with nothing on screen admitting the difference.
export function clampVoiceSetting(
  knob: keyof typeof VOICE_SETTING_RANGES,
  value: number | null,
): number | null {
  return clamped(value, VOICE_SETTING_RANGES[knob]);
}

export function readVoiceSettings(bag: unknown): TtsVoiceSettings {
  if (!bag || typeof bag !== "object") return { ...VOICE_SETTINGS_DEFAULTS };
  const b = bag as Record<string, unknown>;
  return {
    stability: clamped(b.stability, VOICE_SETTING_RANGES.stability),
    similarityBoost: clamped(
      b.similarityBoost,
      VOICE_SETTING_RANGES.similarityBoost,
    ),
    style: clamped(b.style, VOICE_SETTING_RANGES.style),
    speed: clamped(b.speed, VOICE_SETTING_RANGES.speed),
    speakerBoost: typeof b.speakerBoost === "boolean" ? b.speakerBoost : null,
  };
}
