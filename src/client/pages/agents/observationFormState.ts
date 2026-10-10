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
  startingDecisionsForm,
} from "./decisionsFormState";

// The agent editor's Observation block, as the same pair of pure functions the Memory and TTS blocks
// are: stored settings → form state → stored settings. The Behavior save REPLACES the whole
// `monitoring` block with what the form holds, so a field the form does not carry is DELETED on the
// next save; the round-trip test (tests/client/observation-form-state.test.ts) guards the next field.

export interface ObservationState {
  // Whether the settings as read carried a `monitoring` key at all. An answering agent that never
  // had one saves without one (./monitoringPatch).
  storedPresent: boolean;
  engine: MonitoringEngine;
  // The engine as it was read. Written back, with the stored block, while the section that chooses
  // it is hidden (an agent flipped to production): a choice nobody can see is not a choice to save.
  storedEngine: MonitoringEngine;
  // The decisions block as the form edits it (./decisionsFormState), null while the agent has none.
  decisions: DecisionsForm | null;
  // The block as it was read, carried beside the form: an untouched block is written back as stored,
  // and a draft that cannot run is not written over a block that can while the engine is `llm`.
  storedDecisions: Record<string, unknown> | null;
  // Whether the operator has edited the block since it was read. A stored value the form normalizes
  // (an empty model, a threshold stored as text) reads back equal to what the form shows, so an
  // edit that lands on that same reading is still an edit, and has to be written.
  decisionsEdited: boolean;
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
    storedPresent:
      typeof settings === "object" &&
      settings !== null &&
      (settings as Record<string, unknown>).monitoring !== undefined,
    engine: c.engine,
    storedEngine: c.engine,
    // An agent stored on the decisions engine with NO block is one every tick skips. It opens on
    // an empty draft, as a first switch to the engine does, so the fields and what is missing are
    // on screen instead of an engine choice with nothing under it.
    decisions:
      decisionsToForm(c.decisions) ??
      (c.engine === "decisions" ? startingDecisionsForm() : null),
    storedDecisions: c.decisions,
    decisionsEdited: false,
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
): StoredMonitoring {
  const { decisions, ...rest } = readMonitoringConfig({
    monitoring: draftFromForm(form, watcher),
  });
  // A negative window is REFUSED by the write boundary, so it travels as typed: read through the
  // reader it would become 0, the one value that changes what the agent costs, saved by a typo.
  // Asked of what was TYPED, before the draft rounds it: -0.5 rounds to a zero.
  const typed = Number(form.windowSeconds);
  if (form.windowSeconds.trim() !== "" && typed < 0)
    rest.debounce.windowSeconds = typed;
  // No block, no key: the reader answers null for a missing `decisions`, and writing that null
  // back would store a key the agent never had.
  return decisions === null ? rest : { ...rest, decisions };
}

// What the save stores: the reader's shape, with `decisions` present only when there is a block.
export type StoredMonitoring = Omit<MonitoringConfig, "decisions"> & {
  decisions?: Record<string, unknown>;
};

// An edit to the decisions block, through the one door every field of it uses.
export function editDecisions(
  prev: ObservationState,
  next: (d: DecisionsForm) => DecisionsForm,
): ObservationState {
  return prev.decisions
    ? { ...prev, decisions: next(prev.decisions), decisionsEdited: true }
    : prev;
}

// The stored block the form is judged against: the block as read until the operator edits it,
// nothing after, so an edit is judged (and written) as the form's own block.
export function decisionsBaseline(
  form: ObservationState,
): Record<string, unknown> | null {
  return form.decisionsEdited ? null : form.storedDecisions;
}

// The `monitoring` part of a Behavior save, spread into the settings it writes. The block is
// replaced for a watcher and for an agent that already has one; an answering agent whose settings
// never carried it saves without it, so a save that changed nothing writes nothing there.
export function monitoringPatch(
  form: ObservationState,
  watcher: boolean,
): { monitoring?: StoredMonitoring } {
  if (!watcher && !form.storedPresent) return {};
  return { monitoring: observationToStored(form, watcher) };
}

// The decisions block a save writes: a form nobody touched writes the stored block back as it is; a
// draft that could not run while the model engine is chosen (its fields are not on screen) is not
// stored over the block that was there, since the server would refuse the whole save about fields
// nobody can see; anything else is the form. `watcher` false is the section hidden altogether.
export function decisionsBlockToStore(
  form: ObservationState,
  watcher = true,
): Record<string, unknown> | null {
  // Hidden means the STORED pair goes back whole, engine and block: a block that runs under an
  // engine choice that was never saved is still half of a change nobody can see.
  if (!watcher) return form.storedDecisions;
  const drawn = form.engine === "decisions";
  if (form.decisions === null) return form.storedDecisions;
  if (
    !form.decisionsEdited &&
    decisionsUntouched(form.decisions, form.storedDecisions)
  ) {
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
    engine:
      (watcher ? form.engine : form.storedEngine) === "decisions"
        ? "decisions"
        : "llm",
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

// THE TWO HALVES OF THE BLOCK, saved by different tabs (agents#1224). The decision setup (engine and
// decisions block) is edited on General and on the Questions and rules tab and saved by either; the
// timing (when the agent looks) is the Behavior tab's. Each save writes its own half from the form
// and the other half AS SYNCED, so neither carries the other's pending edits.

// `base` with the decision setup of `from`: `withDecisionsOf(synced, form)` is what the decisions
// save writes, `withDecisionsOf(form, synced)` what the Behavior save writes.
export function withDecisionsOf(
  base: ObservationState,
  from: ObservationState,
): ObservationState {
  return {
    ...base,
    engine: from.engine,
    storedEngine: from.storedEngine,
    decisions: from.decisions,
    storedDecisions: from.storedDecisions,
    decisionsEdited: from.decisionsEdited,
  };
}

// The halves as text, for the unsaved marks. The setup is split once more by where it is drawn: the
// head (engine and Classifier) on General, the body (questions, rules, rehearsal or live) on its tab.
export function timingOf(form: ObservationState): string {
  return JSON.stringify({
    analysis: form.analysis,
    windowMessages: form.windowMessages,
    windowSeconds: form.windowSeconds,
    maxWindowSeconds: form.maxWindowSeconds,
  });
}

export function decisionsHeadOf(form: ObservationState): string {
  // Of the block the save would WRITE, not of the form: a draft left behind the language
  // model that could not run is not written, so switching back leaves nothing unsaved.
  const d = decisionsBlockToStore(form);
  return JSON.stringify({
    engine: form.engine,
    provider: d?.provider ?? null,
    model: d?.model ?? null,
    credentialRef: d?.credentialRef ?? null,
  });
}

export function decisionsBodyOf(form: ObservationState): string {
  const d = decisionsBlockToStore(form);
  if (!d) return "null";
  const { provider: _p, model: _m, credentialRef: _c, ...body } = d;
  return JSON.stringify(body);
}

// The engine cards' one move. A first switch to questions and rules starts from an empty draft in
// rehearsal, so nothing is written before the operator has read what it would do; switching back
// keeps the draft (and a stored block) for the next time.
export function withEngine(
  prev: ObservationState,
  engine: MonitoringEngine,
): ObservationState {
  return {
    ...prev,
    engine,
    decisions:
      engine === "decisions" && prev.decisions === null
        ? startingDecisionsForm()
        : prev.decisions,
  };
}
