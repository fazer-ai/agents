import { clipText } from "@/lib/text";
// Per-agent follow-up configuration from agent.settings.followUp.
// Same reader/default/clamp pattern as debounce/stt/tts/split/serviceWindow.
//
// A follow-up is a SEQUENCE of steps (re-engage N times with escalating cadence), each with its own
// delay, instructions and optional deterministic actions (assign a label; resolve on the last step).
// No back-compat with the old single-shot flat shape: an agent without a `steps` array gets one
// default step (its pre-multi-step config is not read).

import {
  FOLLOW_UP_INSTRUCTIONS_MAX,
  FOLLOW_UP_MAX_STEPS,
} from "@/modules/agents/text-caps";

export type FollowUpDelayUnit = "minutes" | "hours" | "days";

export interface FollowUpStep {
  delayValue: number; // integer ≥ 1
  delayUnit: FollowUpDelayUnit;
  instructions: string; // operator guidance for THIS step's nudge (max 2000 chars)
  // Deterministic, system-applied actions when this step fires (even if the agent stays silent):
  assignLabels?: string[]; // Chatwoot labels to add (merged, never replacing the set)
  resolve?: boolean; // resolve the conversation — honored ONLY on the last step
  // Let THIS step fire even while the conversation has a live appointment, with
  // `pauseWhileAppointment` left on for every other step (issue #103).
  //
  // The agent-wide flag conflates two opposite things. A re-engagement nudge wants to be suppressed
  // while a booking stands; a payment-deadline step wants exactly the reverse — it only means
  // anything WHILE the booking is unconfirmed, and it is the step that later frees the slot. Without
  // this, an operator who needs both in one sequence has to turn the pause off for the whole agent,
  // which drops it where it was right.
  //
  // Deliberately NOT a notion of "paid" or "confirmed": the platform does not know what those mean
  // for any given operator, and the step that does is the one they wrote.
  ignoreAppointmentPause?: boolean;
}

export interface FollowUpConfig {
  enabled: boolean;
  steps: FollowUpStep[]; // always 1..FOLLOW_UP_MAX_STEPS after a read
  // Pause the follow-up sequence while the conversation has a FUTURE appointment (a pending
  // APPOINTMENT_REMINDER job). Default true: a customer who just booked should not get re-engagement
  // nudges — the reminder system owns the conversation until the appointment passes or is cancelled.
  pauseWhileAppointment: boolean;
}

// Re-exported: the number lives with the text caps because the walker that mirrors this reader has to
// know where the reader stops looking, and importing it back from here would close a cycle.
export { FOLLOW_UP_MAX_STEPS } from "@/modules/agents/text-caps";

function cloneDefaults(): FollowUpConfig {
  return {
    enabled: false,
    steps: [{ delayValue: 60, delayUnit: "minutes", instructions: "" }],
    pauseWhileAppointment: true,
  };
}

export const FOLLOW_UP_DEFAULTS: FollowUpConfig = cloneDefaults();

// A conversation is at the START of a fresh follow-up episode when there is a genuine customer message
// to follow up on (lastInboundAt set — a control command like /teste|/reset does NOT count, the mirror
// excludes it) AND either no follow-up has fired yet, or the customer has spoken since the last one
// fired (a reply restarts the sequence at step 0). Shared by the sweep's eligibility (its raw SQL
// mirrors this), the handler's episode gate, and the conversation-detail estimate — keeping all three
// in lockstep so the operator-facing indicator never disagrees with what the worker will actually do.
export function isNewFollowUpEpisode(
  lastFollowUpAt: Date | null,
  lastInboundAt: Date | null,
): boolean {
  if (lastInboundAt === null) return false;
  return lastFollowUpAt === null || lastInboundAt > lastFollowUpAt;
}

// Converts a step's delayValue + delayUnit to minutes. Clamped to [1, 43200]. For step 0 this is the
// inactivity threshold; for later steps it is the cadence (delay AFTER the previous step fired).
export function stepDelayMinutes(step: FollowUpStep): number {
  let minutes: number;
  switch (step.delayUnit) {
    case "hours":
      minutes = step.delayValue * 60;
      break;
    case "days":
      minutes = step.delayValue * 60 * 24;
      break;
    default:
      minutes = step.delayValue;
  }
  return Math.min(Math.max(Math.round(minutes), 1), 43200);
}

function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.round(v), min), max);
}

// Exported for the MCP argument schema (see modules/agents/settings-schema); the Set below is
// derived from it so the two can never disagree.
export const FOLLOW_UP_DELAY_UNITS = [
  "minutes",
  "hours",
  "days",
] as const satisfies readonly FollowUpDelayUnit[];

const VALID_UNITS = new Set<string>(FOLLOW_UP_DELAY_UNITS);

// Normalize one raw step (clamp delay, trim/bound instructions + label). Returns null only for a
// non-object input; missing numeric/string fields collapse to defaults.
function readStep(raw: unknown): FollowUpStep | null {
  if (!raw || typeof raw !== "object") return null;
  const bag = raw as Record<string, unknown>;
  const delayValue = clampInt(bag.delayValue, 1, 100_000, 60);
  const delayUnit: FollowUpDelayUnit = VALID_UNITS.has(bag.delayUnit as string)
    ? (bag.delayUnit as FollowUpDelayUnit)
    : "minutes";
  const instructions = clipText(
    typeof bag.instructions === "string" ? bag.instructions.trim() : "",
    FOLLOW_UP_INSTRUCTIONS_MAX,
  );
  const step: FollowUpStep = { delayValue, delayUnit, instructions };
  // Accept the new `assignLabels` array; fall back to the legacy single `assignLabel` string so an
  // agent saved before multi-label keeps its label. De-duped, trimmed, bounded.
  const rawLabels = Array.isArray(bag.assignLabels)
    ? bag.assignLabels
    : typeof bag.assignLabel === "string"
      ? [bag.assignLabel]
      : [];
  const labels: string[] = [];
  for (const l of rawLabels) {
    if (typeof l !== "string") continue;
    const trimmed = clipText(l.trim(), 100);
    if (trimmed && !labels.includes(trimmed)) labels.push(trimmed);
  }
  if (labels.length > 0) step.assignLabels = labels;
  if (bag.resolve === true) step.resolve = true;
  if (bag.ignoreAppointmentPause === true) step.ignoreAppointmentPause = true;
  return step;
}

export function readFollowUpConfig(settings: unknown): FollowUpConfig {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).followUp
      : undefined;
  if (!raw || typeof raw !== "object") return cloneDefaults();
  const bag = raw as Record<string, unknown>;

  const enabled = typeof bag.enabled === "boolean" ? bag.enabled : false;

  // An explicit steps array (capped). NO legacy fallback: an agent without a steps array (or with an
  // empty/invalid one) gets a single default step — its pre-multi-step flat config is not read.
  const parsed = (Array.isArray(bag.steps) ? bag.steps : [])
    .slice(0, FOLLOW_UP_MAX_STEPS)
    .map(readStep)
    .filter((s): s is FollowUpStep => s !== null);
  let steps = parsed.length > 0 ? parsed : cloneDefaults().steps;

  // `resolve` is honored ONLY on the last step — resolving mid-sequence would end the episode early,
  // so strip it from every earlier step.
  const lastIdx = steps.length - 1;
  steps = steps.map((s, i) => {
    if (i === lastIdx || !s.resolve) return s;
    // NOTE: removed with a rest spread, never rebuilt field by field. A rebuild lists what to
    // keep, so every field added to a step after it was written is dropped here — silently, and
    // only for a mid-sequence step that happens to carry `resolve`. `ignoreAppointmentPause` would
    // have been the first.
    const { resolve: _dropped, ...kept } = s;
    return kept;
  });

  return {
    enabled,
    steps,
    // Default ON: only an explicit false disables the pause.
    pauseWhileAppointment: bag.pauseWhileAppointment !== false,
  };
}
