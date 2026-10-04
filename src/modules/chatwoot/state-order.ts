/**
 * Ordering rules for the conversation state the mirror keeps in sync with Chatwoot. Pure: no DB, no
 * clock. `mirrorChatwootEvent` collects the facts, calls this once and writes what it is told, so
 * the reasoning is a decision table (`tests/modules/chatwoot-state-order.test.ts`). The rule, why a
 * message snapshot moves no state, the reopen exception and why there are three marks:
 * docs/chatwoot.md, "Conversation state ordering".
 */

import { statusClaimVerdict } from "./status-claim";

// What the source does, read on the fork, cited by number below and in ./normalize.ts:
// 1. A MESSAGE event embeds a conversation SNAPSHOT serialized when it fired, not at delivery.
// 2. `handoff_to_human` posts before assigning the human, so a handoff burst ends in pre-handoff
//    state.
// 3. `last_activity_at` has one-second resolution and does not move on a status or assignee change.
// 4. `conversation.updated_at` is the row's sub-second version, moved by every write to it.
// 5. `AgentBots::WebhookJob` retries 3 times, 3s apart, so deliveries arrive out of order by ~9s.
// 6. A degraded payload (`meta` absent) states a trustworthy status and nothing about the assignee.
export interface StatePayload {
  /**
   * `conversation.updated_at`. Null on a Chatwoot older than 4.0.2, which sends no version. Compared
   * as raw unix-seconds doubles, never a `Date`: that rounds to the millisecond and merges two writes
   * microseconds apart into one version.
   */
  version: number | null;
  /** `last_activity_at`. Coarse (see 3 above), and the only axis the unversioned fields have. */
  activityAt: Date | null;
  /** False when the payload embeds a message snapshot (see 1 above). */
  fromConversationEvent: boolean;
  /** True for a brand-new incoming customer message, the one reopen a message carries faithfully. */
  reopensConversation: boolean;
  /**
   * The source's own word that THIS write moved the status or the holder: the status event itself,
   * or `status`/an assignee column among the event's `changed_attributes`. The only way to place a
   * change the row never saw (the event that carried it lost or still in flight), since the row then
   * already agrees with what this one states.
   */
  ownershipChangeStated: boolean;
  /** The status the payload states. Null means it stated none, so none is written. */
  status: string | null;
  /** False when the payload said nothing about the assignee: the degraded shape (see 6 above). */
  assigneeStated: boolean;
  /** The assignee type stated, null meaning unassigned. Only meaningful when `assigneeStated`. */
  assigneeType: string | null;
  /** The assignee id stated, read with `assigneeType` to tell a holder change from a restatement. */
  assigneeId: number | null;
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
  /** The ownership mark (see `ownershipChangedAt` on the decision). */
  ownershipChangedAt: number | null;
  assigneeAt: number | null;
  assigneeType: string | null;
  assigneeId: number | null;
  redirectOriginAt: number | null;
  /**
   * Whether this conversation has EVER had a pairing stated about it: the mark, or a stored origin
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
   * the two exceptions, the pairing and a refused close's `resolvedBy`, tell it to.
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
   * Version to stamp on the OWNERSHIP mark, or null to leave it. The status and assignee marks move
   * on every ordered event, a restatement included, which is what ordering snapshots needs; this one
   * moves only when the status or the holder written differs from the stored one, or the source says
   * one of them changed, and only forward. It answers whether a decision about who holds the
   * conversation came after a given version, which a restatement is not: the conversation_updated
   * Chatwoot emits for a person's own reply is one.
   */
  ownershipChangedAt: number | null;
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
   * doc named in the header). Ordered by version and NEVER by `last_activity_at`: recording the
   * pairing is a column write, which does not advance it (point 3), so its own conversation_updated
   * arrives with a FROZEN activity timestamp and a recency fence would discard exactly the event with
   * the answer.
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

  // Whether the payload ANSWERS the pairing question, which is not the same as speaking about
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
      ownershipChangedAt:
        payload.status != null || payload.assigneeStated
          ? payload.version
          : null,
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
  // A change the source states, arriving behind a newer restatement, still dates a decision: the
  // restatement moved the field marks and not the ownership mark, so this event is the only word
  // that the status or the holder moved in between. It moves the ownership mark (never the field)
  // on either exit. A row with no ownership mark is left alone: its fallback is the status mark,
  // already ahead of this version, and stamping here would leave the fence comparing against less.
  const lateChangeAt =
    (olderThanStatus || olderThanAssignee) &&
    payload.fromConversationEvent &&
    payload.ownershipChangeStated &&
    row.ownershipChangedAt != null
      ? advancesFrom(row.ownershipChangedAt, payload.version)
      : null;
  const olderThanRedirectOrigin =
    row.redirectOriginAt != null &&
    payload.version != null &&
    payload.version < row.redirectOriginAt;

  // Out-of-order guard, on the axis the event itself offers. A conversation event carrying a
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
      ownershipChangedAt: lateChangeAt,
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

  // `>=`, not `>`. An equal version is the same conversation row, so re-applying it is
  // idempotent, while REJECTING it is not: Chatwoot emits several events for one write
  // (conversation_updated + conversation_status_changed), and the one that arrives second is
  // frequently the one carrying `meta`. Under `>` the first delivery would win and its companion's
  // assignee would be dropped.
  const statusOrdered = payload.fromConversationEvent && !olderThanStatus;
  const assigneeOrdered = payload.fromConversationEvent && !olderThanAssignee;

  // A REOPEN is ordered too, on the only axis a message payload has, because it is faithful
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
  // version, because the write it protects had none to claim. A payload restating the status the
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

  // One rule for the EQUAL-version case, so the outcome cannot depend on delivery order. A
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

  // A mark moves when the field it belongs to is WRITTEN, and only forward. Unconditionally,
  // not "only if the value changed": the mirror frequently has not SEEN the change (when a resolve
  // is itself delayed, the row still reads `open` as the reopen lands), and withholding the version
  // on that basis leaves the delayed resolve looking newer than the mark. What keeps that safe is
  // the forward-only comparison: a message serialized BEFORE a conversation event carries a lower
  // version and cannot push the mark past it, and the reverse cannot happen, since the snapshot is
  // read from the row at dispatch (`set_conversation_activity` runs first), so a newer message
  // always saw the newer state.
  const advances = (mark: number | null): number | null =>
    advancesFrom(mark, payload.version);

  // `>=` again, and not only for idempotence: the fork records the pairing and then dispatches
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
    ownershipChangedAt:
      (status != null &&
        (status !== row.status || payload.ownershipChangeStated)) ||
      (assignee &&
        (payload.assigneeType !== row.assigneeType ||
          payload.assigneeId !== row.assigneeId ||
          payload.ownershipChangeStated))
        ? advances(row.ownershipChangedAt)
        : lateChangeAt,
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
