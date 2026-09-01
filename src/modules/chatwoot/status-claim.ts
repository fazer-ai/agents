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
 * exception, and why it is keyed on the status the ROW holds, is on `statusClaimRefuses`.
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
 * Its ORDERED half ends the moment the source stamps a version for the transition — the live read the
 * takeover reconciles from. From then on a conversation event carrying a version is ordered against
 * THAT version by the ordinary rule, and going on refusing it would drop a hand-back nothing ever
 * redelivers. That instant is readable rather than remembered: the mark has moved off the value the
 * claim was taken at.
 *
 * The rest of its life covers the one route no version can order — the reopen exception, which a
 * message payload carries and which compares whole seconds against the status mark, so a message
 * frozen in the same second as the toggle wins even against the version the reconcile just stamped.
 * That is the shape measured live, and it is why the claim does not simply retire at the reconcile.
 *
 * And NOTHING ends it early, because no outcome makes an unconfirmed local `open` safe to un-fence. A
 * toggle that throws is an UNKNOWN outcome, not a refusal: Chatwoot commits the transition and the
 * response is lost, and there is nothing in the error that tells that apart from a request the server
 * never applied. Releasing there would let a payload frozen before the toggle put the agent straight
 * back into a conversation the platform HAS handed over — the defect this exists to prevent,
 * reintroduced by the recovery. What the deadline costs on that path is a delay: the conversation
 * Chatwoot really did leave `pending` comes back to the agent when the claim runs out, instead of on
 * the next customer message.
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
 * `"refuse"` — the payload restates the status the claim is replacing, and it is evidence of nothing
 * newer: it came through the reopen exception, which is a snapshot Chatwoot froze before our write.
 *
 * `"refuse-and-mark"` — the same refusal, on a payload that IS a versioned reading of the source. The
 * status is not written and the version is, which is what keeps this from being a hole (issue #468,
 * round 3): a conversation event committed AFTER our transition — an operator handing the
 * conversation back inside the window — is indistinguishable here from one frozen before it, so it
 * is refused, but the mark it leaves means nothing older can overwrite what it announced, our own
 * reconcile's snapshot included.
 *
 * And what gets through afterwards is the COMPANION of that same write, which is how the refusal
 * becomes a delay rather than a loss: Chatwoot emits several events for one write and they agree by
 * construction, carrying the same `updated_at`. So the exception is an EQUAL version and nothing
 * else — a later version is a different write, and while the claim is live a different write is
 * exactly what it cannot place (round 4: two independent payloads frozen before the toggle would
 * otherwise walk the row back, the second one riding the mark the first one left).
 *
 * That a real transition HAS a companion is measured, not assumed. A status change dispatches
 * `CONVERSATION_STATUS_CHANGED` and, since `status` is in the conversation's `list_of_keys`,
 * `conversation_updated` as well — so a hand-back arrives at least twice. A write that is not a
 * status change (a label, a priority) dispatches only `conversation_updated`, so the one payload that
 * carries the pre-takeover `pending` by accident is refused and stays refused.
 */
export type StatusClaimVerdict = "apply" | "refuse" | "refuse-and-mark";

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
 *   * anything ELSE is ordered by version, and the claim refuses it while it cannot place that
 *     version against its own transition — which is the whole of its life, because the toggle renders
 *     no version to place it against. The one payload that gets through is the companion of a write
 *     already refused: equal version, and a mark that has moved off the one the claim was taken at.
 */
export function statusClaimVerdict(
  row: {
    /** The status currently stored. */
    status: string;
    /** The status mark now, and the one the claim was taken at. */
    statusAt: number | null;
    statusClaimUntil: Date | null;
    statusClaimFrom: string | null;
    statusClaimFromAt: number | null;
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
  // The companion of a write this claim already refused: the same version, on a mark that is no
  // longer the one the claim was taken at. Both halves are needed — the second is what keeps the
  // claim's very first payload from letting itself through by matching the mark it started on.
  const companion =
    payload.version !== null &&
    payload.version === row.statusAt &&
    row.statusAt !== row.statusClaimFromAt;
  return companion ? "apply" : "refuse-and-mark";
}
