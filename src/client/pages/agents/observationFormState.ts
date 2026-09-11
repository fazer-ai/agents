import {
  MONITORING_DEFAULTS,
  type MonitoringAnalysis,
  type MonitoringConfig,
  OBSERVE_WINDOW_MAX_SECONDS,
  OBSERVE_WINDOW_MIN_SECONDS,
  readMonitoringConfig,
  WINDOW_MESSAGES_MAX,
  WINDOW_MESSAGES_MIN,
} from "@/modules/observe/settings";

// The agent editor's Observation block (issue #494), as the same pair of pure functions the Memory
// and TTS blocks are: stored settings → form state → stored settings. The Behavior save REPLACES the
// whole `monitoring` block with what the form holds, so a field the form does not carry is not
// merely un-editable, it is DELETED on the next save. The round-trip test over this pair
// (tests/client/observation-form-state.test.ts) is what makes the next such field impossible to
// add silently.
//
// The label groups this block used to edit are gone with the classifier (issue #568). What is left
// is what observing actually needs: when to look, and how much to read.

export interface ObservationState {
  analysis: MonitoringAnalysis;
  // Numbers travel as text: an emptied field is a state the operator passes through, not a value.
  windowMessages: string;
  windowSeconds: string;
  maxWindowSeconds: string;
}

export const OBSERVATION_LIMITS = Object.freeze({
  windowMessagesMin: WINDOW_MESSAGES_MIN,
  windowMessagesMax: WINDOW_MESSAGES_MAX,
  secondsMin: OBSERVE_WINDOW_MIN_SECONDS,
  secondsMax: OBSERVE_WINDOW_MAX_SECONDS,
});

export function observationToForm(settings: unknown): ObservationState {
  // Through the runtime's own reader, for the reason every other block goes through its reader:
  // a bag written by REST or MCP can carry what the runtime tolerates (a string, a value out of
  // range), and a stricter reading here would show one thing while the runtime ran another, then
  // persist the difference on the next save.
  const c = readMonitoringConfig(settings);
  return {
    analysis: c.analysis,
    windowMessages: String(c.window.messages),
    windowSeconds: String(c.debounce.windowSeconds),
    maxWindowSeconds: String(c.debounce.maxWindowSeconds),
  };
}

function intOr(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v.trim() !== "" ? Math.round(n) : fallback;
}

// WHAT THE SERVER TOLERATES IS NORMALIZED HERE (issue #494 review, rounds 1 and 2): it accepts an
// out-of-range window and the reader then narrows it on the next load, so left alone the operator is
// told "saved" while the runtime runs something else. Run through the reader here, the form shows
// the truth immediately. The rule to hold when a field is added: normalize it here only if the write
// boundary lets it through — anything the server REFUSES must travel as typed, or the save succeeds
// with the offending value quietly deleted and nobody is told what was wrong with it.
export function observationToStored(form: ObservationState): MonitoringConfig {
  return readMonitoringConfig({ monitoring: draftFromForm(form) });
}

function draftFromForm(form: ObservationState): MonitoringConfig {
  const d = MONITORING_DEFAULTS;
  const windowSeconds = intOr(form.windowSeconds, d.debounce.windowSeconds);
  return {
    analysis: form.analysis === "on_resolve" ? "on_resolve" : "incremental",
    window: { messages: intOr(form.windowMessages, d.window.messages) },
    debounce: {
      windowSeconds,
      // The ceiling is never below the window: the reader would raise it on load, and a save that
      // stores less than it reads back is a false dirty on every open.
      maxWindowSeconds: Math.max(
        windowSeconds,
        intOr(form.maxWindowSeconds, d.debounce.maxWindowSeconds),
      ),
    },
  };
}

// The keys the reader produces, for the test that asserts the form carries all of them. Exported
// rather than inlined in the test so the list cannot be written to match the form.
export function monitoringReaderKeys(): string[] {
  const c: MonitoringConfig = readMonitoringConfig({});
  return Object.keys(c).sort();
}
