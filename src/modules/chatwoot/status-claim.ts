/**
 * The local status claim: what a status write made on THIS side announces about itself, so a payload
 * serialized before it cannot walk it back. Pure: no DB, no clock of its own; the writers stamp what
 * these functions compute, and `decideConversationWrites` and the takeover's fence ask them what a
 * stored pair means. Why a version cannot do this job, what a claim refuses and why only a write that
 * moves FIRST can take one: docs/chatwoot.md, "A person answering the customer ends the attendance".
 */

// A version cannot do this job: a customer message advances `updated_at` on its own account
// (`set_conversation_activity`), so a snapshot serialized just BEFORE our toggle carries a higher
// version than the state we decided on, exactly like one serialized after it.

// A claim refuses ONE status, the one it replaces: a payload stating anything else is news, and an
// operator resolving inside the claim produces one event we ack and Chatwoot never redelivers, so a
// blanket fence would lose that resolve for good.

// A claim outlives the reconcile because the reopen exception rides a message payload and compares
// whole seconds against the status mark, so a message frozen in the same second as the toggle would
// win even against the version the reconcile just stamped.

// Nothing ends a claim early: a toggle that throws is an UNKNOWN outcome (Chatwoot may have committed
// and lost the response), and releasing there lets a snapshot put the agent back into a conversation
// the platform handed over. The cost is a delay until the deadline, the same for a deferred version
// that nothing ever stamps.

// On a Chatwoot older than 4.0.2 no version arrives, so nothing refused inside a claim is adjudicated
// and a hand-back made in the window stays refused until the deadline: the safe direction, since
// applying a snapshot we cannot place is the defect the claim exists for, and the reason the deadline
// is tens of seconds. There is a deadline at all because a claim whose process died is one no writer
// can end.

// Long enough to outlast the critical section it fences plus the deliveries already in flight when
// it was taken, and no longer: past that the transition is over and the fence is still up. The terms
// are the writer's two round trips (the toggle and the live read that stamps it, `REQUEST_TIMEOUT_MS`
// 15s each in ./client.ts) and Chatwoot's redelivery ladder (`AgentBots::WebhookJob`, 3 retries 3s
// apart, see ./state-order.ts), so 30s plus ~9s, rounded up to 45s. A claim that expired mid-flight
// would be a fence reporting protection it is not giving.
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

// The statuses Chatwoot's own reopen can ACT on (app/models/message.rb, `reopen_conversation`): it
// returns unless the message is incoming and not a reaction, opens a snoozed conversation and reopens
// a resolved one; `pending` and `open` are left as they were. Which status it PRODUCES is deliberately
// not part of this: with an active bot, every inbox this product serves, it sets `pending`, not
// `open`, so a rule keyed on the produced status would be wrong exactly where it matters.
const REOPENABLE = new Set(["resolved", "snoozed"]);

/**
 * What a live claim does with a payload. `"apply"`: nothing to say about it. `"refuse"`: the payload
 * restates the replaced status through the reopen exception, a snapshot every message payload embeds,
 * not a transition anybody dispatched. `"refuse-and-defer"`: the same refusal on a versioned reading,
 * which IS a dispatched transition we are about to ack, so the version is kept for the reconcile
 * (`statusClaimDeferredWins`); otherwise a colleague's hand-back during our toggle is acked and lost.
 */
export type StatusClaimVerdict = "apply" | "refuse" | "refuse-and-defer";

/**
 * Whether a live claim refuses what this payload states, and whether the refusal keeps its version.
 * Asked of the STATED status: a payload stating none says nothing about the transition. `reopens`,
 * the source's own reopen (./state-order.ts), is the one route with no version: refused for the
 * claim's whole life unless the ROW is resolved or snoozed (keyed on the row, never on the status the
 * reopen produces, which depends on the inbox). Anything else is ordered against our stamped version,
 * and refused and deferred while there is none.
 */
export function statusClaimVerdict(
  row: {
    /** The status currently stored. */
    status: string;
    statusClaimUntil: Date | null;
    statusClaimFrom: string | null;
    /** The source's own version for the transition this claim wrote, once the reconcile has it. */
    statusClaimStampedAt: number | null;
  },
  payload: { status: string | null; reopens: boolean; version: number | null },
  now: Date,
): StatusClaimVerdict {
  if (!statusClaimIsLive(row.statusClaimUntil, now)) return "apply";
  if (payload.status === null || payload.status !== row.statusClaimFrom) {
    return "apply";
  }
  // NOTE: STRICTLY ahead of our own transition is the only thing that can be a change made after it;
  // equal is our own reconcile's reading, below it is the gap this fences. Asked BEFORE the reopen and
  // of every route: a hand-back whose conversation event was delayed or lost reaches us next as the
  // customer's own message restating `pending`, and refusing that leaves nobody answering the customer.
  if (
    row.statusClaimStampedAt !== null &&
    payload.version !== null &&
    payload.version > row.statusClaimStampedAt
  ) {
    return "apply";
  }
  // The source's own reopen, which is the one route that can move a status with no version to its
  // name, and therefore the one that has to be judged on what the row holds.
  if (payload.reopens && REOPENABLE.has(row.status)) return "apply";
  return payload.version !== null ? "refuse-and-defer" : "refuse";
}

/**
 * Whether a version refused inside the gap was committed AFTER our own transition, once the source
 * stamped one for it. Asked only by the reconcile that stamps, of its own claim: strictly greater than
 * `stamped` is a later write, and the only status a refusal can have kept is the one the claim
 * replaced, so that state stands. Anything else is a snapshot frozen before our write.
 */
export function statusClaimDeferredWins(
  refusedAt: number | null,
  stamped: number | null,
): boolean {
  return refusedAt !== null && stamped !== null && refusedAt > stamped;
}
