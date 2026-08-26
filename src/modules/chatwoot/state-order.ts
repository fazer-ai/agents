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
 * "Nothing to say" is about STATE. A payload also carries the redirect pairing, which is ordered by
 * its own mark and is not conversation state at all — so a payload discarded for state can still be
 * the only witness of a pairing, and is.
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
 * ## Why three marks and not one
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
 * The third mark, the redirect pairing, is the same argument reached from the other end. It is
 * written by an update of its own on the source row (fazer-ai/chatwoot#418), so from that write on it
 * describes a version neither of the other two does. It also cannot borrow their fallback: recording
 * the pairing writes a column, and by point 3 above a column write leaves `last_activity_at` exactly
 * where it was, so the event that carries the answer arrives with a frozen activity timestamp and a
 * recency fence would throw away precisely the payload it exists to keep.
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
   * Whether the payload's redirect origin may overwrite the stored pairing. A THIRD mark, for the
   * same reason there are already two: the pairing is written by its own update on the source row
   * (fazer-ai/chatwoot#418), so after that write the field legitimately reflects a different version
   * than the status and the assignee do.
   *
   * Ordered by version and NEVER by `last_activity_at`, which is the one axis that cannot see this
   * field move: recording the pairing writes a column, and a column write does not advance
   * `last_activity_at` at all. Its own conversation_updated therefore arrives carrying a FROZEN
   * activity timestamp, and a recency fence would discard exactly the event that carries the answer.
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

  // A payload can only be behind a row that exists. With no row there is nothing to protect and
  // nothing to order against, so everything the payload STATES is applied and claims its version.
  //
  // NOTE: Stated, which is why both marks are conditional. `mirrorChatwootEvent` defaults a created
  // row to `open` when the payload carried no status, and that default is a fabrication, not a
  // reading of the source. Claiming a version for it would protect it: a complete event delivered
  // afterwards but serialized before, carrying the real `pending` or `resolved`, would lose on
  // `olderThanStatus` and the invented `open` would stand until something newer arrived.
  // WHETHER THE PAYLOAD ANSWERS THE PAIRING QUESTION, which is not the same as speaking about it.
  //
  // A stated pairing always answers. A stated NIL only answers when there was something to clear:
  // the fork ships the key on every conversation once it is deployed, and the column is NULL for
  // every episode that began before it existed. Read as an answer, the first payload after the
  // upgrade converts "nobody ever told us" into "there is none" on EVERY live conversation at once —
  // which stamps the mark, and a stamped mark is what tells `episodeOriginQuery` to refuse the
  // recency fallback those episodes have always run on. They would lose their cross-link and every
  // later WhatsApp touch, with nothing in the data to say why.
  //
  // A clear is a TRANSITION, and Chatwoot's own column cannot say which null it is holding either:
  // a token that names no origin writes NULL over a NULL. So the only thing that separates the two
  // is on this side — whether a pairing was ever stated about this conversation before.
  const redirectOriginAnswers =
    payload.redirectOriginStated &&
    (!payload.redirectOriginCleared || (row?.redirectOriginKnown ?? false));

  if (row === null) {
    return {
      stale: false,
      status: payload.status,
      assignee: payload.assigneeStated,
      unversioned: true,
      statusAt: payload.status != null ? payload.version : null,
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
  // NOTE: A stale payload still delivers a PAIRING it is ordered to deliver, and that is the one
  // exception this branch has. `stale` means "behind the row on every axis this payload offers", and
  // until the third mark existed those axes were the whole payload. They are not any more: the
  // pairing is ordered by its own mark, and the first payload to carry one is routinely behind on the
  // others — a retried snapshot, or any event at all on a conversation the mirror has been following
  // since before the fork had the field, where the other two marks are set and this one is null.
  // Discarding it wholesale leaves the episode unpaired and sends the caller to the recency fallback
  // this column exists to remove, on a consumer that messages AND resolves what it picks.
  //
  // Nothing else leaks through: the flags below say so field by field, so a delayed message cannot
  // reopen a conversation or rewind the activity watermark on the pairing's ticket.
  if (stale) {
    return {
      stale: true,
      status: null,
      assignee: false,
      unversioned: false,
      statusAt: null,
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
    advancesFrom(mark, payload.version);

  // NOTE: `>=` again, and here it is not only idempotence. The fork records the pairing and then the
  // conversation_updated it causes is dispatched, so the companions of that one write — and every
  // message snapshot serialized from the same row version — agree by construction. Rejecting an
  // equal version would let delivery order decide which of two identical readings stands.
  //
  // A payload carrying NO version (Chatwoot < 4.0.2) writes and stamps nothing, which is the
  // pre-fence behaviour: there is no key to order by, so last write wins, as it did before.
  const redirectOrigin = redirectOriginAnswers && !olderThanRedirectOrigin;

  return {
    stale: false,
    status,
    assignee,
    unversioned: row.activityAt == null || eventAt >= row.activityAt,
    statusAt: status != null ? advances(row.statusAt) : null,
    assigneeAt: assignee ? advances(row.assigneeAt) : null,
    redirectOrigin,
    redirectOriginAt: redirectOrigin ? advances(row.redirectOriginAt) : null,
    activityAt:
      row.activityAt != null && row.activityAt > eventAt
        ? row.activityAt
        : eventAt,
  };
}
