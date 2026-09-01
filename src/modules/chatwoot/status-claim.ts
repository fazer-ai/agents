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
 * ## What a claim refuses, and what it must not
 *
 * ONE status: the one it is replacing. A payload restating it while the claim is live is a snapshot
 * from before the write — the two shapes issue #436 measured, a customer message carrying the reopen
 * exception and a delayed or companion `conversation_*` event, are both exactly that.
 *
 * A payload stating anything ELSE is news, and an operator resolving the conversation inside the
 * claim produces one event we ack and Chatwoot never redelivers — so a blanket fence would lose that
 * resolve for good, with no later event on a resolved conversation to repair it. The single
 * exception, and why it is keyed on the status the ROW holds, is on `statusClaimVerdict`.
 *
 * ## Only a write that moves FIRST can take one
 *
 * The takeover writes the row and THEN calls Chatwoot, deliberately, because every reader that
 * decides whether the agent may speak reads the row. That order is what makes the claim meaningful:
 * until the toggle answers, the source has not decided, and a payload stating the old status is a
 * snapshot from before the write.
 *
 * A caller that writes to Chatwoot FIRST and mirrors afterwards — the console's status buttons, whose
 * live read can leave them writing unversioned (issue #77) — has nothing in flight to fence, and
 * giving it a claim was measured to be worse than the gap it closed: it left the mirror refusing the
 * state every later payload reported, and it made the takeover's own fence skip a colleague who
 * replied AFTER the operator's click. That gap is real and is issue #469; it needs an axis this file
 * does not have, since neither side of it can offer a version.
 *
 * ## How a claim ends, and why nothing ends it early
 *
 * In two steps, and they are not the same step because they cover different routes.
 *
 * Its ORDERED half ends the moment the source stamps a version for OUR OWN transition, which is what
 * the takeover's live read goes and gets (`statusClaimStampedAt`). Before that instant there is
 * nothing to place a payload against, and no reading of the row supplies one: a mark that moved
 * proves only that some write reached us, never that it was ours or that it came after ours (issue
 * #468, rounds 4 to 6, which is three ways of learning the same thing). After it the question is
 * ordinary again — a version STRICTLY ahead of the one our transition carries was committed after
 * it, and is a hand-back that has to land.
 *
 * What that leaves is the gap itself, and the payloads that fall in it are not dropped, they are
 * DEFERRED: the newest version refused there is kept on the row (`statusClaimRefusedAt`), and the
 * reconcile that stamps our version adjudicates it against that version. Older is a snapshot frozen
 * before our write, and goes; newer is a transition committed after it — a colleague handing the
 * conversation back while the toggle was on the wire — and the status it restated is the one that
 * stands. This is what keeps the refusal from being a loss: we ack every one of those events and
 * Chatwoot never redelivers them.
 *
 * The rest of the claim's life covers the one route no version can order — the reopen exception,
 * which a message payload carries and which compares whole seconds against the status mark, so a
 * message frozen in the same second as the toggle wins even against the version the reconcile just
 * stamped. That is the shape measured live, and it is why the claim does not simply retire at the
 * reconcile.
 *
 * And NOTHING ends it early, because no outcome makes an unconfirmed local `open` safe to un-fence. A
 * toggle that throws is an UNKNOWN outcome, not a refusal: Chatwoot commits the transition and the
 * response is lost, and there is nothing in the error that tells that apart from a request the server
 * never applied. Releasing there would let a payload frozen before the toggle put the agent straight
 * back into a conversation the platform HAS handed over — the defect this exists to prevent,
 * reintroduced by the recovery. What the deadline costs on that path is a delay: the conversation
 * Chatwoot really did leave `pending` comes back to the agent when the claim runs out, instead of on
 * the next customer message. A deferred version costs the same, and for the same reason — nothing
 * ever stamps it, so nothing adjudicates it.
 *
 * ## What this cannot do on a Chatwoot that sends no version
 *
 * Everything above is written in versions, and an instance older than 4.0.2 sends none. There the
 * claim never gets stamped and nothing refused inside it can be adjudicated, so a hand-back made
 * during the window is refused and stays refused: the mirror keeps the agent OUT of a conversation
 * the platform returned to it, until the deadline passes and some later payload restates `pending`.
 * That is the safe direction of the same coin — the alternative is applying a snapshot we cannot
 * place, which is issue #436 itself — but it is a real cost, and it is the reason the deadline is
 * measured in tens of seconds rather than minutes.
 *
 * ## Why a deadline
 *
 * A claim its own process died holding is one no writer can end, and a claim with no end would fence
 * that conversation's status forever. So it carries the instant it stops mattering, and a crash costs
 * the window rather than the row: past it, the behaviour is the one this release replaced.
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
 * What a live claim does with a payload.
 *
 * `"apply"` — the claim has nothing to say about it.
 *
 * `"refuse"` — the payload restates the status the claim is replacing, and there is nothing to keep:
 * it came through the reopen exception, which carries the conversation's status because every message
 * payload embeds a snapshot, and is not a transition anybody dispatched.
 *
 * `"refuse-and-defer"` — the same refusal, on a versioned reading of the source, which IS a
 * transition somebody dispatched and which we are about to acknowledge. The version is kept on the
 * row so the reconcile can adjudicate it against the one the source stamps for our own write
 * (`statusClaimDeferredWins`). Without that, the one shape this cannot tell apart in the moment — a
 * colleague handing the conversation back while our toggle is on the wire — would be acked and lost.
 */
export type StatusClaimVerdict = "apply" | "refuse" | "refuse-and-defer";

/**
 * Whether a live claim refuses what this payload states, and whether the refusal keeps its version.
 *
 * Asked of the STATED status, never of the stored one: a payload that states none says nothing about
 * the transition and is not what this exists to stop.
 *
 * `reopens` is the source's own act — `Message#execute_after_create_commit_callbacks` runs
 * `reopen_conversation` before it dispatches (state-order.ts) — and it splits the answer in two,
 * because it is the one route that carries no version:
 *
 *   * a REOPEN is refused for the claim's whole life, unless the row is one that act can move. It
 *     acts on a resolved or snoozed conversation and does nothing at all to an open or pending one,
 *     so on a row we believe is resolved the payload is evidence of a change made AFTER our write,
 *     and on any other row it is a snapshot carrying the conversation's status. Keyed on the status
 *     the ROW holds and never on the one the reopen produces: measured on the fork, that act writes
 *     `pending` on an inbox with an active bot and `open` everywhere else;
 *   * anything ELSE is ordered against the version the source stamped for our own transition, and
 *     while there is none — the whole of the gap between the local write and the reconcile — nothing
 *     can be placed, so it is refused and its version deferred.
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
  if (payload.reopens) {
    return REOPENABLE.has(row.status) ? "apply" : "refuse";
  }
  // STRICTLY ahead of our own transition is the only thing that can be a change made after it. Equal
  // is the reading our own reconcile took, and below it is the gap this exists to fence.
  const afterOurs =
    row.statusClaimStampedAt !== null &&
    payload.version !== null &&
    payload.version > row.statusClaimStampedAt;
  if (afterOurs) return "apply";
  return payload.version !== null ? "refuse-and-defer" : "refuse";
}

/**
 * Whether a version refused inside the gap turns out to have been committed AFTER our own transition,
 * once the source has stamped one for it.
 *
 * Asked only by the reconcile that does the stamping, and only of its own claim: `stamped` is the
 * version the source gave the write this claim announced, so anything strictly greater was a
 * different, later write — and the only status a refusal can have kept is the one the claim replaced,
 * which is therefore the state that stands. Anything else is a snapshot frozen before our write, and
 * the evidence goes with the answer.
 */
export function statusClaimDeferredWins(
  refusedAt: number | null,
  stamped: number | null,
): boolean {
  return refusedAt !== null && stamped !== null && refusedAt > stamped;
}
