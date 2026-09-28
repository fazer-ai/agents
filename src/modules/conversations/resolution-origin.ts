/**
 * Who closed a conversation, and which closings count as the agent's. Pure, and exercised as a
 * decision table (`tests/modules/conversation-resolution-origin.test.ts`). The origin is recorded
 * when WE close, never inferred: status plus assignee cannot tell the agent's close from an operator
 * resolving in Chatwoot (the AgentBot stays assigned), an automation rule or `auto_resolve_after`.
 * NULL is unattributed; `legacy_unknown` marks rows already resolved when the column was added.
 * The model is in docs/chatwoot.md.
 */

/**
 * Whether a status write kills the recorded origin; the one rule every status writer asks. The stamp
 * dies when its close is not the row's state: the conversation left "resolved", a source allowed to
 * move status said "resolved" and lost the ordering, or a brand-new incoming message reopened it.
 * The last two only when newer than `stampedAfterVersion`, so a delayed close from an earlier episode
 * or a retried opening message cannot erase this close; with no version on either side they clear.
 * A merely non-resolved row (a label event before our close's webhook) never clears.
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
  /** A new conversation whose only message had nothing to answer, closed without a turn. */
  "nothing_to_answer",
  /** Backfilled by the migration: already resolved before the origin was recorded. */
  "legacy_unknown",
] as const;

export type ResolutionOrigin = (typeof RESOLUTION_ORIGINS)[number];

/**
 * Closes our own side made without a person deciding it: the agent's tool and the two automations
 * that act for it. `console` is an operator, and a NULL stamp is anybody outside our code (an
 * operator in Chatwoot, an automation rule, `auto_resolve_after`), so neither is here. Asked by
 * `shouldBotHandle` before an operator event may speak into a resolved conversation.
 */
const CLOSED_BY_THE_AGENT_SIDE: ReadonlySet<string> = new Set<ResolutionOrigin>(
  ["agent", "followup_abandonment", "redirect_closing", "nothing_to_answer"],
);

export function closedByTheAgentSide(
  resolvedBy: string | null | undefined,
): boolean {
  return resolvedBy != null && CLOSED_BY_THE_AGENT_SIDE.has(resolvedBy);
}

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
