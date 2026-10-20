// A voice agent's call configuration, read from `agent.settings.calls`; the browser reads
// it too, so nothing here imports server code. The engine is the `provider`'s, on the tenant's own key
// (a `vault:<id>` ref); the server creates the agent there and writes its id back
// (`providerAgentId`), which the console never edits. ElevenLabs Agents is the only provider today.

import type { NumberRange } from "@/lib/number-range";
import { CALL_RANGES } from "@/modules/agents/number-ranges";

export const CALL_PROVIDERS = ["elevenlabs"] as const;
export type CallProvider = (typeof CALL_PROVIDERS)[number];

export const CALL_TURN_EAGERNESS = ["patient", "normal", "eager"] as const;
export type CallTurnEagerness = (typeof CALL_TURN_EAGERNESS)[number];

// The models offered on the console, the default first. Any other id the ElevenLabs agents API accepts
// can be typed in the editor and is sent as is. The default and the order come from a measurement on
// 2026-10-19: 24 simulated turns each of a Portuguese shop prompt with three tools.
// DeepSeek Flash 4.1 was the only model both quick to start speaking (about 0.3 s) and right about the
// tool in both rounds; Qwen 3.6, as quick, says "one moment, I'll transfer you" and calls nothing until
// the caller speaks again. Gemini 3.5 Flash-Lite did the same, and GPT-6 Luna took 2 to 4 s: both left
// the list, and an agent saved with either keeps it.
export const CALL_LLMS = [
  { id: "deepseek-v41-flash", label: "DeepSeek Flash 4.1" },
  { id: "glm-52", label: "GLM 5.2" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { id: "qwen36-35b-a3b", label: "Qwen 3.6 35B" },
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

// Where ElevenLabs serves each sound preset's audio, so the console can play it before it is chosen.
// The path is not documented: the agents API names it only for elevator1 (`default_hold_audio_url`),
// and every other preset answers on the same pattern. A preset that stops answering frees its control.
export function callSoundSampleUrl(
  preset: CallBackgroundSound | CallToolSound,
): string {
  return `https://eleven-public-cdn-common.elevenlabs.io/convai/ambient-audio-assets/${preset}.mp3`;
}

// The voice models that speak Portuguese, as ElevenLabs describes them: Flash the fastest, v4 Turbo
// the most expressive for agents, Multilingual v2 the most natural and the slowest. `eleven_flash_v2`
// and `eleven_turbo_v2` are English only, and `eleven_turbo_v2_5` is deprecated in favour of Flash.
export const CALL_TTS_MODELS = [
  "eleven_flash_v2_5",
  "eleven_v4_turbo",
  "eleven_multilingual_v2",
] as const;
export type CallTtsModel = (typeof CALL_TTS_MODELS)[number];

// What transcribes the person as they speak; Scribe Realtime is ElevenLabs' default for agents.
export const CALL_ASR_MODELS = ["scribe_realtime", "scribe_v2_turbo"] as const;
export type CallAsrModel = (typeof CALL_ASR_MODELS)[number];

/** Where the provider shows an agent, with its calls and their transcripts; null when it has no such page. */
export function callProviderAgentUrl(
  provider: CallProvider,
  agentId: string,
): string | null {
  switch (provider) {
    case "elevenlabs":
      return `https://elevenlabs.io/app/agents/agents/${encodeURIComponent(agentId)}`;
  }
}

/** Where the provider's API keys are created, for an operator who has none yet. */
export function callProviderKeysUrl(provider: CallProvider): string {
  switch (provider) {
    case "elevenlabs":
      return "https://elevenlabs.io/app/settings/api-keys";
  }
}

// Raquel, a Brazilian Portuguese voice from the ElevenLabs library, when nothing else names one.
export const DEFAULT_CALL_VOICE = "GDzHdQOi6jjf8zaXhCYD";

export interface CallsConfig {
  provider: CallProvider;
  credentialRef: string | null;
  voice: string;
  llm: string;
  ttsModel: CallTtsModel;
  asrModel: CallAsrModel;
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
  // Written by the server once it created the agent on the provider.
  providerAgentId: string | null;
}

export const CALLS_DEFAULTS: CallsConfig = {
  provider: "elevenlabs",
  credentialRef: null,
  voice: DEFAULT_CALL_VOICE,
  llm: CALL_LLMS[0].id,
  // ElevenLabs' own default for agents since 2026-10-05: the most expressive real-time voice, about
  // 25 ms slower than Flash.
  ttsModel: "eleven_v4_turbo",
  asrModel: CALL_ASR_MODELS[0],
  speed: 1,
  openingDelayMs: 1600,
  turnEagerness: "normal",
  silenceEndCallSecs: 60,
  maxDurationSecs: 1800,
  keywords: [],
  backgroundSound: null,
  backgroundVolume: 0.15,
  toolSound: "typing",
  providerAgentId: null,
};

const pair = (r: NumberRange) => [r.min, r.max] as const;

// The reader's clamp, for a value stored before the schema refused it.
export const CALL_LIMITS = {
  speed: pair(CALL_RANGES.speed),
  openingDelayMs: pair(CALL_RANGES.openingDelayMs),
  silenceEndCallSecs: pair(CALL_RANGES.silenceEndCallSecs),
  maxDurationSecs: pair(CALL_RANGES.maxDurationSecs),
  keywords: 50,
  keywordChars: 50,
  backgroundVolume: pair(CALL_RANGES.backgroundVolume),
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
    provider:
      oneOf(CALL_PROVIDERS, bag.provider, null) ?? CALLS_DEFAULTS.provider,
    credentialRef: str(bag.credentialRef),
    voice: str(bag.voice) ?? CALLS_DEFAULTS.voice,
    llm: str(bag.llm) ?? CALLS_DEFAULTS.llm,
    ttsModel:
      oneOf(CALL_TTS_MODELS, bag.ttsModel, null) ?? CALLS_DEFAULTS.ttsModel,
    asrModel:
      oneOf(CALL_ASR_MODELS, bag.asrModel, null) ?? CALLS_DEFAULTS.asrModel,
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
    providerAgentId: str(bag.providerAgentId),
  };
}

/**
 * The settings without the provider's agent id, for a copy of the agent (a clone, an export): the
 * copy creates its own agent there on its first save, instead of rewriting the original's.
 */
export function withoutCallsAgentId(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const calls = settings.calls;
  if (!calls || typeof calls !== "object") return settings;
  const { providerAgentId: _id, ...rest } = calls as Record<string, unknown>;
  return { ...settings, calls: rest };
}

/**
 * Puts the stored `providerAgentId` on a settings write, whatever the write carries. Only the call
 * setup writes it (by SQL, leaving `updated_at` alone), so a write's own value is at best an echo: the
 * console writes the block whole, and an editor opened before the server created or recreated the
 * agent would erase the id or put back the one it replaced. Either way the next call would create
 * another agent on the customer's account and abandon the one in use.
 */
export function keepCallsSystemFields(next: unknown, before: unknown): void {
  if (!next || typeof next !== "object") return;
  const settings = next as Record<string, unknown>;
  const kept = readCallsConfig(before).providerAgentId;
  // A replacement that leaves the calls block out still keeps the id: the agent it names exists on
  // the customer's account whatever the write carries.
  if (!settings.calls || typeof settings.calls !== "object") {
    if (kept) settings.calls = { providerAgentId: kept };
    return;
  }
  const bag = settings.calls as Record<string, unknown>;
  if (kept) bag.providerAgentId = kept;
  else delete bag.providerAgentId;
}
