// The part of the TTS configuration the BROWSER also reads. Nothing here may import `./providers`:
// `TTS_PROVIDER_NAMES` is `Object.keys(PROVIDERS)`, so client code touching `settings.ts` would pull
// the synthesis registry (the ElevenLabs HTTP client, the WAV writer) into the bundle.

import { clipText } from "@/lib/text";

export type TtsMode = "never" | "mirror" | "preference";

export const TTS_MODES: TtsMode[] = ["never", "mirror", "preference"];

// Delivery knobs for the synthesis itself: HOW the words are spoken. Every field is nullable and null
// omits it, so an install that never touches this sends an unchanged request body. Only ElevenLabs
// consumes them (`voice_settings`); other mappers ignore what they cannot express.
// Flat on TtsConfig, not nested: mergeBehaviorSettings merges a block shallowly, so a nested bag
// would null the other knobs on a one-knob patch. Grouping happens in voiceSettingsOf.
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

// What an audio check can do with a synthesized reply: nothing, record the verdict, or hold a
// corrupted audio back and synthesize again. Here rather than in config.ts because the console reads it.
export const TTS_CHECK_MODES = ["off", "shadow", "enforce"] as const;
export type TtsCheckMode = (typeof TTS_CHECK_MODES)[number];

export interface TtsConfig extends TtsVoiceSettings {
  mode: TtsMode;
  provider: string;
  model: string; // "" → provider default
  voice: string; // "" → provider default (required by some providers, e.g. ElevenLabs)
  credentialRef: string | null; // `vault:<id>` ref of the entry holding the API key

  baseURL: string | null;
  // Rewrite the reply for natural speech before synthesizing it. See modules/tts/normalize.ts.
  normalize: boolean;
  // The normalizer's OWN model, as four independent overrides of the agent's model config. The
  // rewrite is a cheaper job than answering, so it can run on a cheaper model. All null/empty (the
  // default) inherits the agent's model, key and baseURL, which is what keeps an existing install
  // unchanged. Flat, not nested, for the mergeBehaviorSettings reason above. resolveNormalizeModel
  // (modules/tts/normalize-model.ts) owns how the four fall back.
  normalizeProvider: string | null;
  normalizeModel: string | null;
  normalizeCredentialRef: string | null;
  normalizeBaseURL: string | null;
  // The audio check for this agent's replies. null = the deployment's `TTS_CHECK_MODE`, so an agent
  // that never picked behaves as the install does. Honoured only while `TTS_CHECK_URL` is set.
  checkMode: TtsCheckMode | null;
  // Whether a reply built to be read goes as TEXT though it would have been audio. Off by default.
  // When on, each limit below is the smallest value that sends text (null turns that criterion off).
  // Flat, for the mergeBehaviorSettings reason above. See modules/tts/speakable.ts.
  textInstead: boolean;
  textOverChars: number | null;
  textOverListItems: number | null;
  textOverNumbers: number | null;
  // What the model is told about its reply being spoken, both off by default. `spokenNotice` appends
  // a system notice when the reply is planned as a voice note (`spokenNoticeText` null = the default).
  // `textChoice` offers `reply_as_text`; `textChoiceNote` is appended to its description.
  spokenNotice: boolean;
  spokenNoticeText: string | null;
  textChoice: boolean;
  textChoiceNote: string | null;
}

// The notice used when the operator turns it on without writing one: long answers and lists are
// what most often reads better as text, and most need not be long.
export const SPOKEN_NOTICE_DEFAULT =
  "[Sistema] Esta resposta será enviada ao cliente como mensagem de voz. Escreva para ser ouvida: curta, sem listas, tabelas nem formatação, com o essencial primeiro. Se o cliente precisar de detalhes para ler ou copiar (valores, passos, links), ofereça mandar por escrito.";

// The ceiling on both texts above, the same one a native tool's note has: each is a paragraph of
// guidance, and the notice is read on every audio turn.
export const VOICE_CHOICE_TEXT_MAX = 1500;

// The two switches and their texts. A switch is on only when stored as `true`, so an agent saved
// without it keeps its prompt and toolset byte for byte. A blank text falls back to the default
// instead of appending an empty block; texts are clamped like every operator text handed to a model.
export function readVoiceChoiceSettings(bag: Record<string, unknown>) {
  const text = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t ? clipText(t, VOICE_CHOICE_TEXT_MAX) : null;
  };
  return {
    spokenNotice: bag.spokenNotice === true,
    spokenNoticeText: text(bag.spokenNoticeText),
    textChoice: bag.textChoice === true,
    textChoiceNote: text(bag.textChoiceNote),
  };
}

// The limits a reply is measured against before synthesis, sized to what most often reads better as
// text: length past ~450 characters, a list of 3+ items, 3+ money values or long numbers. They apply
// once `textInstead` is on, and each can be turned off on its own.
export const SPEAKABLE_DEFAULTS = {
  textOverChars: 450,
  textOverListItems: 3,
  textOverNumbers: 3,
} as const satisfies Pick<
  TtsConfig,
  "textOverChars" | "textOverListItems" | "textOverNumbers"
>;

// Clamped rather than rejected, like the voice knobs: a limit below these floors would send nearly
// every reply as text, which is `mode: "never"` with extra steps.
export const SPEAKABLE_RANGES = {
  textOverChars: [80, 4000],
  textOverListItems: [2, 50],
  textOverNumbers: [2, 50],
} as const;

export function clampSpeakableLimit(
  knob: keyof typeof SPEAKABLE_RANGES,
  value: unknown,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const [min, max] = SPEAKABLE_RANGES[knob];
  return Math.min(max, Math.max(min, Math.round(value)));
}

// The switch and the limits. The switch is on only when stored as `true`. For a limit, absent is the
// default and null is OFF: turning the switch on should bring the defaults, while a cleared field
// stops that criterion. Shared with the editor, so the screen shows what the runtime applies.
export function readSpeakableLimits(bag: Record<string, unknown>) {
  const read = (knob: keyof typeof SPEAKABLE_DEFAULTS) => {
    const v = bag[knob];
    if (v === null) return null;
    return clampSpeakableLimit(knob, v) ?? SPEAKABLE_DEFAULTS[knob];
  };
  return {
    textInstead: bag.textInstead === true,
    textOverChars: read("textOverChars"),
    textOverListItems: read("textOverListItems"),
    textOverNumbers: read("textOverNumbers"),
  };
}

export const TTS_DEFAULTS: TtsConfig = {
  mode: "never",
  provider: "openai",
  model: "",
  voice: "",
  credentialRef: null,
  baseURL: null,
  normalize: true,
  normalizeProvider: null,
  normalizeModel: null,
  normalizeCredentialRef: null,
  normalizeBaseURL: null,
  checkMode: null,
  textInstead: false,
  ...SPEAKABLE_DEFAULTS,
  spokenNotice: false,
  spokenNoticeText: null,
  textChoice: false,
  textChoiceNote: null,
  ...VOICE_SETTINGS_DEFAULTS,
};

// Accepted ranges, clamped rather than rejected: a value typed slightly outside the band is an
// operator overshooting a slider, not a reason to fail the whole settings write.
// NOTE: `speed` is 0.25-4.0, the band the ElevenLabs REST endpoint accepts. The narrower 0.7-1.2 that
// their docs also quote belongs to the Agents Platform, not to this endpoint, and clamping to it here
// would silently turn a deliberate 1.5 into 1.2 with no error and no trace.
// Source: https://github.com/elevenlabs/skills/blob/main/text-to-speech/references/voice-settings.md
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
