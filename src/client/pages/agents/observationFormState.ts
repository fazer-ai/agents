import { decisionsIssues } from "@/modules/decisions/config";
import {
  MONITORING_DEFAULTS,
  type MonitoringAnalysis,
  type MonitoringConfig,
  type MonitoringEngine,
  OBSERVE_WINDOW_MAX_SECONDS,
  OBSERVE_WINDOW_MIN_SECONDS,
  readMonitoringConfig,
  WINDOW_MESSAGES_MAX,
  WINDOW_MESSAGES_MIN,
} from "@/modules/observe/settings";
import {
  type DecisionsForm,
  decisionsToForm,
  decisionsToStored,
  decisionsUntouched,
} from "./decisionsFormState";

// The agent editor's Observation block, as the same pair of pure functions the Memory and TTS blocks
// are: stored settings → form state → stored settings. The Behavior save REPLACES the whole
// `monitoring` block with what the form holds, so a field the form does not carry is DELETED on the
// next save; the round-trip test (tests/client/observation-form-state.test.ts) guards the next field.

export interface ObservationState {
  engine: MonitoringEngine;
  // The decisions block as the form edits it (./decisionsFormState), null while the agent has none.
  decisions: DecisionsForm | null;
  // The block as it was read, carried beside the form: an untouched block is written back as stored,
  // and a draft that cannot run is not written over a block that can while the engine is `llm`.
  storedDecisions: Record<string, unknown> | null;
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
    engine: c.engine,
    decisions: decisionsToForm(c.decisions),
    storedDecisions: c.decisions,
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

// Normalized through the reader, since the server accepts an out-of-range window that the reader
// narrows on load; otherwise "saved" would show one value while the runtime runs another. Normalize
// a field here only if the write boundary lets it through: anything the server REFUSES must travel
// as typed, or the save succeeds with the value quietly deleted.
export function observationToStored(
  form: ObservationState,
  watcher = true,
): MonitoringConfig {
  const draft = draftFromForm(form, watcher);
  const stored = readMonitoringConfig({ monitoring: draft });
  // A negative window is REFUSED by the write boundary, so it travels as typed: read through the
  // reader it would become 0, the one value that changes what the agent costs, saved by a typo.
  // Asked of what was TYPED, before the draft rounds it: -0.5 rounds to a zero.
  const typed = Number(form.windowSeconds);
  if (form.windowSeconds.trim() !== "" && typed < 0)
    stored.debounce.windowSeconds = typed;
  return stored;
}

// The decisions block a save writes: a form nobody touched writes the stored block back as it is; a
// draft that could not run and whose fields are NOT ON SCREEN (the model engine, or an agent flipped
// to production with the section hidden) is not stored over the block that was there, since the
// server would refuse the whole save about fields nobody can see; anything else is the form.
export function decisionsBlockToStore(
  form: ObservationState,
  watcher = true,
): Record<string, unknown> | null {
  const drawn = watcher && form.engine === "decisions";
  if (form.decisions === null) return form.storedDecisions;
  if (decisionsUntouched(form.decisions, form.storedDecisions)) {
    return form.storedDecisions;
  }
  const block = decisionsToStored(form.decisions);
  if (!drawn && decisionsIssues(block).length > 0) {
    return form.storedDecisions;
  }
  return block;
}

function draftFromForm(
  form: ObservationState,
  watcher: boolean,
): MonitoringConfig {
  const d = MONITORING_DEFAULTS;
  const windowSeconds = intOr(form.windowSeconds, d.debounce.windowSeconds);
  return {
    engine: form.engine === "decisions" ? "decisions" : "llm",
    decisions: decisionsBlockToStore(form, watcher),
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
