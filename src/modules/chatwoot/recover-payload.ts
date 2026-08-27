// The webhook body a stranded delivery no longer has, rebuilt from what survived it.
//
// A delivery that a process death stranded left a ledger row naming a conversation and a message,
// and nothing else: the event body was deliberately never stored, so that a customer's words are not
// held at rest a second time (issue #228). Recovering the turn (issue #295) means running the
// delivery path again, and the delivery path takes a webhook body.
//
// SO THIS REBUILDS A BODY, and hands it to `normalizeChatwootEvent` like any other. It does NOT
// build a `NormalizedChatwootEvent` directly, and that is the whole design: exactly one place knows
// how a Chatwoot payload becomes an event, the same place a live delivery goes through. Building the
// event here would be a second reader of the same shape, which is the defect this repo keeps paying
// for (issues #134, #177, and the `message_type` divergence this very path uncovered).
//
// THE TWO SOURCES, and why each field comes from the one it does:
//
//   - the CONVERSATION comes from the mirror, not from a re-read. The mirror is what every gate
//     downstream already consults, it is current rather than as-of-the-strand, and a recovery asks
//     "may this be answered NOW" — a status or an assignee that moved while the row sat stranded is
//     the answer, not noise to be papered over.
//   - the MESSAGE comes from a REST read, because it is the one thing the mirror does not hold.
//
// The two sources for the message spell two fields differently, and BOTH were measured live against
// the local fork rather than assumed — the REST view renders `message_type_before_type_cast` and
// `sender.push_event_data`, the wire renders the enum and `sender.webhook_data`:
//
//   - `message_type` is an INTEGER over REST and the enum STRING on the wire. `messageTypeOf` takes
//     both, which is the entire reason it exists (see normalize.ts).
//   - a contact SENDER carries `type: "contact"` over REST and no `type` key at all on the wire.
//     Carried through as REST gave it: the reader is `isHumanAgentMessage`, which needs an OUTGOING
//     message, and a recovery only ever rebuilds an inbound one.
//
// ATTACHMENTS are the field that does NOT diverge, and that was worth measuring too, because the
// eager-STT pass downloads a voice note from `data_url` off this body: both views render
// `attachments.map(&:push_event_data)`, the same method, so what a recovery hands the delivery path
// is what a live delivery handed it.
//
// WHAT IT DELIBERATELY DOES NOT CARRY, each one a field `normalizeChatwootEvent` reads and this body
// leaves out, so the omission is a decision on the record rather than an oversight:
//
//   - `meta.sender` — the contact's identity (phone, email, identifier) and its attribute bag, and
//     `conversation.custom_attributes` beside it. The attribute half is the easy half: those drive
//     the MIRROR's attribute merge, and the mirror is where this body's conversation half came from,
//     so re-merging them here would write the mirror back onto itself and a stale read would undo an
//     attribute an operator set while the row was stranded.
//
//     THE IDENTITY HALF IS NOT THE SAME ARGUMENT, and it is the harder one, because the live
//     conversation DOES render it (measured at the fork: `conversations#show` renders `meta.sender`
//     through the full contact partial, with `phone_number`, `email` and `identifier`). So it is
//     available, it is current, and a review round asked for it: a stranded message may be the very
//     event that would have refreshed the contact, and `authorizeContact` reads the STORED identity
//     on a gate that fails closed.
//
//     It still may not travel, and the reason is the POSITION rather than the value. The mirror
//     positions identity per field by the payload's `last_activity_at` (mirror.ts), and this body's
//     is the stranded message's own clock — deliberately, so a rescue does not stamp the customer's
//     words with the rescue's hour. An identity read NOW carried at a clock from THEN is exactly the
//     "source position, never a receipt time" the mirror forbids, and it does not merely fail to
//     help: MEASURED here, with the contact positioned at that same second by a sibling message of
//     the same burst and the live phone now different, the field is EMPTIED — the tie rule, which
//     cannot break a disagreement by arrival order, drops both readings. The contact then reads as
//     `no_identity` at the very gate the round wanted to protect, and the stored phone is gone.
//
//     There is no second position to carry it on: one payload has one clock, and it also orders the
//     status, the assignee and the inbound watermark. So the identity stays where the mirror already
//     holds it, absent means "said nothing" — the sentinel the mirror honours — and the exposure is
//     bounded by the next event on that conversation, which carries the identity at its own clock
//     and settles it. `tests/modules/chatwoot-recover-delivery.test.ts` pins the omission so this is
//     not quietly "fixed" back into the empty phone.
//   - the kanban card. Same reason, same sentinel.
export interface RecoveryConversation {
  // Chatwoot's per-account DISPLAY id — the only id this may hold (issue #257).
  chatwootConversationId: number;
  contactInboxId: number | null;
  status: string;
  assigneeType: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  // The WhatsApp thread this widget conversation is the redirect of, or null.
  //
  // The ONE field here the live account cannot answer, MEASURED both ways: the fork renders
  // `redirect_origin_display_id` from `EventDataPresenter` only — the webhook and cable path — and
  // the REST conversation show does not carry it at all. So the mirror is authoritative for this and
  // for nothing else, which is the opposite of every other field in this struct.
  //
  // It has to travel because its consumer reads the EVENT and not the row: `processChatwootDelivery`
  // arms the REDIRECT_FOLLOWUP ladder with `n.redirectOriginDisplayId`, and a body that omits it
  // arms the ladder with nothing — which then messages and resolves whichever sibling the mirror
  // last knew, or none.
  redirectOriginDisplayId: number | null;
  // The version that stamped that pairing (`chatwootRedirectOriginAt`), or null if nothing ever did.
  //
  // It travels WITH the pairing because on the wire the two are one fact: every real body carries
  // the pairing and the `updated_at` that orders it, and the mirror refuses an older pairing by
  // comparing them. Carrying one without the other is what makes a rebuilt body able to RESTORE a
  // pairing a re-entry replaced while the recovery was doing its REST reads — it states the old
  // value with no version, and an unversioned statement outranks nothing.
  redirectOriginAt: number | null;
}

export interface RecoveryMessage {
  id: number;
  content: string | null;
  // Either spelling. The REST read gives the integer; a caller replaying a captured body may give
  // the string. `messageTypeOf` is the one place that knows both.
  messageType: unknown;
  private: boolean;
  contentAttributes: Record<string, unknown> | null;
  sender: Record<string, unknown> | null;
  attachments: unknown[];
  // When the CUSTOMER sent it, in Chatwoot's epoch seconds, as the REST read gives it.
  //
  // Load-bearing, not decoration. It becomes the body's `last_activity_at`, which is what the mirror
  // reads to advance `lastInboundAt` — and that column anchors BOTH the follow-up "new episode" gate
  // and the WhatsApp 24h service window. Left out, `inboundAt` falls back to `now` and a recovery
  // moves the anchor forward by however long the row sat stranded, so a proactive send made later
  // reads as in-window when it is not. It also orders the mirror write correctly as OLD, so a
  // recovery cannot clobber conversation state that moved while the row was DEAD.
  //
  // Null when the read gave no timestamp, which restores the old fallback rather than inventing one.
  createdAt: number | null;
}

export function buildRecoveryPayload(params: {
  conversation: RecoveryConversation;
  // The CHATWOOT inbox id, not the mirror's foreign key. The mirror stores the FK, so the caller
  // resolves it; the body must carry what a real one carries. Null omits both spellings, which is
  // what a body carrying no route looks like — and the caller refuses to build one rather than pass
  // it, because `runAgentTurn` returns "skipped" on an event with no inbox.
  inboxId: number | null;
  // The inbox's name, from whichever row the id resolved to.
  //
  // Carried even though little would break without it, and the reason is the rule rather than this
  // field: its only consumer is the mirror's inbox upsert, where null means "preserve". "The rebuild
  // reproduces the body" is an invariant worth more than "the rebuild reproduces the body except
  // where I argued the gap was harmless", because the second one has to be re-argued every time a
  // field is added. The A/B test is what found it.
  //
  // Null is reachable, and it costs a placeholder rather than a wrong answer: an inbox the mirror
  // has no row for at all (the route came off the live message) upserts as `inbox <id>` until a real
  // webhook renames it. The REST reads carry no inbox NAME anywhere — the conversation renders the
  // scalar `inbox_id` and the channel type, nothing more — so the alternative is a third call to the
  // account for a field only that placeholder depends on.
  inboxName: string | null;
  message: RecoveryMessage;
}): Record<string, unknown> {
  const { conversation: c, message: m } = params;
  return {
    // Always the turn-bearing name. A recovery exists only for a message that owed an answer, and
    // `classifyStrandedDelivery` has already refused every other event before a row reaches here.
    event: "message_created",
    id: m.id,
    content: m.content,
    message_type: m.messageType,
    private: m.private,
    content_attributes: m.contentAttributes ?? {},
    sender: m.sender,
    attachments: m.attachments,
    // `inbox` carries the id for the shape that has no conversation scalar (issue #270). Both are
    // filled here because a real message body fills both.
    ...(params.inboxId !== null
      ? { inbox: { id: params.inboxId, name: params.inboxName } }
      : {}),
    conversation: {
      id: c.chatwootConversationId,
      ...(params.inboxId !== null ? { inbox_id: params.inboxId } : {}),
      status: c.status,
      // ALWAYS emitted, nil included, because PRESENCE of this key is the statement the normalizer
      // reads: the fork always ships it and a Chatwoot without the feature never does, so absence
      // means "this instance does not speak about pairings" and would leave the ladder unarmed.
      //
      // Sending the mirror's own value can only re-affirm what the row already holds. A null lands
      // as a CLEAR only where the row already knew a pairing (`redirectOriginAnswers` requires
      // `redirectOriginKnown`), and there the value being cleared is the one this read came from.
      redirect_origin_display_id: c.redirectOriginDisplayId,
      // Only when there IS one. A row nothing ever stamped cannot be regressed, and inventing a
      // version for it would order every other field in this body by a number nobody measured.
      ...(c.redirectOriginAt !== null
        ? { updated_at: c.redirectOriginAt }
        : {}),
      // The customer's own clock, on the field `normalizeChatwootEvent` reads it from. On the wire
      // this is the CONVERSATION's activity time, and for a `message_created` that is exactly this
      // message's — which is why the message's own timestamp is the right source for it.
      ...(m.createdAt !== null ? { last_activity_at: m.createdAt } : {}),
      ...(c.contactInboxId !== null
        ? { contact_inbox: { id: c.contactInboxId } }
        : {}),
      // The assignee block is the one the ownership gate reads, and it is present whenever the
      // mirror knows the conversation at all — which it does, or this row would not have been
      // classified. An unassigned conversation is `assignee: null` INSIDE a present meta, which is
      // "really unassigned"; omitting meta would say "said nothing" and leave the gate reading a
      // stale mirror it just came from.
      meta: {
        assignee_type: c.assigneeType,
        assignee:
          c.assigneeId === null
            ? null
            : { id: c.assigneeId, name: c.assigneeName },
      },
    },
  };
}
