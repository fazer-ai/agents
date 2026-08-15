/**
 * Ordering rules for the conversation state the mirror keeps in sync with Chatwoot.
 *
 * Pure: no DB, no clock. `mirrorChatwootEvent` collects the facts, calls this once, and writes what
 * it is told. Kept apart so the reasoning below lives in one place and can be exercised as a
 * decision table (`tests/modules/chatwoot-state-order.test.ts`) instead of through the database.
 *
 * ## What the source actually does (measured on the fork, not inferred)
 *
 * 1. A MESSAGE event embeds a conversation SNAPSHOT serialized when the message fired
 *    (`AgentBotListener` builds the payload and only then enqueues it; a failed delivery retries
 *    with that same copy). It describes the conversation as of THAT moment, not the delivery's.
 * 2. `handoff_to_human` posts its message BEFORE assigning the human, so the tail of every handoff
 *    burst carries the pre-handoff state. Applying it rewrote the row back to bot-owned: issue #61.
 * 3. `last_activity_at` has ONE-SECOND resolution and does not advance on a status or assignee
 *    change at all, so a whole burst shares one value. It cannot order that burst.
 * 4. `conversation.updated_at` can: it is the source row's version stamp, it moves on every write
 *    to it (status and assignee changes included), it has sub-second resolution, and it is
 *    serialized together with the state it describes.
 * 5. `AgentBots::WebhookJob` retries 3 times, 3s apart, so deliveries arrive out of order by ~9s.
 * 6. The degraded payload behind issue #27 (`meta` absent) carries a trustworthy status and says
 *    nothing at all about the assignee.
 *
 * ## The rule
 *
 * Conversation state comes from conversation-level events, ordered among themselves by version.
 * A message snapshot moves no state and claims no version. That single sentence closes issue #61:
 * the frozen tail has nothing to say, whatever second it landed in.
 *
 * One exception, and it is the source's own doing: a brand-new incoming customer message reopens
 * the conversation BEFORE the event is dispatched (`Message#execute_after_create_commit_callbacks`
 * runs `reopen_conversation`, then `dispatch_create_events`). That is a status change, never an
 * assignee change, and it is applied as one.
 *
 * The old code trusted snapshots because a handoff event delayed past the human's first message
 * left the message as the only witness of the new assignee, and under a `last_activity_at`
 * monotonic guard the delayed event LOST on arrival, so the mirror stayed bot-owned for good.
 * Ordering removes that trap: the snapshot claims no version, so the mark does not advance past
 * the delayed event and it applies when it lands. The witness argument was an artifact of the
 * guard it was written against.
 *
 * ## Why two marks and not one
 *
 * Each field is ordered by the version of the payload that last WROTE it. After a degraded payload
 * lands, the status and the assignee legitimately reflect different versions of the source row, so
 * a single mark would order one of them by a number that does not describe it: hold the degraded
 * event's version and the complete event delivered after it loses the assignee it is the only
 * witness of; withhold it and that same event reopens a conversation resolved after it.
 *
 * Splitting them is also what makes the reopen exception safe. It moves the STATUS mark only, so a
 * handoff event still in flight is still ordered by an assignee mark the snapshot never touched.
 *
 * ## Versions are compared as raw unix-seconds doubles
 *
 * Never converted to `Date`: that rounds to the millisecond and collapses two writes microseconds
 * apart into one version.
 */

export interface StatePayload {
  /** `conversation.updated_at`. Null on a Chatwoot older than 4.0.2, which sends no version. */
  version: number | null;
  /** `last_activity_at`. Coarse (see 3 above), and the only axis the unversioned fields have. */
  activityAt: Date | null;
  /** False when the payload embeds a message snapshot (see 1 above). */
  fromConversationEvent: boolean;
  /** True for a brand-new incoming customer message, the one reopen a message carries faithfully. */
  reopensConversation: boolean;
  /** The status the payload states. Null means it stated none, so none is written. */
  status: string | null;
  /** False when the payload said nothing about the assignee: the degraded shape of issue #27. */
  assigneeStated: boolean;
  /** The assignee type stated, null meaning unassigned. Only meaningful when `assigneeStated`. */
  assigneeType: string | null;
}

/** The ordering state already stored for this conversation. Null when there is no row yet. */
export interface StateRow {
  activityAt: Date | null;
  statusAt: number | null;
  assigneeAt: number | null;
  assigneeType: string | null;
}

export interface StateDecision {
  /** The payload is behind the row on every axis it offers: apply nothing, keep the row as is. */
  stale: boolean;
  /** The status to write, or null to keep the stored one. */
  status: string | null;
  /** Whether the payload's assignee trio may overwrite the stored one. */
  assignee: boolean;
  /**
   * Whether the payload's UNVERSIONED fields may be written: the relations (contact, contact inbox,
   * inbox) and the attribute bags. Every payload carries them, a message snapshot included, which
   * is what keeps the agent's attribute context current without an extra API call. What they need
   * is the recency fence the stale check used to give them for free: now that a conversation event
   * can win on version alone, one whose `last_activity_at` is older than the row's would roll a bag
   * back over the newer payload that already mirrored it (a Kanban card jumping back a column when
   * a delayed handoff lands), or restore a relation a contact merge had already moved (and the
   * graph's thread key is built from the contact inbox, so that moves the agent's work to another
   * conversation's history). A payload behind the row on this axis keeps its state ruling and its
   * unversioned fields silent.
   */
  unversioned: boolean;
  /** Version to stamp on the status mark, or null to leave it where it is. */
  statusAt: number | null;
  /** Version to stamp on the assignee mark, or null to leave it where it is. */
  assigneeAt: number | null;
  /**
   * `lastEventAt`, clamped so it never rewinds. This is both what gets WRITTEN and what gets
   * RETURNED: the webhook broadcasts it and the console sorts the conversation list on it, so
   * reporting a delayed payload's older timestamp would rewind every client's idea of recency.
   */
  activityAt: Date;
}

export function decideConversationWrites(
  payload: StatePayload,
  row: StateRow | null,
  now: Date,
): StateDecision {
  const eventAt = payload.activityAt ?? now;

  // A payload can only be behind a row that exists. With no row there is nothing to protect and
  // nothing to order against, so everything the payload STATES is applied and claims its version.
  //
  // NOTE: Stated, which is why both marks are conditional. `mirrorChatwootEvent` defaults a created
  // row to `open` when the payload carried no status, and that default is a fabrication, not a
  // reading of the source. Claiming a version for it would protect it: a complete event delivered
  // afterwards but serialized before, carrying the real `pending` or `resolved`, would lose on
  // `olderThanStatus` and the invented `open` would stand until something newer arrived.
  if (row === null) {
    return {
      stale: false,
      status: payload.status,
      assignee: payload.assigneeStated,
      unversioned: true,
      statusAt: payload.status != null ? payload.version : null,
      assigneeAt: payload.assigneeStated ? payload.version : null,
      activityAt: eventAt,
    };
  }

  const olderThanStatus =
    row.statusAt != null &&
    payload.version != null &&
    payload.version < row.statusAt;
  const olderThanAssignee =
    row.assigneeAt != null &&
    payload.version != null &&
    payload.version < row.assigneeAt;

  // Out-of-order guard, on the axis the event itself offers.
  //
  // A conversation event that carries a version is judged by that version and by NOTHING ELSE.
  // Never by `last_activity_at`: a handoff event delayed past the human's first message carries
  // the older value and would be discarded as stale while being the newest word on the
  // conversation. A version against a row that has none is the shape of every conversation the
  // migration touched, and it applies for the same reason: falling back there would recreate that
  // discard for exactly the conversations live at the upgrade.
  //
  // Everything else falls back to `last_activity_at`: a message, which that value describes
  // exactly, and a conversation event from a Chatwoot too old to send a version, where there is
  // nothing finer to order by.
  const stale =
    payload.fromConversationEvent && payload.version != null
      ? olderThanStatus && olderThanAssignee
      : payload.activityAt != null &&
        row.activityAt != null &&
        row.activityAt > payload.activityAt;
  if (stale) {
    return {
      stale: true,
      status: null,
      assignee: false,
      unversioned: false,
      statusAt: null,
      assigneeAt: null,
      activityAt: row.activityAt ?? eventAt,
    };
  }

  // NOTE: `>=`, not `>`. An equal version is the same conversation row, so re-applying it is
  // idempotent, while REJECTING it is not: Chatwoot emits several events for one write
  // (conversation_updated + conversation_status_changed), and the one that arrives second is
  // frequently the one carrying `meta`. Under `>` the first delivery would win and its companion's
  // assignee would be dropped.
  const statusOrdered = payload.fromConversationEvent && !olderThanStatus;
  const assigneeOrdered = payload.fromConversationEvent && !olderThanAssignee;

  const writeStatus = statusOrdered || payload.reopensConversation;
  const status = writeStatus ? payload.status : null;

  // NOTE: One rule for the EQUAL-version case, so the outcome cannot depend on delivery order. A
  // real unassignment is its own write and always arrives strictly greater; every payload is
  // serialized from ONE conversation object, so companions of a single write agree by
  // construction. A disagreement therefore means one witness is degraded, and `null` is the
  // degraded reading: it cannot be told apart from "did not know". So at an equal version an
  // assignee may be SET but never CLEARED. The status needs no such rule: its two readings are
  // equally informative, and it is not the field that decides whether the bot may answer.
  const sameVersion =
    payload.version != null &&
    row.assigneeAt != null &&
    payload.version === row.assigneeAt;
  const assignee =
    payload.assigneeStated &&
    assigneeOrdered &&
    !(sameVersion && payload.assigneeType == null && row.assigneeType != null);

  // NOTE: A mark moves when the field it belongs to is WRITTEN, and only forward. Unconditionally,
  // not "only if the value changed": the mirror frequently has not SEEN the change (when a resolve
  // is itself delayed, the row still reads `open` as the reopen lands), and withholding the version
  // on that basis leaves the delayed resolve looking newer than the mark. What keeps that safe is
  // the forward-only comparison: a message serialized BEFORE a conversation event carries a lower
  // version and cannot push the mark past it, and the reverse cannot happen, since the snapshot is
  // read from the row at dispatch (`set_conversation_activity` runs first), so a newer message
  // always saw the newer state.
  const advances = (mark: number | null): number | null =>
    payload.version != null && (mark == null || payload.version > mark)
      ? payload.version
      : null;

  return {
    stale: false,
    status,
    assignee,
    unversioned: row.activityAt == null || eventAt >= row.activityAt,
    statusAt: status != null ? advances(row.statusAt) : null,
    assigneeAt: assignee ? advances(row.assigneeAt) : null,
    activityAt:
      row.activityAt != null && row.activityAt > eventAt
        ? row.activityAt
        : eventAt,
  };
}
