// A voice agent's call configuration, read from `agent.settings.calls`; the browser reads
// it too, so nothing here imports server code. The engine is ElevenLabs Agents on the tenant's own key
// (a `vault:<id>` ref); the server creates the agent there and writes its id back
// (`elevenLabsAgentId`), which the console never edits.

export const CALL_TURN_EAGERNESS = ["patient", "normal", "eager"] as const;
export type CallTurnEagerness = (typeof CALL_TURN_EAGERNESS)[number];

// The models offered on the console, fastest first, with the turn latency measured on the spike's
// loopback (end of the person's speech to the first audio heard). Any other id the ElevenLabs model
// list carries is accepted on the API.
export const CALL_LLMS = [
  { id: "qwen36-35b-a3b", latencyMs: 900 },
  { id: "gpt-4.1-mini", latencyMs: 1300 },
  { id: "gemini-3.5-flash-lite", latencyMs: 1500 },
  { id: "gpt-6-luna", latencyMs: 2100 },
] as const;

// ElevenLabs' built-in ambience, mixed under the agent's speech for the whole call (the agent does not
// hear it, and it does not reach the transcription). Retell's "call center" and "coffee shop" are these.
export const CALL_BACKGROUND_SOUNDS = [
  "office1",
  "office2",
  "restaurant",
  "city",
  "typing",
  "elevator1",
  "elevator2",
  "elevator3",
  "elevator4",
] as const;
export type CallBackgroundSound = (typeof CALL_BACKGROUND_SOUNDS)[number];

// What plays while a tool runs, so the pause of a calendar lookup does not sound like a dropped line.
export const CALL_TOOL_SOUNDS = [
  "typing",
  "elevator1",
  "elevator2",
  "elevator3",
  "elevator4",
] as const;
export type CallToolSound = (typeof CALL_TOOL_SOUNDS)[number];

// Raquel, a Brazilian Portuguese voice from the ElevenLabs library, when nothing else names one.
export const DEFAULT_CALL_VOICE = "GDzHdQOi6jjf8zaXhCYD";

export interface CallsConfig {
  credentialRef: string | null;
  voice: string;
  llm: string;
  speed: number;
  // How long a placed call waits for the person's "alô?" before the agent opens it.
  openingDelayMs: number;
  turnEagerness: CallTurnEagerness;
  // Silence that ends the call; null never ends it for silence.
  silenceEndCallSecs: number | null;
  maxDurationSecs: number;
  // Words the transcription should expect: names of professionals, insurers, products.
  keywords: string[];
  // null → no ambience.
  backgroundSound: CallBackgroundSound | null;
  // Relative to the agent's speech.
  backgroundVolume: number;
  // null → silence while a tool runs.
  toolSound: CallToolSound | null;
  // Written by the server once it created the agent on ElevenLabs.
  elevenLabsAgentId: string | null;
}

export const CALLS_DEFAULTS: CallsConfig = {
  credentialRef: null,
  voice: DEFAULT_CALL_VOICE,
  llm: CALL_LLMS[0].id,
  speed: 1,
  openingDelayMs: 1600,
  turnEagerness: "normal",
  silenceEndCallSecs: 60,
  maxDurationSecs: 1800,
  keywords: [],
  backgroundSound: null,
  backgroundVolume: 0.15,
  toolSound: "typing",
  elevenLabsAgentId: null,
};

export const CALL_LIMITS = {
  speed: [0.7, 1.2],
  openingDelayMs: [0, 5000],
  silenceEndCallSecs: [10, 600],
  maxDurationSecs: [60, 3600],
  keywords: 50,
  keywordChars: 50,
  backgroundVolume: [0.01, 1],
} as const;

function oneOf<T extends string>(
  list: readonly T[],
  v: unknown,
  fallback: T | null,
): T | null {
  if (v === null) return null;
  return list.includes(v as T) ? (v as T) : fallback;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function clamp(
  v: unknown,
  [min, max]: readonly [number, number],
  fallback: number,
) {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : fallback;
}

export function readCallsConfig(settings: unknown): CallsConfig {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).calls
      : undefined;
  if (!raw || typeof raw !== "object") return { ...CALLS_DEFAULTS };
  const bag = raw as Record<string, unknown>;
  const eagerness = str(bag.turnEagerness);
  return {
    credentialRef: str(bag.credentialRef),
    voice: str(bag.voice) ?? CALLS_DEFAULTS.voice,
    llm: str(bag.llm) ?? CALLS_DEFAULTS.llm,
    speed: clamp(bag.speed, CALL_LIMITS.speed, CALLS_DEFAULTS.speed),
    openingDelayMs: Math.round(
      clamp(
        bag.openingDelayMs,
        CALL_LIMITS.openingDelayMs,
        CALLS_DEFAULTS.openingDelayMs,
      ),
    ),
    turnEagerness: CALL_TURN_EAGERNESS.includes(eagerness as CallTurnEagerness)
      ? (eagerness as CallTurnEagerness)
      : CALLS_DEFAULTS.turnEagerness,
    silenceEndCallSecs:
      bag.silenceEndCallSecs === null
        ? null
        : Math.round(
            clamp(
              bag.silenceEndCallSecs,
              CALL_LIMITS.silenceEndCallSecs,
              CALLS_DEFAULTS.silenceEndCallSecs ?? 60,
            ),
          ),
    maxDurationSecs: Math.round(
      clamp(
        bag.maxDurationSecs,
        CALL_LIMITS.maxDurationSecs,
        CALLS_DEFAULTS.maxDurationSecs,
      ),
    ),
    keywords: Array.isArray(bag.keywords)
      ? [
          ...new Set(
            bag.keywords
              .map(str)
              .filter((k): k is string => k !== null)
              .filter((k) => k.length <= CALL_LIMITS.keywordChars),
          ),
        ].slice(0, CALL_LIMITS.keywords)
      : [],
    backgroundSound: oneOf(
      CALL_BACKGROUND_SOUNDS,
      bag.backgroundSound,
      CALLS_DEFAULTS.backgroundSound,
    ),
    backgroundVolume: clamp(
      bag.backgroundVolume,
      CALL_LIMITS.backgroundVolume,
      CALLS_DEFAULTS.backgroundVolume,
    ),
    toolSound: oneOf(CALL_TOOL_SOUNDS, bag.toolSound, CALLS_DEFAULTS.toolSound),
    elevenLabsAgentId: str(bag.elevenLabsAgentId),
  };
}

/**
 * The settings without the ElevenLabs agent id, for a copy of the agent (a clone, an export): the
 * copy creates its own agent there on its first save, instead of rewriting the original's.
 */
export function withoutCallsAgentId(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const calls = settings.calls;
  if (!calls || typeof calls !== "object") return settings;
  const { elevenLabsAgentId: _id, ...rest } = calls as Record<string, unknown>;
  return { ...settings, calls: rest };
}

/**
 * Puts the stored `elevenLabsAgentId` on a settings write, whatever the write carries. Only the call
 * setup writes it (by SQL, leaving `updated_at` alone), so a write's own value is at best an echo: the
 * console writes the block whole, and an editor opened before the server created or recreated the
 * agent would erase the id or put back the one it replaced. Either way the next call would create
 * another agent on the customer's account and abandon the one in use.
 */
export function keepCallsSystemFields(next: unknown, before: unknown): void {
  if (!next || typeof next !== "object") return;
  const calls = (next as Record<string, unknown>).calls;
  if (!calls || typeof calls !== "object") return;
  const bag = calls as Record<string, unknown>;
  const kept = readCallsConfig(before).elevenLabsAgentId;
  if (kept) bag.elevenLabsAgentId = kept;
  else delete bag.elevenLabsAgentId;
}
