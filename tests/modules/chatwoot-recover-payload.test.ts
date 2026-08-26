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

// Captured. Two shapes here are the wire's and not the REST read's, and both were checked against
// the fork's own source (`Message#webhook_data`, `Contact#webhook_data`):
//
//   - `message_type` is the enum STRING on the wire and an INTEGER over REST, which is the whole
//     reason `messageTypeOf` exists;
//   - a contact SENDER carries no `type` key at all on the wire, while the REST read stamps
//     `type: "contact"` on it. MEASURED live against the local fork, not inferred.
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
    contact_inbox: { id: CONTACT_INBOX },
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
      attachments: [],
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
