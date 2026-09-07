import {
  LABEL_GROUPS_MAX,
  LABEL_VALUE_MAX,
  LABEL_VALUES_MAX,
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

export interface ObservationGroupState {
  name: string;
  exclusive: boolean;
  // One label per line, the way the editor takes every list an operator types.
  values: string;
}

export interface ObservationState {
  analysis: MonitoringAnalysis;
  // Numbers travel as text: an emptied field is a state the operator passes through, not a value.
  windowMessages: string;
  windowSeconds: string;
  maxWindowSeconds: string;
  noteOnChange: boolean;
  groups: ObservationGroupState[];
}

export const OBSERVATION_LIMITS = Object.freeze({
  groupsMax: LABEL_GROUPS_MAX,
  valuesMax: LABEL_VALUES_MAX,
  windowMessagesMin: WINDOW_MESSAGES_MIN,
  windowMessagesMax: WINDOW_MESSAGES_MAX,
  secondsMin: OBSERVE_WINDOW_MIN_SECONDS,
  secondsMax: OBSERVE_WINDOW_MAX_SECONDS,
  // The longest single label the write boundary accepts, so the box below is sized from the real
  // limit rather than from a guess about it (issue #494 review, round 2).
  valueChars: LABEL_VALUE_MAX,
  // The values box, in characters: `valuesMax` entries at their full permitted length, plus one
  // newline each. Sized at 60 per entry it truncated a taxonomy of longer Chatwoot labels — and
  // truncation in a box read PER LINE does not drop the last label, it silently rewrites it into a
  // shorter one that names nothing.
  valuesTextMax: LABEL_VALUES_MAX * (LABEL_VALUE_MAX + 1),
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
    noteOnChange: c.noteOnChange,
    groups: c.labelGroups.map((g) => ({
      name: g.name,
      exclusive: g.exclusive,
      values: g.values.join("\n"),
    })),
  };
}

function intOr(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v.trim() !== "" ? Math.round(n) : fallback;
}

// The lines of a values box as the list the reader accepts: trimmed, blank lines dropped, repeats
// dropped. What the reader would drop on load is dropped here, so a saved agent reads back as it
// was saved rather than as something narrower.
export function groupValues(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const v = raw.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// A group the reader would drop: no name, or nothing to pick from. Shown as such in the editor,
// and left out of the stored block, so the save never persists a group that observes nothing.
export function groupIncomplete(g: ObservationGroupState): boolean {
  return g.name.trim() === "" || groupValues(g.values).length === 0;
}

// WHAT THE SERVER TOLERATES IS NORMALIZED HERE; WHAT THE SERVER REFUSES IS NOT (issue #494 review,
// rounds 1 and 2). The two halves have opposite failure modes and round 1 got only the first:
//
//   - The server ACCEPTS an out-of-range window and more entries than the reader keeps, and the
//     reader then narrows them on the next load. Left alone, the operator is told "saved" and the
//     runtime runs something else — so those are normalized here, to exactly what the reader will
//     keep, and the form shows the truth immediately.
//   - The server REFUSES a duplicate group name, a value shared between groups, a reserved name and
//     an over-long name or value, each with its own message (`assertMonitoringLabelGroups`). Running
//     those through the lenient reader first DELETES the offending entry and sends a bag the server
//     is happy with — so the save succeeds, the group silently disappears, and the operator is never
//     told what was wrong with it. That is the round-1 fix trading one silent narrowing for another.
//
// So the reader is applied to the numbers and to the COUNTS, and the names and values travel exactly
// as typed. The rule to hold when a limit is added: normalize it here only if the write boundary
// lets it through.
export function observationToStored(form: ObservationState): MonitoringConfig {
  const draft = draftFromForm(form);
  // The reader, for the fields it is the authority on: it clamps the windows and it is where the
  // group and value ceilings live, so neither is copied here.
  const read = readMonitoringConfig({ monitoring: draft });
  return {
    ...read,
    // NOTE: ...and the taxonomy AS TYPED, cut to the counts the reader keeps and no further. Every
    // other
    // objection to a group is the server's to raise, by name, where the operator can act on it.
    labelGroups: draft.labelGroups
      .slice(0, OBSERVATION_LIMITS.groupsMax)
      .map((g) => ({
        ...g,
        values: g.values.slice(0, OBSERVATION_LIMITS.valuesMax),
      })),
  };
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
    labelGroups: form.groups
      .filter((g) => !groupIncomplete(g))
      .map((g) => ({
        name: g.name.trim(),
        exclusive: g.exclusive,
        values: groupValues(g.values),
      })),
    noteOnChange: form.noteOnChange,
  };
}

// The keys the reader produces, for the test that asserts the form carries all of them. Exported
// rather than inlined in the test so the list cannot be written to match the form.
export function monitoringReaderKeys(): string[] {
  const c: MonitoringConfig = readMonitoringConfig({});
  return Object.keys(c).sort();
}
