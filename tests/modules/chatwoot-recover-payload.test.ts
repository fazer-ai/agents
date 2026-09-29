import { describe, expect, test } from "bun:test";
import {
  isHumanAgentMessage,
  isNewIncomingMessage,
  normalizeChatwootEvent,
} from "@/modules/chatwoot/normalize";
import { buildRecoveryPayload } from "@/modules/chatwoot/recover-payload";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";

// The body a recovery rebuilds has to normalize to the same event the real one did. WEBHOOK is a
// body captured from the fork (Chatwoot 4.16.0, one incoming message to an Agent Bot), reduced to
// the fields `normalizeChatwootEvent` reads; the rebuild gets the same facts from the mirror (the
// conversation) and a REST read (the message), and the two normalized events are compared.
// The message half arrives the REST way on purpose: `Message#webhook_data` renders
// `message_type: "incoming"` and `Message#push_event_data` renders `message_type: 0`.

const CONV_DISPLAY = 1155;
const INBOX = 143;
const MESSAGE = 7054;
const CONTACT_INBOX = 771;
const OTHER_BOT = 10;
// Chatwoot's epoch seconds, which both sources give: the wire's `conversation.last_activity_at`
// and the REST message's `created_at`.
const SENT_AT = 1_787_780_064;
// The same instant, spelled the other way: `Message#webhook_data` serializes `created_at` as ISO
// 8601 while the REST message renders `created_at.to_i` (`_message.json.jbuilder`), so the rebuild
// carries the number and the wire the string, and `chatwootTimestamp` reads both.
const SENT_AT_ISO = new Date(SENT_AT * 1000).toISOString();

// Captured from the wire. Two shapes differ from the REST read: `message_type` is the enum string
// here and an integer over REST (why `messageTypeOf` exists), and a contact sender carries no
// `type` key here while REST stamps `type: "contact"`. `last_activity_at` (from
// `EventDataPresenter#push_timestamps`) anchors the mirror's `lastInboundAt`, so a rebuild without
// it would move the WhatsApp window to the recovery's clock. The mirror stores the "AgentBot"
// spelling of `assignee_type`, which the rebuild reproduces.
const WEBHOOK = {
  event: "message_created",
  id: MESSAGE,
  content: "sonda de duas rotas via HTTP",
  message_type: "incoming",
  private: false,
  content_attributes: {},
  created_at: SENT_AT_ISO,
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
    // conversation, and the key's presence is what says this instance speaks about pairings.
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
    event?: string;
  } = {},
) {
  return buildRecoveryPayload({
    event: over.event ?? "message_created",
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
      // NOTE: the REST spelling by default: that is what a recovery actually reads.
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
    // NOTE: compared as one object so a field added to the event later fails here instead of being
    // silently unrebuilt. Only `sender.type` is held out; a later test pins that difference.
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
    // NOTE: the mirror advances `lastInboundAt` from this and falls back to `now` without it. A
    // recovery runs at least a staleness window late, so the fallback would push the WhatsApp window
    // forward, in the unsafe direction: a later proactive send would read as in-window when it is not.
    const e = normalizeChatwootEvent(rebuilt());
    expect(e?.lastActivityAt).toBe(SENT_AT);
    // NOTE: the same number the captured body carries: the rebuild reproduces the wire.
    expect(e?.lastActivityAt).toBe(
      normalizeChatwootEvent(WEBHOOK)?.lastActivityAt,
    );

    // NOTE: absent stays null rather than inventing a time when the REST read gave none; the
    // mirror then stamps `now`.
    expect(
      normalizeChatwootEvent(rebuilt({ createdAt: null }))?.lastActivityAt,
    ).toBeNull();
  });

  // NOTE: as variáveis de idade leem o carimbo da mensagem, não da conversa. Uma recuperação só
  // existe porque a entrega encalhou, então o intervalo até o replay é exatamente a idade que o
  // agente precisa saber; sem o campo, a variável sairia vazia.
  test("o instante da mensagem viaja, e é o que as variáveis de idade leem", () => {
    const e = normalizeChatwootEvent(rebuilt());
    expect(e?.message?.createdAt?.getTime()).toBe(SENT_AT * 1000);
    // NOTE: o mesmo instante que o webhook capturado carrega: o replay reproduz o fio.
    expect(e?.message?.createdAt?.getTime()).toBe(
      normalizeChatwootEvent(WEBHOOK)?.message?.createdAt?.getTime(),
    );
    // NOTE: sem leitura, nulo: a idade some em vez de dizer "agora mesmo" sobre uma mensagem encalhada.
    expect(
      normalizeChatwootEvent(rebuilt({ createdAt: null }))?.message?.createdAt,
    ).toBeNull();
  });

  test("the redirect episode travels, because its consumer reads the event", () => {
    // NOTE: the fork renders `redirect_origin_display_id` only from `EventDataPresenter` (the
    // webhook path), never on the REST conversation show, so the mirror is its only source here.
    // `processChatwootDelivery` arms the REDIRECT_FOLLOWUP ladder from the event, not the row:
    // omitted, the ladder would message and resolve whichever sibling the mirror last knew.
    const e = normalizeChatwootEvent(rebuilt({ redirectOriginDisplayId: 991 }));
    expect(e?.redirectOriginDisplayId).toBe(991);

    // NOTE: the key is present even with no pairing: its absence means "this instance does not
    // speak about pairings" to the normalizer.
    const none = normalizeChatwootEvent(
      rebuilt({ redirectOriginDisplayId: null }),
    );
    expect(none?.redirectOriginDisplayId).toBeNull();
  });

  test("a voice note already transcribed travels with its transcription", () => {
    // NOTE: for `file_type: audio`, `Attachment#push_event_data` renders `transcribed_text` at the
    // top level and the REST view calls the same method, so the field sits where the normalizer
    // reads it. The eager-STT pass then reuses it ("never re-transcribe"), and the attachment is
    // carried through untouched rather than remapped, the same bytes a live delivery gets.
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
    // NOTE: `Contact#webhook_data` emits no `type` key, while REST stamps `type: "contact"`. The
    // rebuild keeps the REST value rather than erasing it (on an outgoing message it says a human
    // typed it). Inert here by reachability: the only reader, `isHumanAgentMessage`, needs an
    // outgoing message, and a recovery only rebuilds the inbound one `inboundMessageId` names.
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
    // NOTE: the event is always `message_created`, but the message type has to travel, or the bot's
    // own reply coming back around would read as a customer message and drive a turn answering itself.
    const e = normalizeChatwootEvent(rebuilt({ messageType: 1 }));
    expect(e?.message?.messageType).toBe("outgoing");
    expect(e && isNewIncomingMessage(e)).toBe(false);
  });

  test("an unassigned conversation says so, rather than saying nothing", () => {
    // NOTE: to the mirror, `undefined` means "not mentioned, keep what you have" and `null` a real
    // unassign. A recovery read the mirror, so it always says, or the ownership gate would judge the
    // conversation by the value this body came from.
    const e = normalizeChatwootEvent(
      rebuilt({ assigneeType: null, assigneeId: null, assigneeName: null }),
    );
    expect(e?.assigneeType).toBeNull();
    expect(e?.assigneeId).toBeNull();
  });

  test("a conversation the mirror knows no contact inbox for leaves it null", () => {
    const e = normalizeChatwootEvent(rebuilt({ contactInboxId: null }));
    expect(e?.contactInboxId).toBeNull();
    // NOTE: the rest still normalizes: the absence is not fatal to the event.
    expect(e?.conversationId).toBe(CONV_DISPLAY);
  });

  test("the status is the mirror's, because the gate asks about NOW", () => {
    // NOTE: a conversation a human opened while the row sat stranded must reach the gate as `open`,
    // which closes it; the status as of the strand would answer over the human.
    const e = normalizeChatwootEvent(rebuilt({ status: "open" }));
    expect(e?.status).toBe("open");
  });

  test("an unresolved inbox id leaves both spots empty rather than guessing", () => {
    const e = normalizeChatwootEvent(rebuilt({ inboxId: null }));
    expect(e?.inboxId).toBeNull();
    expect(e?.conversationId).toBe(CONV_DISPLAY);
  });
});
