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
 * `auto_resolve_after` is why the narrow fix was not enough. It produces the exact symptom the issue
 * reports (a lead that never answered lands at the bottom of the success funnel) on an instance that
 * does not use our follow-up ladder at all.
 *
 * ## Rows that predate the column
 *
 * The migration stamps `legacy_unknown` on every conversation already resolved when it ran, so a
 * historical row is distinguishable from one closed afterwards by someone else. Nothing is
 * reclassified: those conversations are reported separately and the dashboard says so, instead of
 * the funnel stepping down one day with no explanation.
 */

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
  // Handoff wins over any origin: a conversation a human took over is theirs, and the agent cannot
  // run (let alone resolve) after the transfer. Keeping the order explicit means a row that somehow
  // carries both never lands in the success bucket.
  if (row.assigneeType === "User") return "handoff";
  if (row.status !== "resolved") return "unresolved";
  if (row.resolvedBy === "agent") return "resolved_by_agent";
  if (row.resolvedBy === "legacy_unknown") return "resolved_before_tracking";
  return "resolved_by_other";
}
