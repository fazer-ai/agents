import { beforeEach, describe, expect, test } from "bun:test";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import {
  isUnchangedMessageUpdate,
  rememberProcessedDelivery,
  resetUnchangedUpdateRecords,
  UNCHANGED_UPDATE_CONVERSATIONS_MAX,
  UNCHANGED_UPDATE_MESSAGES_MAX,
  unchangedUpdateRecordSizes,
} from "@/modules/chatwoot/unchanged-update";

// The records behind the receipt drop live in memory: bounded, and gone on a restart,
// where a miss processes the update as before.

const event = (
  name: string,
  msg: number,
  conv: number,
): NormalizedChatwootEvent => ({
  event: name,
  conversationId: conv,
  contactInboxId: 77,
  inboxId: 7,
  status: "pending",
  conversationUpdatedAt: 1_791_000_100.5,
  message: {
    id: msg,
    content: "resposta",
    messageType: "outgoing",
    private: false,
    createdAt: null,
    sender: { type: "agent_bot", id: 9, name: "Atendente" },
    inReplyTo: null,
    isReaction: false,
    externalSenderName: null,
    emailSubject: null,
    emailBodyImages: [],
    imported: false,
    externalError: null,
    replyText: null,
    replyByOperator: false,
  } as NormalizedChatwootEvent["message"],
});

describe("unchanged-update records", () => {
  beforeEach(() => resetUnchangedUpdateRecords());

  test("a restart forgets: the first receipt after it is processed", () => {
    rememberProcessedDelivery(1n, 1n, 9, event("message_created", 1, 1));
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", 1, 1)),
    ).toBe(true);
    resetUnchangedUpdateRecords();
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", 1, 1)),
    ).toBe(false);
  });

  test("the records never exceed their bounds, and an evicted message is processed again", () => {
    const n = Math.max(
      UNCHANGED_UPDATE_MESSAGES_MAX,
      UNCHANGED_UPDATE_CONVERSATIONS_MAX,
    );
    for (let i = 0; i <= n; i++) {
      rememberProcessedDelivery(1n, 1n, 9, event("message_created", i, i));
    }
    const sizes = unchangedUpdateRecordSizes();
    expect(sizes.messages).toBe(UNCHANGED_UPDATE_MESSAGES_MAX);
    expect(sizes.conversations).toBe(UNCHANGED_UPDATE_CONVERSATIONS_MAX);
    // The oldest went first; the newest is still held.
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", 0, 0)),
    ).toBe(false);
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", n, n)),
    ).toBe(true);
  });

  // A repeat refreshes recency, so an active conversation is not the one evicted.
  test("a message seen again moves to the back of the eviction order", () => {
    rememberProcessedDelivery(1n, 1n, 9, event("message_created", 0, 0));
    for (let i = 1; i < UNCHANGED_UPDATE_MESSAGES_MAX; i++) {
      rememberProcessedDelivery(1n, 1n, 9, event("message_created", i, 0));
    }
    rememberProcessedDelivery(1n, 1n, 9, event("message_updated", 0, 0));
    rememberProcessedDelivery(
      1n,
      1n,
      9,
      event("message_created", UNCHANGED_UPDATE_MESSAGES_MAX, 0),
    );
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", 0, 0)),
    ).toBe(true);
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", 1, 0)),
    ).toBe(false);
  });
});
