import { describe, expect, test } from "bun:test";
import {
  isHumanAgentMessage,
  isNewIncomingMessage,
  normalizeChatwootEvent,
} from "@/modules/chatwoot/normalize";
import { buildRecoveryPayload } from "@/modules/chatwoot/recover-payload";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";

// The body a recovery rebuilds has to normalize to the same event the real one did.
//
// This is an A/B against ground truth, not a shape assertion: WEBHOOK below is a body captured from
// the fork itself (Chatwoot 4.16.0, an Agent Bot pointed at a capture endpoint, one real incoming
// message), reduced to the fields `normalizeChatwootEvent` reads. The rebuild is fed the same facts
// from the two sources a recovery actually has — the mirror for the conversation, a REST read for
// the message — and the two normalized events are compared.
//
// It matters that the message half arrives the REST way: `Message#webhook_data` renders
// `message_type: "incoming"` and `Message#push_event_data` renders `message_type: 0`, measured on
// the same message. The rebuild is the first caller that feeds the second spelling to the
// normalizer.

const CONV_DISPLAY = 1155;
const INBOX = 143;
const MESSAGE = 7054;
const CONTACT_INBOX = 771;
const OTHER_BOT = 10;
// Chatwoot's epoch SECONDS, which is what both sources give: the wire's
// `conversation.last_activity_at` and the REST message's `created_at`.
const SENT_AT = 1_787_780_064;

// Captured. Two shapes here are the wire's and not the REST read's, and both were checked against
// the fork's own source (`Message#webhook_data`, `Contact#webhook_data`):
//
//   - `message_type` is the enum STRING on the wire and an INTEGER over REST, which is the whole
//     reason `messageTypeOf` exists;
//   - a contact SENDER carries no `type` key at all on the wire, while the REST read stamps
//     `type: "contact"` on it. MEASURED live against the local fork, not inferred.
//
// The conversation's `last_activity_at` is here for the same reason, read at the same source
// (`Conversations::EventDataPresenter#push_timestamps`): every real body carries it in epoch
// seconds, equal to `timestamp`. It is what the mirror advances `lastInboundAt` from, so a rebuild
// that omits it moves the WhatsApp window's anchor to the recovery's own clock. The REST message's
// `created_at` is the same instant, which is why it is the right source for it.
//
// `conversation.meta.assignee.type` is "agent_bot" on the wire; the mirror stores the "AgentBot"
// spelling that `assignee_type` carries, which is what the rebuild has to reproduce.
const WEBHOOK = {
  event: "message_created",
  id: MESSAGE,
  content: "sonda de duas rotas via HTTP",
  message_type: "incoming",
  private: false,
  content_attributes: {},
  sender: { id: 1102, name: "cliente" },
  attachments: [],
  inbox: { id: INBOX, name: "twobot-inbox" },
  conversation: {
    id: CONV_DISPLAY,
    inbox_id: INBOX,
    status: "pending",
    last_activity_at: SENT_AT,
    contact_inbox: { id: CONTACT_INBOX },
    // Always on the wire, nil included: the fork ships it from EventDataPresenter for every
    // conversation, and PRESENCE of the key is what says this instance speaks about pairings.
    redirect_origin_display_id: null,
    meta: {
      assignee_type: "AgentBot",
      assignee: { id: OTHER_BOT, name: "outro-bot" },
    },
  },
};

function rebuilt(
  over: {
    status?: string;
    assigneeType?: string | null;
    assigneeId?: number | null;
    assigneeName?: string | null;
    contactInboxId?: number | null;
    inboxId?: number | null;
    messageType?: unknown;
    inboxName?: string | null;
    createdAt?: number | null;
    attachments?: unknown[];
    redirectOriginDisplayId?: number | null;
    redirectOriginAt?: number | null;
  } = {},
) {
  return buildRecoveryPayload({
    conversation: {
      chatwootConversationId: CONV_DISPLAY,
      contactInboxId:
        over.contactInboxId === undefined ? CONTACT_INBOX : over.contactInboxId,
      status: over.status ?? "pending",
      assigneeType:
        over.assigneeType === undefined ? "AgentBot" : over.assigneeType,
      assigneeId: over.assigneeId === undefined ? OTHER_BOT : over.assigneeId,
      assigneeName:
        over.assigneeName === undefined ? "outro-bot" : over.assigneeName,
      redirectOriginDisplayId:
        over.redirectOriginDisplayId === undefined
          ? null
          : over.redirectOriginDisplayId,
      redirectOriginAt:
        over.redirectOriginAt === undefined ? null : over.redirectOriginAt,
    },
    inboxId: over.inboxId === undefined ? INBOX : over.inboxId,
    inboxName: over.inboxName === undefined ? "twobot-inbox" : over.inboxName,
    message: {
      id: MESSAGE,
      content: "sonda de duas rotas via HTTP",
      // The REST spelling by default: that is what a recovery actually reads.
      messageType: over.messageType === undefined ? 0 : over.messageType,
      private: false,
      contentAttributes: {},
      sender: { id: 1102, name: "cliente", type: "contact" },
      attachments: over.attachments ?? [],
      createdAt: over.createdAt === undefined ? SENT_AT : over.createdAt,
    },
  });
}

describe("rebuilding the body a stranded delivery no longer has", () => {
  test("normalizes to the same event the captured webhook did", () => {
    const fromWire = normalizeChatwootEvent(WEBHOOK);
    const fromRecovery = normalizeChatwootEvent(rebuilt());
    expect(fromWire).not.toBeNull();
    // Every field the gates downstream read, compared as one object rather than one assertion each:
    // a field added to the event later fails here instead of being silently unrebuilt.
    //
    // `sender.type` is held out, and only it — the next test is what holds that difference, so
    // nothing here is being papered over.
    expect({
      ...fromRecovery,
      message: { ...fromRecovery?.message, sender: null },
    }).toEqual({
      ...fromWire,
      message: { ...fromWire?.message, sender: null },
    });
    expect(fromRecovery?.message?.sender?.id).toBe(
      fromWire?.message?.sender?.id ?? null,
    );
    expect(fromRecovery?.message?.sender?.name).toBe(
      fromWire?.message?.sender?.name ?? null,
    );
  });

  test("the customer's own clock travels, so the 24h window is not moved by the rescue", () => {
    // The anchor `lastInboundAt` is advanced from, and the mirror falls back to `now` when the body
    // says nothing. A recovery runs at least a staleness window after the message, so the fallback
    // would push the WhatsApp window forward by however long the row sat stranded — and in the
    // unsafe direction: a proactive send made later reads as in-window when it is not.
    const e = normalizeChatwootEvent(rebuilt());
    expect(e?.lastActivityAt).toBe(SENT_AT);
    // The same number the captured body carries, which is the point: the rebuild reproduces the
    // wire rather than approximating it.
    expect(e?.lastActivityAt).toBe(
      normalizeChatwootEvent(WEBHOOK)?.lastActivityAt,
    );

    // Absent restores the old fallback rather than inventing a time, which is the honest answer
    // when the REST read gave none — the mirror then stamps `now`, as it always did.
    expect(
      normalizeChatwootEvent(rebuilt({ createdAt: null }))?.lastActivityAt,
    ).toBeNull();
  });

  test("the redirect episode travels, because its consumer reads the event", () => {
    // MEASURED both ways: the fork renders `redirect_origin_display_id` from `EventDataPresenter`
    // only — the webhook path — and the REST conversation show does not carry it at all. So the
    // mirror is authoritative for this one field and for nothing else in the conversation half.
    //
    // It has to travel because `processChatwootDelivery` arms the REDIRECT_FOLLOWUP ladder from
    // `n.redirectOriginDisplayId` and not from the row: omitted, the ladder is armed with nothing
    // and then messages and resolves whichever sibling the mirror last knew.
    const e = normalizeChatwootEvent(rebuilt({ redirectOriginDisplayId: 991 }));
    expect(e?.redirectOriginDisplayId).toBe(991);

    // And the KEY is present even when there is no pairing, which is the statement the normalizer
    // reads: absence means "this instance does not speak about pairings" and would leave a body
    // unable to say anything at all about the episode.
    const none = normalizeChatwootEvent(
      rebuilt({ redirectOriginDisplayId: null }),
    );
    expect(none?.redirectOriginDisplayId).toBeNull();
  });

  test("a voice note already transcribed travels with its transcription", () => {
    // MEASURED live against the fork, and it settles a review round that said otherwise: for
    // `file_type: audio`, `Attachment#push_event_data` renders `transcribed_text` at the TOP LEVEL
    // (`audio_metadata`: `meta&.[]('transcribed_text') || ''`), and the REST view calls that same
    // method — so the field sits exactly where `normalizeChatwootEvent` reads it.
    //
    // What that buys is the eager-STT pass reusing it instead of transcribing again: the delivery
    // path says so in as many words ("never re-transcribe"). A process that died AFTER the
    // write-back therefore costs the recovery nothing, and the attachment is carried through
    // untouched rather than remapped — the same bytes a live delivery gets.
    const e = normalizeChatwootEvent(
      rebuilt({
        attachments: [
          {
            id: 43,
            file_type: "audio",
            data_url: "https://chat.example/blob/nota.ogg",
            transcribed_text: "oi, preciso de ajuda",
            meta: { transcribed_text: "oi, preciso de ajuda" },
          },
        ],
      }),
    );
    expect(e?.message?.attachments?.[0]?.transcribedText).toBe(
      "oi, preciso de ajuda",
    );
  });

  test("the one field the two sources spell differently cannot decide anything", () => {
    // MEASURED against the local fork, both sides: `Contact#webhook_data` emits no `type` key at
    // all, so an incoming message off the wire normalizes to null, while the REST read stamps
    // `type: "contact"` on the same contact. The rebuild carries what REST gave it rather than
    // erasing it, because the REST spelling is the more informative of the two — on an OUTGOING
    // message it is what says a human agent typed it.
    //
    // Inert on this path, and it is reachability that makes it inert rather than a convention: the
    // only reader is `isHumanAgentMessage`, which requires an outgoing message, and a recovery only
    // ever rebuilds an inbound one — `inboundMessageId` is written for nothing else, and it is the
    // column the recovery reads the message id from.
    const fromWire = normalizeChatwootEvent(WEBHOOK);
    const fromRecovery = normalizeChatwootEvent(rebuilt());
    expect(fromWire?.message?.sender?.type).toBeNull();
    expect(fromRecovery?.message?.sender?.type).toBe("contact");
    expect(isHumanAgentMessage(fromWire as NormalizedChatwootEvent)).toBe(
      false,
    );
    expect(isHumanAgentMessage(fromRecovery as NormalizedChatwootEvent)).toBe(
      false,
    );
  });

  test("the REST integer message_type still owes a turn", () => {
    const e = normalizeChatwootEvent(rebuilt({ messageType: 0 }));
    expect(e?.message?.messageType).toBe("incoming");
  });

  test("a message that is NOT the customer's stays that way", () => {
    // The rebuild always names the event `message_created`, because that is the only event a
    // recovery exists for. The message TYPE is a separate fact and has to travel, or the body would
    // assert that whatever it carries is a customer message — and the bot's own reply, coming back
    // around, would drive a turn answering itself.
    const e = normalizeChatwootEvent(rebuilt({ messageType: 1 }));
    expect(e?.message?.messageType).toBe("outgoing");
    expect(e && isNewIncomingMessage(e)).toBe(false);
  });

  test("an unassigned conversation says so, rather than saying nothing", () => {
    // The distinction the mirror's sentinel rests on: `undefined` means the body did not mention the
    // assignee and the mirror preserves what it has; `null` means a real unassign. A recovery always
    // knows, because it read the mirror — so it must always say, or the ownership gate would judge a
    // conversation by a value this very body came from.
    const e = normalizeChatwootEvent(
      rebuilt({ assigneeType: null, assigneeId: null, assigneeName: null }),
    );
    expect(e?.assigneeType).toBeNull();
    expect(e?.assigneeId).toBeNull();
  });

  test("a conversation the mirror knows no contact inbox for leaves it null", () => {
    const e = normalizeChatwootEvent(rebuilt({ contactInboxId: null }));
    expect(e?.contactInboxId).toBeNull();
    // And the rest still normalizes: the absence is not fatal to the event.
    expect(e?.conversationId).toBe(CONV_DISPLAY);
  });

  test("the status is the mirror's, because the gate asks about NOW", () => {
    // A conversation that a human opened while the row sat stranded must reach the gate as `open`,
    // which is what closes it. Rebuilding the status as of the strand would answer over the human.
    const e = normalizeChatwootEvent(rebuilt({ status: "open" }));
    expect(e?.status).toBe("open");
  });

  test("an unresolved inbox id leaves both spots empty rather than guessing", () => {
    const e = normalizeChatwootEvent(rebuilt({ inboxId: null }));
    expect(e?.inboxId).toBeNull();
    expect(e?.conversationId).toBe(CONV_DISPLAY);
  });
});
