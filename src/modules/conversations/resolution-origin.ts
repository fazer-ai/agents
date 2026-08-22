/**
 * Who closed a conversation, and which closings count as a resolution by the agent.
 *
 * Pure: no DB, no clock. `getKpis` collects the rows and calls this once per conversation, so the
 * rule below lives in one place and is exercised as a decision table
 * (`tests/modules/conversation-resolution-origin.test.ts`) instead of through the dashboard.
 *
 * ## Why the origin is recorded instead of inferred
 *
 * The KPI used to read `status === "resolved" && assigneeType !== "User"` as "the AI resolved it".
 * Seven different closings satisfy that predicate and only one of them is the agent's doing:
 *
 * | closing                                                    | agent's? |
 * |------------------------------------------------------------|----------|
 * | `resolve_conversation` (the tool, deferred or immediate)     | yes      |
 * | the abandonment step of a follow-up sequence                 | no       |
 * | the channel-redirect ladder's closing stage                  | no       |
 * | an operator using the console                                | no       |
 * | an operator resolving in Chatwoot without assigning themself | no       |
 * | Chatwoot's `auto_resolve_after` (closes on inactivity)       | no       |
 * | a Chatwoot automation rule with a `resolve_conversation` action | no    |
 *
 * The last three never reach our code, so no flag on our own call sites could have told them apart:
 * the only durable fact is the one recorded at the moment WE close a conversation. Everything else
 * is `null` and therefore unattributed, which is the honest answer rather than a default of "ours".
 *
 * Why the narrow fix was not enough, measured against Chatwoot 4.17.0 rather than argued: an
 * operator resolving from the Chatwoot UI does NOT assign themselves, so the conversation comes back
 * `resolved` with `meta.assignee_type: "AgentBot"` and the old predicate counted it as the agent's.
 * That is an ordinary daily action, it never reaches our code, and no flag on our own call sites
 * could have told it apart.
 *
 * `auto_resolve_after` belongs on the list too, but it is NARROWER than it looks and the reason is
 * worth writing down: `Conversation.resolvable_all` / `resolvable_not_waiting` scope to `open`, while
 * a conversation our agent is handling is `pending` — and on an inbox with an active bot a customer
 * coming back sends it to `pending` again (`Message#reopen_resolved_conversation`), not to `open`.
 * So the timer does not close the ordinary unanswered lead on a bot inbox. It reaches one only once
 * something else has left it `open` with no human on it: a snoozed conversation woken by an incoming
 * message, or an operator opening and unassigning.
 *
 * ## Rows that predate the column
 *
 * The migration stamps `legacy_unknown` on every conversation already resolved when it ran, so a
 * historical row is distinguishable from one closed afterwards by someone else. Nothing is
 * reclassified: those conversations are reported separately and the dashboard says so, instead of
 * the funnel stepping down one day with no explanation.
 */

/**
 * Whether a status write kills the recorded origin.
 *
 * ONE function and not a clause per writer. The stamp is written on four paths and dropped on
 * three (the webhook mirror, the live reconcile, the console write), and the first six review
 * rounds of this change were six variations of the same mistake: each writer restating the rule in
 * its own local vocabulary (`decision.stale`, `appliedStatus == null`, `statusOrdered`) and getting
 * a different one of them wrong. The vocabulary IS the bug — `stale` in particular is
 * `olderThanStatus && olderThanAssignee`, so a delayed close that loses the status axis while
 * winning the assignee one is not stale, and a rule written on that axis skips it.
 *
 * So the writers state facts and this states the rule. The facts are the same three everywhere:
 * what the row says now, what the incoming source says, and what the ordering decided to write.
 *
 * ## The rule
 *
 * The stamp names a close. It dies when that close is not the row's state, which happens two ways:
 *
 *   1. **The conversation LEFT "resolved".** A resolution that existed is over — reopened by a
 *      customer message, by an operator, by anything. Whatever closes it next is a different close
 *      and gets its own origin.
 *   2. **A source entitled to speak said "resolved" and LOST the ordering, and that claim is newer
 *      than the stamp.** Our own toggle writes the stamp before its event arrives, so between the
 *      two the row reads non-resolved while carrying a stamp. If a reopen wins in that window, the
 *      close it describes never lands, and leaving the stamp would credit the agent for whoever
 *      closes the conversation next.
 *
 *      The "newer than the stamp" half is the whole of `stampedAfterVersion`, and without it the
 *      rule eats resolutions it has no business touching: a delayed `resolved` from an EARLIER
 *      episode loses the ordering in exactly the same shape, and clearing on it wipes a close that
 *      is still on its way. That close's own event then finds nothing to restore, so a real agent
 *      resolution is reported as somebody else's, permanently. The floor is the status version the
 *      CLOSING CALLER observed, so a claim at or below it predates the stamp and is a different
 *      close. Null on either side means there is nothing to compare, and the rule falls back to its
 *      unprotected form rather than refusing to clear.
 *
 *      That fallback is a real limit on a Chatwoot older than 4.0.2, which sends no
 *      `conversation.updated_at` at all: there both sides are always null, so a delayed close from
 *      an earlier episode, or a retried delivery of the message that opened this one, drops a stamp
 *      it should have left alone. Deliberate, and the direction to fail in. Requiring a version
 *      instead would stop rules 2 and 3 from firing on exactly those instances, which is how a
 *      stamp survives a close that never landed: an over-count, on a metric whose whole point is
 *      that it stopped over-counting. Closing it properly needs a SECOND floor on the activity
 *      clock (`last_activity_at`, integer seconds, not comparable to the microsecond float), which
 *      is another column and a third fact through every writer, for a Chatwoot line our own fork
 *      left behind at 4.0.2. Pinned as a named row in the decision table.
 *
 *   3. **A brand-new incoming message reopened the conversation, and it is newer than the stamp.**
 *      The one reopen a message payload carries faithfully, and the only rule here that does not go
 *      through our own view of "resolved" — which is the point. If the webhook for our close is lost
 *      for good (Chatwoot retries three times and gives up), the row never records the resolved
 *      state at all: rule 1 has nothing to leave, rule 2 has no losing claim to read, and the stamp
 *      would ride into the customer's NEXT episode and hand the agent whatever closes that one.
 *      A customer coming back ends the episode whatever our mirror believes.
 *
 *      The floor is what keeps this off a RETRIED delivery of the message that opened the current
 *      episode: `reopensConversation` is true on every delivery of the same `message_created`, and
 *      without the comparison the second one would erase a close made after the first.
 *
 * The first two need `statusAfter !== "resolved"`, and neither is `statusAfter !== "resolved"` on its own:
 * during that same window an unrelated event (a label, an attribute) leaves the row non-resolved
 * while saying nothing about the close, and clearing there loses a genuine resolution for good.
 *
 * `sourceMayStateStatus` is what keeps case 2 off a frozen message snapshot. A snapshot embeds the
 * conversation's status but is not allowed to move state (issue #61), so its "resolved" is not a
 * claim that lost — it is not a claim at all.
 */
export function clearsResolutionOrigin(source: {
  /** The status stored on the row before this write. */
  storedStatus: string;
  /** The status the incoming payload or live snapshot states, null when it states none. */
  statedStatus: string | null;
  /** The status the ordering decided to write, null to keep the stored one. */
  appliedStatus: string | null;
  /** Whether this source is allowed to move status at all: a conversation event, or a live read. */
  sourceMayStateStatus: boolean;
  /** `StatePayload.reopensConversation`: a brand-new incoming customer message. */
  reopens: boolean;
  /** The incoming source's own version, null when it carries none. */
  statedVersion: number | null;
  /** `Conversation.resolvedByAt`: the row's status version when the stamp was written. */
  stampedAfterVersion: number | null;
}): boolean {
  const {
    storedStatus,
    statedStatus,
    appliedStatus,
    sourceMayStateStatus,
    reopens,
    statedVersion,
    stampedAfterVersion,
  } = source;
  const predatesTheStamp =
    stampedAfterVersion != null &&
    statedVersion != null &&
    statedVersion <= stampedAfterVersion;
  const statusAfter = appliedStatus ?? storedStatus;
  if (statusAfter === "resolved") return false;
  const leftResolved = storedStatus === "resolved";
  const closeLostTheOrdering =
    sourceMayStateStatus && statedStatus === "resolved" && !predatesTheStamp;
  const customerCameBack = reopens && !predatesTheStamp;
  return leftResolved || closeLostTheOrdering || customerCameBack;
}

/** Recorded when WE close a conversation. Null = we did not, or the row is not resolved. */
export const RESOLUTION_ORIGINS = [
  /** `resolve_conversation`: the agent judged the customer's request handled. */
  "agent",
  /** The last step of a follow-up sequence closing out a customer who stopped answering. */
  "followup_abandonment",
  /** The channel-redirect ladder tidying up the conversation it moved away from. */
  "redirect_closing",
  /** An operator resolving from our console. */
  "console",
  /** Backfilled by the migration: already resolved before the origin was recorded. */
  "legacy_unknown",
] as const;

export type ResolutionOrigin = (typeof RESOLUTION_ORIGINS)[number];

export function isResolutionOrigin(v: unknown): v is ResolutionOrigin {
  return (
    typeof v === "string" &&
    (RESOLUTION_ORIGINS as readonly string[]).includes(v)
  );
}

export interface ConversationOutcomeRow {
  status: string;
  assigneeType: string | null;
  resolvedBy: string | null;
}

export type ConversationOutcome =
  /** A human owns it: the handoff happened, whatever the status says. */
  | "handoff"
  /** The agent closed it itself. The only closing the Resolution funnel counts. */
  | "resolved_by_agent"
  /** Resolved before this instance started recording the origin. Reported, never counted. */
  | "resolved_before_tracking"
  /** Resolved by someone other than the agent, or by something outside our code. */
  | "resolved_by_other"
  /** Still open, pending or snoozed. */
  | "unresolved";

export function classifyOutcome(
  row: ConversationOutcomeRow,
): ConversationOutcome {
  // NOTE: Handoff wins over any origin: a conversation a human took over is theirs, and the agent cannot
  // run (let alone resolve) after the transfer. Keeping the order explicit means a row that somehow
  // carries both never lands in the success bucket.
  if (row.assigneeType === "User") return "handoff";
  if (row.status !== "resolved") return "unresolved";
  if (row.resolvedBy === "agent") return "resolved_by_agent";
  if (row.resolvedBy === "legacy_unknown") return "resolved_before_tracking";
  return "resolved_by_other";
}
