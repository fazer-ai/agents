/**
 * The local status claim: what a status write made on THIS side announces about itself, so a payload
 * serialized before it cannot walk it back (issue #436).
 *
 * Pure: no DB, no clock of its own. The writers stamp what these functions compute, and
 * `decideConversationWrites` and the takeover's fence ask them what a stored pair means.
 *
 * ## Why a version cannot do this job
 *
 * Every other out-of-order question in this module is settled by `conversation.updated_at`: the
 * source's own version stamp, serialized together with the state it describes (state-order.ts). A
 * write made HERE has none to offer — the toggle endpoint renders a status blob and never that field
 * (issue #77) — so the human-reply takeover's `open` lands with the ordering marks exactly where they
 * were, and anything still in flight compares greater and wins.
 *
 * The tempting repair is to give the claim the version it was taken AT and refuse whatever is not
 * strictly ahead of it. Measured on the fork, that separates nothing: a customer message advances
 * `updated_at` on its own account (`set_conversation_activity` writes the conversation row), so a
 * snapshot serialized a moment BEFORE our toggle carries a higher version than the state we decided
 * on, exactly like one serialized after it. There is no reading of that clock which tells the two
 * apart, which is why the write has to announce itself instead of borrowing one.
 *
 * ## Two questions, and a claim does not always answer both
 *
 * A claim always says one thing: a local decision about this row's status exists that no version can
 * order. That is what a delivery deciding from an older payload has to know, and it is why the
 * takeover's fence asks nothing but whether a claim is live.
 *
 * Whether it also fences the MIRROR depends on which side moved first, and the two writers are
 * opposites:
 *
 *   * the takeover writes the row and THEN calls Chatwoot, deliberately, because every reader that
 *     decides whether the agent may speak reads the row. Until the toggle answers, the source has not
 *     decided, so a payload stating the old status is a snapshot from before the write and the mirror
 *     must refuse it. That claim carries the status it is replacing;
 *   * the console calls Chatwoot and THEN mirrors, so by the time its unversioned fallback runs the
 *     source has already decided and nothing is in flight to fence. That claim carries no status, and
 *     the difference is measured rather than tidied: fencing there left the mirror refusing the state
 *     every later payload reported, on a conversation an operator was still working.
 *
 * And what a fencing claim refuses is ONE status, never the field. A payload stating anything else is
 * news, and an operator resolving the conversation inside the claim produces one event that we ack
 * and Chatwoot never redelivers — so a blanket fence loses that resolve for good, with no later event
 * on a resolved conversation to repair it. The single exception, and why it is keyed on the status the
 * ROW holds, is on `statusClaimRefuses`.
 *
 * ## Why a deadline
 *
 * The writer releases the claim itself when the outcome is known and it must not stand: a failed
 * toggle is an UNKNOWN outcome, the local `open` deliberately survives it, and what settles it is the
 * next customer message carrying `pending` through the reopen exception — which a live claim would
 * refuse (the webhook's takeover states that rule from its own side).
 *
 * What no writer can release is a claim its own process died holding, and a claim with no end would
 * then fence that conversation's status forever. So the claim carries the instant it stops mattering,
 * and a crash costs the window rather than the row: past it, the behaviour is the one this release
 * replaced.
 */

// Long enough to outlast the critical section it fences plus the deliveries already in flight when it
// was taken, and no longer, because every second past that is a second in which the transition this
// claim protects is over and the fence is still up.
//
// The two terms, from the code they are measured off rather than chosen:
//
//   * the writer's own round trips — the toggle and the live read that stamps a version on it, at
//     `REQUEST_TIMEOUT_MS` (15s) each in ./client.ts, so 30s of worst case;
//   * Chatwoot's redelivery ladder — `AgentBots::WebhookJob` retries 3 times, 3s apart
//     (state-order.ts, point 5), so a payload frozen before the toggle can still arrive ~9s after it
//     commits.
//
// Rounded up to 45s. A claim that expired mid-flight would be no worse than no claim, but it would be
// a fence that reports protection it is not giving, which is the failure mode that costs a rodada.
export const STATUS_CLAIM_TTL_MS = 45_000;

/** The instant a claim taken at `now` stops standing. */
export function statusClaimDeadline(now: Date): Date {
  return new Date(now.getTime() + STATUS_CLAIM_TTL_MS);
}

/**
 * Whether a local decision about this conversation's status is still outstanding.
 *
 * `until` in the past is not an error and not a claim: the pair is left where the writer put it
 * rather than cleared on the way out, so "no claim outstanding" and "a claim that ran out" are the
 * same answer and are spelled as one.
 */
export function statusClaimIsLive(until: Date | null, now: Date): boolean {
  return until !== null && until.getTime() > now.getTime();
}

// The statuses Chatwoot's own reopen can ACT on, measured on the fork (app/models/message.rb,
// `reopen_conversation`): it returns unless the message is incoming and not a reaction, opens a
// snoozed conversation, and calls `reopen_resolved_conversation` on a resolved one. A `pending` or
// `open` conversation is left exactly as it was.
//
// Which status the reopen PRODUCES is deliberately not part of this: on an inbox with an active bot
// — every inbox this product serves — `reopen_resolved_conversation` sets `pending`, not `open`, so
// a rule written around the produced status would be wrong here in the one deployment that matters.
// What the set below states is narrower and does not depend on that: whether the conversation, as we
// currently believe it stands, is even reopenable.
const REOPENABLE = new Set(["resolved", "snoozed"]);

/**
 * Whether a live claim refuses what this payload states.
 *
 * Asked of the STATED status, never of the stored one: a payload that states none says nothing about
 * the transition and is not what this exists to stop.
 *
 * The exception is Chatwoot's own reopen, and it is keyed on the status the row HOLDS rather than on
 * the one the payload carries. A brand-new incoming message runs `reopen_conversation` before the
 * event is dispatched, so on a conversation we believe is resolved or snoozed the payload is evidence
 * of a change made AFTER our write — which is exactly what a claim must not refuse, and is the shape
 * an operator resolving from the console leaves behind. On a conversation we believe is open or
 * pending that same act does nothing at all, so a payload restating the status the claim replaced is
 * a snapshot of the state before it and nothing else.
 */
export function statusClaimRefuses(
  row: {
    status: string;
    statusClaimUntil: Date | null;
    statusClaimFrom: string | null;
  },
  payload: { status: string | null; reopens: boolean },
  now: Date,
): boolean {
  if (!statusClaimIsLive(row.statusClaimUntil, now)) return false;
  if (payload.status === null || payload.status !== row.statusClaimFrom) {
    return false;
  }
  return !(payload.reopens && REOPENABLE.has(row.status));
}
