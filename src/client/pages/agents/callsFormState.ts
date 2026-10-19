// A voice agent's call settings as the form holds them, read from and written to `settings.calls`
// through the same reader the runtime uses (modules/voice-call/settings), so a field cannot exist on
// one side only. Numbers are kept as typed text while editing; one out of range is refused on save
// (`callsFormErrors`) rather than left to the reader's clamp. `providerAgentId` is not part of the
// form: the server writes it and keeps it across saves.

import {
  CALL_LIMITS,
  type CallAsrModel,
  type CallBackgroundSound,
  type CallProvider,
  type CallToolSound,
  type CallTtsModel,
  type CallTurnEagerness,
  readCallsConfig,
} from "@/modules/voice-call/settings";

export interface CallsFormState {
  provider: CallProvider;
  credentialRef: string;
  voice: string;
  llm: string;
  ttsModel: CallTtsModel;
  asrModel: CallAsrModel;
  speed: string;
  // Seconds, as typed ("1,6"); stored in milliseconds.
  openingDelaySecs: string;
  turnEagerness: CallTurnEagerness;
  endOnSilence: boolean;
  silenceEndCallSecs: string;
  maxDurationMin: string;
  // One per line.
  keywords: string;
  // "" → none.
  backgroundSound: CallBackgroundSound | "";
  // Percent of the agent's speech, as typed.
  backgroundVolume: string;
  // "" → silence.
  toolSound: CallToolSound | "";
}

// A stored number as the form shows it: in the form's unit, with the decimals it needs and no more, so
// opening and saving the form writes back the value that was there.
const shown = (v: number): string =>
  String(Math.round(v * 1000) / 1000).replace(".", ",");

export function readCallsFormState(
  raw: Record<string, unknown>,
): CallsFormState {
  const c = readCallsConfig({ calls: raw });
  return {
    provider: c.provider,
    credentialRef: c.credentialRef ?? "",
    voice: c.voice,
    llm: c.llm,
    ttsModel: c.ttsModel,
    asrModel: c.asrModel,
    speed: String(c.speed).replace(".", ","),
    openingDelaySecs: String(c.openingDelayMs / 1000).replace(".", ","),
    turnEagerness: c.turnEagerness,
    endOnSilence: c.silenceEndCallSecs !== null,
    silenceEndCallSecs: String(c.silenceEndCallSecs ?? 60),
    maxDurationMin: shown(c.maxDurationSecs / 60),
    keywords: c.keywords.join("\n"),
    backgroundSound: c.backgroundSound ?? "",
    backgroundVolume: shown(c.backgroundVolume * 100),
    toolSound: c.toolSound ?? "",
  };
}

const num = (v: string): number | undefined => {
  const n = Number(v.replace(",", "."));
  return v.trim() && Number.isFinite(n) ? n : undefined;
};

export function callsSettingsFrom(f: CallsFormState): Record<string, unknown> {
  const maxMin = num(f.maxDurationMin);
  const delaySecs = num(f.openingDelaySecs);
  const volume = num(f.backgroundVolume);
  return {
    provider: f.provider,
    credentialRef: f.credentialRef || null,
    voice: f.voice.trim(),
    llm: f.llm.trim(),
    ttsModel: f.ttsModel,
    asrModel: f.asrModel,
    speed: num(f.speed),
    openingDelayMs:
      delaySecs === undefined ? undefined : Math.round(delaySecs * 1000),
    turnEagerness: f.turnEagerness,
    silenceEndCallSecs: f.endOnSilence ? num(f.silenceEndCallSecs) : null,
    maxDurationSecs: maxMin === undefined ? undefined : Math.round(maxMin * 60),
    keywords: f.keywords
      .split(/[\n,]/)
      .map((k) => k.trim())
      .filter(Boolean),
    backgroundSound: f.backgroundSound || null,
    backgroundVolume: volume === undefined ? undefined : volume / 100,
    toolSound: f.toolSound || null,
  };
}

export type CallsRangeField =
  | "speed"
  | "openingDelaySecs"
  | "silenceEndCallSecs"
  | "maxDurationMin"
  | "backgroundVolume";

// Each number's accepted range, in the unit the form shows it in.
export const CALLS_FORM_RANGES: Record<
  CallsRangeField,
  readonly [number, number]
> = {
  speed: CALL_LIMITS.speed,
  openingDelaySecs: [
    CALL_LIMITS.openingDelayMs[0] / 1000,
    CALL_LIMITS.openingDelayMs[1] / 1000,
  ],
  silenceEndCallSecs: CALL_LIMITS.silenceEndCallSecs,
  maxDurationMin: [
    CALL_LIMITS.maxDurationSecs[0] / 60,
    CALL_LIMITS.maxDurationSecs[1] / 60,
  ],
  backgroundVolume: [
    CALL_LIMITS.backgroundVolume[0] * 100,
    CALL_LIMITS.backgroundVolume[1] * 100,
  ],
};

/**
 * The numbers out of range, or not numbers, that the save refuses. The reader would clamp them, but a
 * call that silently lasts one minute because someone typed -5 is a setting nobody chose. A field the
 * form does not use (silence while ending on silence is off, volume without a background) is not judged.
 */
export function callsFormErrors(f: CallsFormState): CallsRangeField[] {
  // The wait for the hello is not on the form (it applies to calls the agent places, which nothing
  // places yet): a field the operator cannot see cannot hold the save.
  const judged: CallsRangeField[] = [
    "speed",
    "maxDurationMin",
    ...(f.endOnSilence ? (["silenceEndCallSecs"] as const) : []),
    ...(f.backgroundSound ? (["backgroundVolume"] as const) : []),
  ];
  return judged.filter((field) => {
    const n = num(f[field]);
    const [min, max] = CALLS_FORM_RANGES[field];
    return n === undefined || n < min || n > max;
  });
}

// The fields drawn on General's Voice card; every other one is on the Call tab. Each tab's unsaved dot
// follows its own fields, though one save writes them all.
const ON_GENERAL = [
  "provider",
  "credentialRef",
  "voice",
  "speed",
  "llm",
  "ttsModel",
  "asrModel",
] as const satisfies readonly (keyof CallsFormState)[];

/** The call settings split by the tab that draws them: `general` (the Voice card) and `call`. */
export function callsByTab(f: CallsFormState): {
  general: Partial<CallsFormState>;
  call: Partial<CallsFormState>;
} {
  const general: Partial<CallsFormState> = {};
  const call: Partial<CallsFormState> = { ...f };
  for (const key of ON_GENERAL) {
    Object.assign(general, { [key]: f[key] });
    delete call[key];
  }
  return { general, call };
}

// A refused key is said in full by its sentence: the provider's own words would only repeat it, in English.
export const KEY_PROBLEMS: ReadonlySet<string> = new Set([
  "invalid_key",
  "missing_permission",
]);

/** What saving does to the customers' calls, from the saved mode and the one on the form. */
export function liveness(
  saved: string,
  form: string,
): "live" | "goingLive" | "leavingLive" | "test" {
  const was = saved === "production";
  const will = form === "production";
  if (was && will) return "live";
  if (will) return "goingLive";
  if (was) return "leavingLive";
  return "test";
}

/** Whether the Playground can call: the draft has a key, or the saved version does (a removal of its
 * key that is not saved yet still leaves the saved version callable). */
export function playgroundHasKey(
  draft: CallsFormState,
  savedSettings: unknown,
): boolean {
  if (draft.credentialRef) return true;
  const saved = (savedSettings as { calls?: Record<string, unknown> } | null)
    ?.calls;
  return !!readCallsFormState(saved ?? {}).credentialRef;
}
