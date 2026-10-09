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
  // Let THIS step fire while the conversation has a live appointment, with `pauseWhileAppointment`
  // left on for every other step: a payment-deadline step only means anything WHILE the booking is
  // unconfirmed. Deliberately not a notion of "paid": the platform cannot know what that means.
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

// Postgres GREATEST ignores NULLs, and so does this.
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

// When the current silence began: the later of the customer speaking and us speaking, NULL when
// neither happened. The sweep's SQL, the handler's re-check and the console's estimate compute the
// same expression, or they disagree about one conversation. Not `lastInboundAt` alone: a row the
// mirror created from a non-message event has no inbound instant, even right after our reply.
export function silenceStartedAt(
  lastInboundAt: Date | null,
  lastRepliedAt: Date | null,
): Date | null {
  return laterOf(lastInboundAt, lastRepliedAt);
}

// The episode a follow-up job belongs to, written by the sweep that arms it and carried by every
// reschedule: the silence start in epoch ms, as text so the sweep's SQL builds the same string
// (`floor(extract(epoch from …) * 1000)::bigint::text`). Not the time the job was deferred or died: a
// claim from the previous episode can die after the new silence began.
export function followUpEpisodeKey(silenceStart: Date): string {
  return String(silenceStart.getTime());
}

// When the conversation last moved, our own sends included. `lastEventAt` only advances when
// Chatwoot's webhook for our message comes back, so until then it reads as days of idleness and would
// fire step 0 right behind the answer. A proactive send (reminder, `agent_nudge`) moves this floor
// but never the silence start, which would restart the ladder at every step.
// Identical in SQL: GREATEST(c.last_event_at, c.last_replied_at, c.last_proactive_at).
export function lastActivityAt(
  lastEventAt: Date | null,
  lastRepliedAt: Date | null,
  lastProactiveAt: Date | null,
): Date | null {
  return laterOf(laterOf(lastEventAt, lastRepliedAt), lastProactiveAt);
}

// A fresh episode starts when there is a genuine customer message (control commands are not
// mirrored as inbound) and either no follow-up has fired yet or the silence began after the last one.
// The sweep's SQL mirrors this so the console's indicator agrees with the worker.
export function isNewFollowUpEpisode(
  lastFollowUpAt: Date | null,
  lastInboundAt: Date | null,
  lastRepliedAt: Date | null = null,
): boolean {
  const started = silenceStartedAt(lastInboundAt, lastRepliedAt);
  if (started === null) return false;
  return lastFollowUpAt === null || started > lastFollowUpAt;
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
// non-object input; missing numeric/string fields collapse to defaults. Shared with the snoozed ladder
// (./snoozed-settings.ts), so a step reads the same in both.
export function parseFollowUpStep(raw: unknown): FollowUpStep | null {
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
  // Falls back to the legacy single `assignLabel` string so an agent saved before multi-label
  // keeps its label.
  const rawLabels = Array.isArray(bag.assignLabels)
    ? bag.assignLabels
    : typeof bag.assignLabel === "string"
      ? [bag.assignLabel]
      : [];
  const labels: string[] = [];
  // Membership by Set, not a scan of what is kept: the list has no ceiling and every read of the
  // agent (the turn path, an import) runs this, so a scan is quadratic.
  const seen = new Set<string>();
  for (const l of rawLabels) {
    if (typeof l !== "string") continue;
    const trimmed = clipText(l.trim(), 100);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    labels.push(trimmed);
  }
  if (labels.length > 0) step.assignLabels = labels;
  if (bag.resolve === true) step.resolve = true;
  if (bag.ignoreAppointmentPause === true) step.ignoreAppointmentPause = true;
  return step;
}

// A closing step the operator left without instructions: it only applies its post-actions, and no
// model is reached, since an empty step would hand the model the generic follow-up directive, which
// leans toward writing one more message. One rule for the scheduler and the playground preview.
export function closesWithoutModel(
  step: FollowUpStep,
  isLast: boolean,
): boolean {
  return isLast && step.resolve === true && !step.instructions;
}

export function readFollowUpConfig(settings: unknown): FollowUpConfig {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).followUp
      : undefined;
  if (!raw || typeof raw !== "object") return cloneDefaults();
  const bag = raw as Record<string, unknown>;

  const enabled = typeof bag.enabled === "boolean" ? bag.enabled : false;

  // No legacy fallback: without a valid steps array the agent gets one default step.
  const parsed = (Array.isArray(bag.steps) ? bag.steps : [])
    .slice(0, FOLLOW_UP_MAX_STEPS)
    .map(parseFollowUpStep)
    .filter((s): s is FollowUpStep => s !== null);
  let steps = parsed.length > 0 ? parsed : cloneDefaults().steps;

  // `resolve` is honored only on the last step; mid-sequence it would end the episode early.
  const lastIdx = steps.length - 1;
  steps = steps.map((s, i) => {
    if (i === lastIdx || !s.resolve) return s;
    // Removed with a rest spread, never rebuilt field by field, which would silently drop every
    // step field the rebuild does not list.
    const { resolve: _dropped, ...kept } = s;
    return kept;
  });

  return {
    enabled,
    steps,
    pauseWhileAppointment: bag.pauseWhileAppointment !== false,
  };
}
