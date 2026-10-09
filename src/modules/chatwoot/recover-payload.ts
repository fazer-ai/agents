// The webhook BODY a stranded delivery no longer has (the claim clears the stored one), rebuilt for
// `normalizeChatwootEvent`: the conversation from the mirror, since a recovery asks "may this be
// answered NOW", and the message from a REST read. See docs/chatwoot.md, "Webhook receiver".

// Deliberately NOT carried (absent means "said nothing"): `conversation.custom_attributes`, which
// came from the mirror, so a stale read could undo an operator's attribute; and `meta.sender` and the
// kanban card, since an identity read now at the stranded message's clock can EMPTY the stored field
// under the mirror's tie rule (docs/chatwoot.md, "Mirror sync"). The next event settles it;
// tests/modules/chatwoot-recover-delivery.test.ts pins the omission.
export interface RecoveryConversation {
  // Chatwoot's per-account DISPLAY id, the only id this may hold.
  chatwootConversationId: number;
  contactInboxId: number | null;
  status: string;
  assigneeType: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  // The WhatsApp thread this widget conversation is the redirect of, or null. The one field the live
  // account cannot answer: the fork renders `redirect_origin_display_id` only from
  // `EventDataPresenter` (webhook and cable), never in the REST show, so the mirror is authoritative
  // here and nowhere else. It must travel because `processChatwootDelivery` arms the REDIRECT_FOLLOWUP
  // ladder from the EVENT, and a body without it arms the ladder with nothing.
  redirectOriginDisplayId: number | null;
  // The version that stamped that pairing (`chatwootRedirectOriginAt`), or null if nothing ever did.
  // It travels WITH the pairing because on the wire they are one fact and the mirror refuses an older
  // pairing by comparing them: the pairing alone, unversioned, could RESTORE one a re-entry replaced
  // while the recovery was doing its REST reads.
  redirectOriginAt: number | null;
}

// A message as the REST read gives it. REST and the wire spell two fields differently: `message_type`
// is an INTEGER over REST and the enum STRING on the wire (`messageTypeOf` in ./normalize.ts takes
// both), and a contact SENDER carries `type: "contact"` over REST and no `type` on the wire, kept as
// REST gives it because its reader (`isHumanAgentMessage`) needs an OUTGOING message and a recovery
// rebuilds an inbound one. Attachments do not diverge: both views render
// `attachments.map(&:push_event_data)`, so the eager STT pass downloads from the same `data_url`.
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
  // When the CUSTOMER sent it, in Chatwoot's epoch seconds, as the REST read gives it. It becomes the
  // body's `last_activity_at`, which advances `lastInboundAt`, the anchor of both the follow-up "new
  // episode" gate and the WhatsApp 24h window: left out, `inboundAt` falls back to `now` and a later
  // proactive send reads as in-window when it is not. It also orders the mirror write as OLD, so a
  // recovery cannot clobber state that moved while the row was DEAD. Null when the read gave none.
  createdAt: number | null;
}

// Local, like the copies in ./messages.ts and ./normalize.ts beside it.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The three keys an eager pass writes back, spelled at the top level of an attachment the way a
// webhook carries them, from the `meta` the REST read carries them in. Anything that is not a record
// is passed through: this reproduces a body, it does not validate one.
const ANALYSIS_META_KEYS = [
  "transcribed_text",
  "image_description",
  "extracted_text",
] as const;

function liftAnalysisMeta(attachments: unknown[]): unknown[] {
  return attachments.map((a) => {
    if (!isRecord(a)) return a;
    const meta = isRecord(a.meta) ? a.meta : null;
    if (meta === null) return a;
    const lifted: Record<string, unknown> = { ...a };
    for (const key of ANALYSIS_META_KEYS) {
      if (typeof a[key] === "string" && a[key] !== "") continue;
      const v = meta[key];
      if (typeof v === "string" && v !== "") lifted[key] = v;
    }
    return lifted;
  });
}

export function buildRecoveryPayload(params: {
  // The event name the ledger recorded, replayed verbatim. A recovery gets either a customer message's
  // creation or the `message_updated` that carried its transcription; a creation drives a turn and an
  // update never does, so a transcription rebuilt as a creation would answer an answered customer.
  event: string;
  conversation: RecoveryConversation;
  // The CHATWOOT inbox id, not the mirror's foreign key. The mirror stores the FK, so the caller
  // resolves it; the body must carry what a real one carries. Null omits both spellings, which is
  // what a body carrying no route looks like, and the caller refuses to build one rather than pass
  // it, because `runAgentTurn` returns "skipped" on an event with no inbox.
  inboxId: number | null;
  // The inbox's name, from whichever row the id resolved to. Its only consumer is the mirror's inbox
  // upsert (null means "preserve"), but it is carried because "the rebuild reproduces the body" holds
  // only without exceptions: "except where the gap looks harmless" is re-argued with every new field.
  // Null upserts a placeholder `inbox <id>` until a real webhook renames it; the REST reads carry no
  // inbox name, so the alternative is a third account call for that placeholder alone.
  inboxName: string | null;
  message: RecoveryMessage;
}): Record<string, unknown> {
  const { conversation: c, message: m } = params;
  return {
    // The row's own. `classifyStrandedDelivery` has already refused every event but the two that can
    // owe something, and which of the two this is decides what the replay may do.
    event: params.event,
    id: m.id,
    content: m.content,
    message_type: m.messageType,
    private: m.private,
    content_attributes: m.contentAttributes ?? {},
    sender: m.sender,
    // NOTE: translated, not forwarded. A webhook attachment carries `transcribed_text` at the top
    // level, which `normalizeChatwootEvent` reads, while the REST list carries it under `meta`
    // (./messages.ts); handed through unchanged, a transcription strand rebuilds with no words and is
    // refused as a degraded read. Vision is lifted too, or a creation's replay pays the provider again.
    // Lifted only where the top level is silent, so a webhook-shaped body passes through untouched.
    attachments: liftAnalysisMeta(m.attachments),
    // NOTE: when the message arrived, at the top level and not only under the conversation: a
    // recovery is the body least likely to be seconds old, and the age variables read the MESSAGE's
    // own field. The conversation's `last_activity_at` below carries the same instant for the 24h window.
    ...(m.createdAt !== null ? { created_at: m.createdAt } : {}),
    // NOTE: `inbox` carries the id for the shape that has no conversation scalar. Both are filled
    // here because a real message body fills both.
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
      // message's, which is why the message's own timestamp is the right source for it.
      ...(m.createdAt !== null ? { last_activity_at: m.createdAt } : {}),
      ...(c.contactInboxId !== null
        ? { contact_inbox: { id: c.contactInboxId } }
        : {}),
      // The assignee block is the one the ownership gate reads, and it is present whenever the
      // mirror knows the conversation at all, which it does, or this row would not have been
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
