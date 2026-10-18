import { intRange, type NumberRange, numberRange } from "@/lib/number-range";

// The range of every configurable number in `agent.settings`, in one file the write schema, the
// runtime readers and the console all import. Before, each range lived three or four
// times (a schema description, the reader's clamp, the input's attributes, the hint text), only the
// reader's copy was enforced, and it was enforced silently: the row kept what was typed, the agent
// ran on the clamp, and the editor showed the typed value. Nothing here imports a server module, so
// the browser can read it.

export const DEBOUNCE_RANGES = {
  // The floor is the debounce worker's cadence (a window shorter than the tick is pointless).
  windowSeconds: intRange(3, 120),
  maxMessagesPerBurst: intRange(1, 50),
  // The reader also lifts a ceiling stored below the window up to it.
  maxWindowSeconds: intRange(3, 600),
} as const;

export const SPLIT_RANGES = {
  maxChars: intRange(80, 4000),
  typingWpm: intRange(40, 1000),
  minDelayMs: intRange(0, 10_000),
  maxDelayMs: intRange(0, 30_000),
  maxChunks: intRange(1, 12),
} as const;

export const LIMITS_RANGES = {
  maxToolCalls: intRange(1, 50),
  // Off is null or 0, outside the range on purpose: under ~2k tokens the model loses the turn it is
  // replying to, which reads as amnesia rather than as thrift.
  maxHistoryTokens: intRange(2_000, 1_000_000),
  // 0 is off.
  maxTurnsPerHour: intRange(0, 1_000),
  maxProactivePerDay: intRange(0, 1_000),
} as const;

export const SERVICE_WINDOW_RANGES = {
  windowHours: intRange(1, 168),
} as const;

// `speed` is 0.25-4.0, the band the ElevenLabs REST endpoint accepts. The narrower 0.7-1.2 their docs
// also quote belongs to the Agents Platform, not to this endpoint.
// Source: https://github.com/elevenlabs/skills/blob/main/text-to-speech/references/voice-settings.md
export const TTS_VOICE_RANGES = {
  stability: numberRange(0, 1),
  similarityBoost: numberRange(0, 1),
  style: numberRange(0, 1),
  speed: numberRange(0.25, 4),
} as const;

// A limit below these floors would send nearly every reply as text, which is `mode: "never"` with
// extra steps. Each is nullable: null turns that limit off.
export const TTS_SPEAKABLE_RANGES = {
  textOverChars: intRange(80, 4000),
  textOverListItems: intRange(2, 50),
  textOverNumbers: intRange(2, 50),
} as const;

// One synthesis attempt while a fallback voice is set, in ms. Below a second no provider answers, and
// past two minutes the customer is gone before the text fallback. The console asks for it in seconds,
// fractional because REST and MCP store any whole number of ms (1500 reads as 1.5).
const TTS_TIMEOUT_MS = intRange(1000, 120_000);
export const TTS_TIMEOUT_RANGES = {
  fallbackTimeoutMs: TTS_TIMEOUT_MS,
  fallbackTimeoutSeconds: numberRange(
    TTS_TIMEOUT_MS.min / 1000,
    TTS_TIMEOUT_MS.max / 1000,
  ),
} as const;

// One model call while a fallback model is set, primary and fallback alike, in ms. Below five seconds
// a healthy reply with tools is cut; the ceiling is the no-fallback call deadline's default.
const MODEL_FALLBACK_TIMEOUT_MS = intRange(5000, 120_000);
export const MODEL_FALLBACK_RANGES = {
  timeoutMs: MODEL_FALLBACK_TIMEOUT_MS,
  timeoutSeconds: numberRange(
    MODEL_FALLBACK_TIMEOUT_MS.min / 1000,
    MODEL_FALLBACK_TIMEOUT_MS.max / 1000,
  ),
} as const;

// A voice agent's call (`settings.calls`). Speed is the band ElevenLabs Agents accepts; the volume is
// relative to the speech. The seconds and the wait are whole units.
export const CALL_RANGES = {
  speed: numberRange(0.7, 1.2),
  openingDelayMs: intRange(0, 5000),
  silenceEndCallSecs: intRange(10, 600),
  maxDurationSecs: intRange(60, 3600),
  backgroundVolume: numberRange(0.01, 1),
} as const;

export const CONTACT_AUTH_RANGES = {
  timeoutMs: intRange(1000, 10_000),
  // 0 sends the notice on every refusal.
  noticeCooldownSeconds: intRange(0, 3600),
  grantTtlSeconds: intRange(60, 30 * 24 * 3600),
} as const;

export const CHANNEL_REDIRECT_RANGES = {
  maxResends: intRange(0, 10),
} as const;

export const CARRY_ATTACHMENTS_RANGES = {
  maxFiles: intRange(1, 20),
} as const;

export const MONITORING_RANGES = {
  windowMessages: intRange(4, 60),
  // 0 analyzes every message on its own, with no coalescing.
  windowSeconds: intRange(0, 600),
  // The reader also lifts a ceiling stored below the window up to it.
  maxWindowSeconds: intRange(0, 600),
} as const;

// A guardrail check's probability; at or above it the check trips.
export const GUARDRAIL_RANGES = {
  threshold: numberRange(0, 1),
} as const;

// A knowledge hit's cosine distance; 0 would drop every hit, and nothing is farther than 2.
export const GROUNDING_RANGES = {
  maxDistance: numberRange(0, 2),
} as const;

// A delay is a value and a unit, and what the runtime waits is capped at 30 days in minutes. The value's
// range follows the unit, so 100000 days is refused instead of read as 30.
export const DELAY_MAX_MINUTES = 43_200;
export type DelayUnit = "minutes" | "hours" | "days";
export const DELAY_RANGES: Record<DelayUnit, NumberRange> = {
  minutes: intRange(1, DELAY_MAX_MINUTES),
  hours: intRange(1, DELAY_MAX_MINUTES / 60),
  days: intRange(1, DELAY_MAX_MINUTES / 1440),
};
// Any unit's: what a value alone may be before its unit is known.
export const DELAY_VALUE_RANGE = DELAY_RANGES.minutes;

export function delayRange(unit: unknown): NumberRange {
  return unit === "hours" || unit === "days"
    ? DELAY_RANGES[unit]
    : DELAY_RANGES.minutes;
}
