/**
 * Ordering rules for the conversation state the mirror keeps in sync with Chatwoot.
 *
 * Pure: no DB, no clock. `mirrorChatwootEvent` collects the facts, calls this once, and writes what
 * it is told. Kept apart so the reasoning lives in one place and can be exercised as a decision table
 * (`tests/modules/chatwoot-state-order.test.ts`) instead of through the database.
 */

// What the source does, read on the fork:
// 1. A MESSAGE event embeds a conversation SNAPSHOT serialized when the message fired
//    (`AgentBotListener` builds the payload, then enqueues it; a failed delivery retries with that
//    same copy). It describes the conversation as of THAT moment, not the delivery's.
// 2. `handoff_to_human` posts its message BEFORE assigning the human, so the tail of every handoff
//    burst carries the pre-handoff state; applied, it rewrites the row back to bot-owned.
// 3. `last_activity_at` has ONE-SECOND resolution and does not advance on a status or assignee
//    change at all, so a whole burst shares one value and it cannot order that burst.

// 4. `conversation.updated_at` can: it is the source row's version stamp, moved by every write to it
//    (status and assignee included), sub-second, and serialized together with the state it describes.
// 5. `AgentBots::WebhookJob` retries 3 times, 3s apart, so deliveries arrive out of order by ~9s.
// 6. A degraded payload (`meta` absent) carries a trustworthy status and says nothing at all about
//    the assignee.

// The rule: conversation state comes from conversation-level events, ordered among themselves by
// version. A message snapshot moves no state and claims no version, so the frozen handoff tail has
// nothing to say whatever second it landed in. "Nothing to say" is about STATE: the redirect pairing
// has its own mark, so a payload discarded for state can still be the only witness of a pairing.
// One exception, the source's own doing: a brand-new incoming customer message reopens the
// conversation BEFORE dispatch (`Message#execute_after_create_commit_callbacks` runs
// `reopen_conversation`, then `dispatch_create_events`): a status change, never an assignee change.

// A snapshot need not be trusted as the only witness of a new assignee (a handoff event delayed past
// the human's first message): it claims no version, so the mark does not advance past the delayed
// event, and that event applies when it lands.

// Why three marks and not one: each field is ordered by the version of the payload that last WROTE
// it. After a degraded payload, status and assignee reflect different source versions, so one mark
// would order one of them by a number that does not describe it: hold the degraded event's version
// and the complete event after it loses the assignee it alone witnesses; withhold it and that event
// reopens a conversation resolved after it. Split marks also make the reopen exception safe: it moves
// the STATUS mark only, so a handoff event in flight is still ordered by an untouched assignee mark.

// The third mark, the redirect pairing, is written by an update of its own on the source row, so
// from then on it describes a version neither other mark does. It cannot borrow their fallback:
// recording the pairing is a column write, which by point 3 leaves `last_activity_at` frozen, and a
// recency fence would discard exactly the payload it exists to keep.

// Versions are compared as raw unix-seconds doubles, never converted to `Date`: that rounds to the
// millisecond and collapses two writes microseconds apart into one version.

import { statusClaimVerdict } from "./status-claim";

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
  /** False when the payload said nothing about the assignee: the degraded shape (see 6 above). */
  assigneeStated: boolean;
  /** The assignee type stated, null meaning unassigned. Only meaningful when `assigneeStated`. */
  assigneeType: string | null;
  /**
   * True when the payload SPEAKS about the redirect pairing, which includes stating that there is
   * none: the fork ships the key on every conversation, nil included, and clears the pairing when a
   * re-entry's token names no origin. False only when the key is absent altogether, which is every
   * payload from a Chatwoot without that change.
   */
  redirectOriginStated: boolean;
  /**
   * True when what the payload states is that there is NO pairing. Meaningful only with
   * `redirectOriginStated`, and separate from it because a stated nil is not always an answer: see
   * `redirectOriginAnswers` below.
   */
  redirectOriginCleared: boolean;
}

/** The ordering state already stored for this conversation. Null when there is no row yet. */
export interface StateRow {
  /** The status currently stored, which only the claim rule below reads. */
  status: string;
  activityAt: Date | null;
  statusAt: number | null;
  assigneeAt: number | null;
  assigneeType: string | null;
  redirectOriginAt: number | null;
  /**
   * Whether this conversation has EVER had a pairing stated about it — the mark, or a stored origin
   * for the versionless instances that write the value and stamp nothing. Both are evidence; only
   * having neither is silence.
   */
  redirectOriginKnown: boolean;
  /**
   * The local claim: a status written on this side that the source has not versioned, and the
   * instant it stops fencing. `from` is the status it replaced, the only one it refuses; `stampedAt`
   * is the version the source gave that write once the reconcile read it back, null while there is
   * nothing to place a payload against; `refusedAt` is the newest version refused while that was
   * null, kept for the reconcile. All null when nothing local is outstanding. See ./status-claim.ts.
   */
  statusClaimUntil: Date | null;
  statusClaimFrom: string | null;
  statusClaimStampedAt: number | null;
  statusClaimRefusedAt: number | null;
}

export interface StateDecision {
  /**
   * The payload is behind the row on every STATE axis it offers, so none of the conversation state
   * below is applied. Not "apply nothing": the redirect pairing has a mark of its own and is decided
   * separately, precisely because the payload that first carries one is routinely behind on the rest
   * (see the stale branch below). `mirrorChatwootEvent` returns early on this flag, and writes what
   * the two exceptions — the pairing, and a refused close's `resolvedBy` — tell it to.
   */
  stale: boolean;
  /** The status to write, or null to keep the stored one. */
  status: string | null;
  /** Whether the payload's assignee trio may overwrite the stored one. */
  assignee: boolean;
  /**
   * Whether the payload's UNVERSIONED fields may be written: the relations (contact, contact inbox,
   * inbox) and the attribute bags, which every payload carries, keeping the agent's attribute context
   * current without an extra API call. They need a recency fence: a conversation event can win on
   * version alone, and one with an older `last_activity_at` would roll a bag back (a Kanban card
   * jumping back a column) or restore a relation a contact merge moved (and the graph's thread key
   * is built from the contact inbox). Behind on this axis: state ruling kept, these fields silent.
   */
  unversioned: boolean;
  /** Version to stamp on the status mark, or null to leave it where it is. */
  statusAt: number | null;
  /**
   * Version to record as REFUSED BY THE LOCAL CLAIM, or null to leave the stored one. Written only
   * while the claim has no stamped version of its own, which is the window in which a refusal cannot
   * be told from a loss: the reconcile that stamps ours adjudicates this against it. Forward-only
   * like every mark here, so the newest refusal is the one kept. ./status-claim.ts.
   */
  statusClaimRefusedAt: number | null;
  /** Version to stamp on the assignee mark, or null to leave it where it is. */
  assigneeAt: number | null;
  /**
   * Whether the payload's redirect origin may overwrite the stored pairing, on a THIRD mark (see the
   * header). Ordered by version and NEVER by `last_activity_at`: recording the pairing is a column
   * write, which does not advance `last_activity_at`, so its own conversation_updated arrives with a
   * FROZEN activity timestamp and a recency fence would discard exactly the event with the answer.
   */
  redirectOrigin: boolean;
  /** Version to stamp on the redirect-origin mark, or null to leave it where it is. */
  redirectOriginAt: number | null;
  /**
   * `lastEventAt`, clamped so it never rewinds. This is both what gets WRITTEN and what gets
   * RETURNED: the webhook broadcasts it and the console sorts the conversation list on it, so
   * reporting a delayed payload's older timestamp would rewind every client's idea of recency.
   */
  activityAt: Date;
}

// A mark moves only forward, and only when the payload carries a version to move it to. Shared by
// both exits below because the stale branch writes the pairing too.
function advancesFrom(
  mark: number | null,
  version: number | null,
): number | null {
  return version != null && (mark == null || version > mark) ? version : null;
}

export function decideConversationWrites(
  payload: StatePayload,
  row: StateRow | null,
  now: Date,
): StateDecision {
  const eventAt = payload.activityAt ?? now;

  // NOTE: whether the payload ANSWERS the pairing question, which is not the same as speaking about
  // it. A stated pairing always answers; a stated NIL only when there was something to clear. The
  // fork ships the key on every conversation, and the column is NULL for every episode older than it,
  // so reading nil as an answer would stamp the mark on every live conversation at once after the
  // upgrade, and a stamped mark makes `episodeOriginQuery` refuse the recency fallback those episodes
  // run on. Chatwoot's column cannot tell the nulls apart either (a token naming no origin writes NULL
  // over NULL), so the only separator is whether a pairing was ever stated about this conversation.
  const redirectOriginAnswers =
    payload.redirectOriginStated &&
    (!payload.redirectOriginCleared || (row?.redirectOriginKnown ?? false));

  // NOTE: a payload can only be behind a row that exists, so with no row everything the payload
  // STATES is applied and claims its version. STATED, which is why both marks are conditional:
  // `mirrorChatwootEvent` defaults a created row to `open` when the payload had no status, and
  // claiming a version for that fabrication would protect it against the real `pending` or
  // `resolved` of a complete event delivered afterwards but serialized before.
  if (row === null) {
    return {
      stale: false,
      status: payload.status,
      assignee: payload.assigneeStated,
      unversioned: true,
      statusAt: payload.status != null ? payload.version : null,
      statusClaimRefusedAt: null,
      assigneeAt: payload.assigneeStated ? payload.version : null,
      redirectOrigin: redirectOriginAnswers,
      redirectOriginAt: redirectOriginAnswers ? payload.version : null,
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
  const olderThanRedirectOrigin =
    row.redirectOriginAt != null &&
    payload.version != null &&
    payload.version < row.redirectOriginAt;

  // NOTE: out-of-order guard, on the axis the event itself offers. A conversation event carrying a
  // version is judged by that version ONLY, never by `last_activity_at`: a handoff event delayed past
  // the human's first message carries the older value and would be discarded while being the newest
  // word. A version against a row with none (every conversation live at the migration) applies for
  // the same reason. Everything else falls back to `last_activity_at`: a message, which it describes
  // exactly, and a conversation event from a Chatwoot too old to send a version.
  const stale =
    payload.fromConversationEvent && payload.version != null
      ? olderThanStatus && olderThanAssignee
      : payload.activityAt != null &&
        row.activityAt != null &&
        row.activityAt > payload.activityAt;
  // NOTE: a stale payload still delivers a PAIRING it is ordered to deliver, the one exception here.
  // The pairing has its own mark, and the first payload to carry one is routinely behind on the
  // others (a retried snapshot, or any event on a conversation followed since before the fork had
  // the field). Discarding it wholesale leaves the episode unpaired and sends the caller to the
  // recency fallback, on a consumer that messages AND resolves what it picks. Nothing else leaks: the
  // flags below say so per field, so a delayed message cannot reopen or rewind the activity watermark.
  if (stale) {
    return {
      stale: true,
      status: null,
      assignee: false,
      unversioned: false,
      statusAt: null,
      statusClaimRefusedAt: null,
      assigneeAt: null,
      redirectOrigin: redirectOriginAnswers && !olderThanRedirectOrigin,
      redirectOriginAt:
        redirectOriginAnswers && !olderThanRedirectOrigin
          ? advancesFrom(row.redirectOriginAt, payload.version)
          : null,
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

  // NOTE: a REOPEN is ordered too, on the only axis a message payload has, because it is faithful
  // only AT ITS OWN INSTANT: every payload is a snapshot of an earlier moment (frozen at enqueue, or
  // rebuilt by a delivery recovery from earlier reads), so a message serialized BEFORE an operator's
  // resolve and delivered after would walk the status back to `pending` and get answered. Compared
  // as `activityAt` (the message's clock, which a resolve does not advance) against the status mark
  // at WHOLE SECONDS: the mark is `updated_at`, whose fraction runs a little ahead of the message it
  // accompanies, so a raw comparison refuses every same-second reopen to its own companion resolve.
  // Truncated, only a message from an EARLIER second is refused.
  const reopenOrdered =
    payload.reopensConversation &&
    (row.statusAt === null ||
      Math.floor(eventAt.getTime() / 1000) >= Math.floor(row.statusAt));
  // A LOCAL CLAIM OUTRANKS BOTH ROUTES ABOVE, and it is the only rule here that is not about a
  // version — because the write it protects had none to claim. A payload restating the status the
  // claim replaced is a snapshot from before that write, whichever axis it would have won on: the
  // reopen exception carries one (a customer message frozen while the toggle was on the wire), and
  // the ordinary ordered path carries the other (a delayed or companion `conversation_*` event, which
  // outranks a mark the claim never advanced). ./status-claim.ts holds the reasoning and the reason
  // this refuses ONE status rather than the field.
  const claim = statusClaimVerdict(
    row,
    {
      status: payload.status,
      reopens: payload.reopensConversation,
      version: payload.version,
    },
    now,
  );
  const writeStatus = claim === "apply" && (statusOrdered || reopenOrdered);
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
    advancesFrom(mark, payload.version);

  // NOTE: `>=` again, and not only for idempotence: the fork records the pairing and then dispatches
  // the conversation_updated it causes, so that write's companions and every message snapshot
  // serialized from the same row version agree by construction, and rejecting an equal version would
  // let delivery order pick between identical readings. A payload with NO version (Chatwoot < 4.0.2)
  // stamps nothing: with no key to order by, the last write wins.
  const redirectOrigin = redirectOriginAnswers && !olderThanRedirectOrigin;

  return {
    stale: false,
    status,
    assignee,
    unversioned: row.activityAt == null || eventAt >= row.activityAt,
    statusAt: status != null ? advances(row.statusAt) : null,
    // NOTE: a refusal the claim could not place is KEPT, on a mark of its own rather than the status
    // mark: we ack this event and Chatwoot never redelivers it, so dropping it would lose a hand-back
    // made while our toggle was on the wire, and the status mark would say the source stamped
    // something it did not. See ./status-claim.ts.
    statusClaimRefusedAt:
      claim === "refuse-and-defer"
        ? advancesFrom(row.statusClaimRefusedAt, payload.version)
        : null,
    assigneeAt: assignee ? advances(row.assigneeAt) : null,
    redirectOrigin,
    redirectOriginAt: redirectOrigin ? advances(row.redirectOriginAt) : null,
    activityAt:
      row.activityAt != null && row.activityAt > eventAt
        ? row.activityAt
        : eventAt,
  };
}
