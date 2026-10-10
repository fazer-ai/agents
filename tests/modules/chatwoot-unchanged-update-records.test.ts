import { beforeEach, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { mirrorOncePerEvent } from "@/modules/chatwoot/mirror-once";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import {
  isUnchangedMessageUpdate,
  markDeliveryPending,
  rememberOnSuccess,
  rememberProcessedDelivery,
  resetUnchangedUpdateRecords,
  trackConversationMirror,
  trackInboxSync,
  UNCHANGED_UPDATE_MESSAGES_MAX,
  UNCHANGED_UPDATE_PENDING_MAX,
  UNCHANGED_UPDATE_PENDING_TTL_MS,
  UNCHANGED_UPDATE_ROWS_MAX,
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
  lastActivityAt: 1_791_000_000,
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
      UNCHANGED_UPDATE_ROWS_MAX,
    );
    for (let i = 0; i <= n; i++) {
      rememberProcessedDelivery(1n, 1n, 9, event("message_created", i, i));
    }
    const sizes = unchangedUpdateRecordSizes();
    expect(sizes.messages).toBe(UNCHANGED_UPDATE_MESSAGES_MAX);
    expect(sizes.rows).toBe(UNCHANGED_UPDATE_ROWS_MAX);
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

  // Two runs of one conversation with different snapshots in flight together commit in an order their
  // completion does not show, so neither says what the row holds.
  test("overlapping mirror runs of a conversation leave no record", () => {
    const created = event("message_created", 1, 1);
    rememberProcessedDelivery(1n, 1n, 9, created);
    const a = trackConversationMirror(1n, 1n, created);
    const b = trackConversationMirror(1n, 1n, { ...created, labels: ["vip"] });
    b.done(true);
    a.done(true);
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", 1, 1)),
    ).toBe(false);
  });

  test("a receipt is not dropped while a mirror writing something else to its conversation is in flight", () => {
    const created = event("message_created", 1, 1);
    rememberProcessedDelivery(1n, 1n, 9, created);
    const run = trackConversationMirror(1n, 1n, {
      ...created,
      labels: ["vip"],
    });
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", 1, 1)),
    ).toBe(false);
    run.done(true);
    // That run wrote its own snapshot, at a tie: the row holds the labels now.
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, {
        ...event("message_updated", 1, 1),
        labels: ["vip"],
      }),
    ).toBe(true);
  });

  test("a mirror run that did not apply its snapshot whole forgets the record", () => {
    const created = event("message_created", 1, 1);
    rememberProcessedDelivery(1n, 1n, 9, created);
    trackConversationMirror(1n, 1n, created).done(false);
    rememberOnSuccess(1n, 1n, 9, created)();
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", 1, 1)),
    ).toBe(false);
  });

  test("a mirror run that throws forgets the record", async () => {
    const created = event("message_created", 1, 1);
    rememberProcessedDelivery(1n, 1n, 9, created);
    await expect(
      mirrorOncePerEvent(1n, 1n, created, {} as PrismaClient, {}, async () => {
        throw new Error("the mirror failed");
      }),
    ).rejects.toThrow("the mirror failed");
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, event("message_updated", 1, 1)),
    ).toBe(false);
  });

  const withContact = (msg: number, name: string, at: number) => ({
    ...event("message_created", msg, msg),
    lastActivityAt: at,
    contact: { id: 501, name },
  });

  // An older event still writes what its own clock lets it (the redirect pairing has a mark of its
  // own), so the last run, not the newest, is what the row holds.
  test("the last snapshot a run applied is the record, older or not", () => {
    rememberProcessedDelivery(1n, 1n, 9, withContact(1, "Ana", 2_000));
    rememberProcessedDelivery(1n, 1n, 9, withContact(2, "Bia", 1_000));
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, {
        ...withContact(1, "Ana", 2_000),
        event: "message_updated",
      }),
    ).toBe(false);
  });

  test("a newer snapshot of a shared row replaces the record", () => {
    rememberProcessedDelivery(1n, 1n, 9, withContact(1, "Ana", 1_000));
    rememberProcessedDelivery(1n, 1n, 9, withContact(2, "Bia", 2_000));
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, {
        ...withContact(1, "Ana", 1_000),
        event: "message_updated",
      }),
    ).toBe(false);
  });

  // A marker nothing releases (the sweep settled the row) cannot fence the conversation forever.
  test("a pending marker nobody releases expires after the drain's longest wait", () => {
    const created = event("message_created", 1, 1);
    rememberProcessedDelivery(1n, 1n, 9, created);
    markDeliveryPending(77n, 1n, 1n, { ...created, labels: ["vip"] }, 0);
    const receipt = event("message_updated", 1, 1);
    expect(isUnchangedMessageUpdate(1n, 1n, 9, receipt, 1_000)).toBe(false);
    expect(
      isUnchangedMessageUpdate(
        1n,
        1n,
        9,
        receipt,
        UNCHANGED_UPDATE_PENDING_TTL_MS + 1,
      ),
    ).toBe(true);
    expect(unchangedUpdateRecordSizes().pending).toBe(0);
  });

  // Past the bound the oldest marker goes, and with it what it fenced: nothing is dropped until it
  // would have expired.
  test("past its bound the pending bookkeeping stops dropping instead of growing", () => {
    const created = event("message_created", 1, 1);
    rememberProcessedDelivery(1n, 1n, 9, created);
    for (let i = 0; i <= UNCHANGED_UPDATE_PENDING_MAX; i++) {
      markDeliveryPending(
        BigInt(i + 1),
        1n,
        1n,
        event("message_created", 2, 2),
        0,
      );
    }
    expect(unchangedUpdateRecordSizes().pending).toBe(
      UNCHANGED_UPDATE_PENDING_MAX,
    );
    const receipt = event("message_updated", 1, 1);
    expect(isUnchangedMessageUpdate(1n, 1n, 9, receipt, 1_000)).toBe(false);
    expect(
      isUnchangedMessageUpdate(
        1n,
        1n,
        9,
        receipt,
        UNCHANGED_UPDATE_PENDING_TTL_MS + 1,
      ),
    ).toBe(true);
  });

  // The conversation row links to its contact, and a payload naming one fills a missing link.
  test("a receipt naming a contact the conversation's record did not is processed", () => {
    rememberProcessedDelivery(1n, 1n, 9, withContact(3, "Ana", 1_000));
    rememberProcessedDelivery(1n, 1n, 9, event("message_created", 1, 1));
    expect(
      isUnchangedMessageUpdate(1n, 1n, 9, {
        ...event("message_updated", 1, 1),
        contact: { id: 501, name: "Ana" },
      }),
    ).toBe(false);
  });

  test("an event with no conversation records no row, since the mirror writes none", () => {
    rememberProcessedDelivery(1n, 1n, 9, {
      ...event("message_created", 1, 1),
      conversationId: null,
      inboxName: "WhatsApp",
    });
    expect(unchangedUpdateRecordSizes().rows).toBe(0);
  });

  // An inbox sync writes the names from Chatwoot's list, outside the mirror.
  test("an inbox sync fences its account's inbox names and forgets them", () => {
    const named = { ...event("message_created", 1, 1), inboxName: "WhatsApp" };
    rememberProcessedDelivery(1n, 1n, 9, named);
    const receipt = { ...named, event: "message_updated" };
    expect(isUnchangedMessageUpdate(1n, 1n, 9, receipt)).toBe(true);
    const sync = trackInboxSync(1n, 1n);
    expect(isUnchangedMessageUpdate(1n, 1n, 9, receipt)).toBe(false);
    sync.done();
    expect(isUnchangedMessageUpdate(1n, 1n, 9, receipt)).toBe(false);
  });
});
