import { describe, expect, test } from "bun:test";
import {
  classifyStrandedDelivery,
  type StrandedVerdict,
} from "@/modules/chatwoot/stranded-delivery";

// Whether a ledger row stuck non-terminal means a customer went unanswered, as a table.
//
// The table is short, and it got that way by deletion. It used to carry an "already answered"
// verdict decided by comparing the conversation's watermarks, and three review rounds of PR #282
// each found a different way that comparison closes a real loss — a watermark is a per-CONVERSATION
// high-water mark and the question is per-MESSAGE. That fact now comes from the ledger itself: a
// turn that runs over a message retires its row, so a row this function ever sees is one nothing
// covered. The effect is proved in delivery-sweep.test.ts, where a real turn retires a real row.
//
// What is left here is the age fence and the ORDER of the two questions, which is a decision. The
// boundaries are cheap here and expensive through a database.
//
// `ageMs` is the age of the current ATTEMPT, not of the receipt. The sweep resolves which clock that
// is before calling (a claimed row is measured from its claim), and that distinction has its own
// case in the sweep's test, where a real row can carry both timestamps.

const STALE_MS = 30 * 60 * 1000;
const NOW = new Date("2026-08-25T12:00:00.000Z");

function verdict(row: {
  ageMs: number;
  inboundMessageId: number | null;
  // The Chatwoot event name. `message_created` by default: the only shape this table is really
  // about, and the one every other column below is describing.
  event?: string;
  status?: "PENDING" | "PROCESSING";
  // Whether the age above is a CLAIM (the default, the common case) or only a receipt.
  claimed?: boolean;
  // The conversation the row names. Present by default: every event that reaches the ledger names
  // one, so its absence is a row an older build wrote.
  conversationId?: number | null;
  // When the two clocks disagree: how long ago the row was RECEIVED, against `ageMs` as the claim.
  receivedAgoMs?: number;
}): StrandedVerdict {
  const at = new Date(NOW.getTime() - row.ageMs);
  const claimed = row.claimed ?? true;
  return classifyStrandedDelivery(
    {
      event: row.event ?? "message_created",
      status: row.status ?? "PROCESSING",
      receivedAt: new Date(NOW.getTime() - (row.receivedAgoMs ?? row.ageMs)),
      claimedAt: claimed ? at : null,
      conversationId:
        row.conversationId === undefined ? 41 : row.conversationId,
      inboundMessageId: row.inboundMessageId,
    },
    { now: NOW, staleAfterMs: STALE_MS },
  );
}

describe("classifying a delivery stranded non-terminal", () => {
  const cases: Array<{
    name: string;
    ageMs: number;
    inboundMessageId: number | null;
    event?: string;
    status?: "PENDING" | "PROCESSING";
    claimed?: boolean;
    conversationId?: number | null;
    receivedAgoMs?: number;
    expected: StrandedVerdict;
  }> = [
    {
      name: "the attempt started a moment ago: a live process may still be working it",
      ageMs: 1_000,
      inboundMessageId: 50,
      expected: "in-flight",
    },
    {
      name: "one millisecond short of the threshold is still in flight",
      ageMs: STALE_MS - 1,
      inboundMessageId: 50,
      expected: "in-flight",
    },
    {
      name: "exactly at the threshold is stranded",
      ageMs: STALE_MS,
      inboundMessageId: 50,
      expected: "lost",
    },
    {
      // The two clocks, disagreeing. A redelivery is allowed to claim a row left stranded on
      // PENDING, so an attempt that started a minute ago must not be judged by a receipt from hours
      // ago — dated to the receipt, the sweep would mark a live delivery DEAD and page somebody
      // while the process answering it is still running.
      name: "an old receipt with a fresh claim is the fresh one that counts",
      ageMs: 60_000,
      receivedAgoMs: STALE_MS * 4,
      inboundMessageId: 50,
      expected: "in-flight",
    },
    {
      // And the claim is a restart of the same fence, not a shield: an attempt that claimed and then
      // died is exactly what this exists for.
      name: "once the CLAIM itself goes stale the row is reported",
      ageMs: STALE_MS * 2,
      receivedAgoMs: STALE_MS * 4,
      inboundMessageId: 50,
      expected: "lost",
    },
    {
      // A row NOTHING has claimed is dated by its receipt, and a fresh receipt is as protective as a
      // fresh claim. This is the PENDING row of a delivery that arrived a second ago: the ack is
      // spent before the row is even inserted, so between the insert and the opening CAS there is
      // always a live delivery holding a row no claim stamp names yet. Read as "unclaimed means
      // infinitely old", the sweep would mark it DEAD and page an operator about a message being
      // answered while it reads.
      name: "a row nothing has claimed is still in flight while its RECEIPT is fresh",
      ageMs: 1_000,
      claimed: false,
      status: "PENDING",
      inboundMessageId: 50,
      expected: "in-flight",
    },
    {
      // The order is the decision: a fresh row is left alone whatever it carries, because something
      // may still be working it and a verdict now would be about a live delivery.
      name: "fresh outranks the question about the message",
      ageMs: 1_000,
      inboundMessageId: null,
      expected: "in-flight",
    },
    {
      // The bot's own reply comes back as a `message_created` too, and a conversation update carries
      // no message at all. Neither is a customer waiting, so neither may appear in the loss list.
      name: "carried no inbound message: nothing was lost",
      ageMs: STALE_MS * 3,
      inboundMessageId: null,
      expected: "no-message",
    },
    {
      // A rolling deploy: the container still serving does not stamp the claim, and does not fill
      // either id either. Its nulls are UNRECORDED, so reading them literally would close every
      // message that container lost as "carried none" — on the rows a deploy is most likely to
      // strand.
      name: "PROCESSING with no claim stamp is a build we cannot read, not an empty delivery",
      ageMs: STALE_MS * 3,
      inboundMessageId: null,
      status: "PROCESSING",
      claimed: false,
      expected: "lost",
    },
    {
      // PENDING makes no promise about the CLAIM: nothing has claimed it. What it does promise is
      // the conversation, written at insert, so a row naming one was written by a build that had
      // the columns and its null message id means what it says.
      name: "PENDING with no claim stamp but a conversation is still just an empty delivery",
      ageMs: STALE_MS * 3,
      inboundMessageId: null,
      status: "PENDING",
      claimed: false,
      expected: "no-message",
    },
    {
      // And the old release's PENDING row: no claim, no conversation, nothing to read. It gets
      // inserted DURING the upgrade, after the backfill has already run past it.
      name: "PENDING naming no conversation at all is a build we cannot read",
      ageMs: STALE_MS * 3,
      inboundMessageId: null,
      conversationId: null,
      status: "PENDING",
      claimed: false,
      expected: "lost",
    },
    {
      // MEASURED: `webwidget_triggered` is the one event of the seven an Agent Bot receives whose
      // body is a CONTACT_INBOX, so `normalize.ts` reads no conversation from it (issue #257) and
      // the row is inserted with both ids null. Its signature is identical to an old build's PENDING
      // row, and read that way every one of them stranded before a claim would be a customer-loss
      // alert about an event nobody was waiting on.
      name: "an event that cannot carry a message never lost one, ids or no ids",
      ageMs: STALE_MS * 3,
      event: "webwidget_triggered",
      inboundMessageId: null,
      conversationId: null,
      status: "PENDING",
      claimed: false,
      expected: "no-message",
    },
    {
      // And a conversation event on the OTHER non-terminal state, which the fence reads as a build
      // it cannot parse whatever the conversation column says.
      name: "the event outranks the unreadable-build fence, on PROCESSING too",
      ageMs: STALE_MS * 3,
      event: "conversation_resolved",
      inboundMessageId: null,
      status: "PROCESSING",
      claimed: false,
      expected: "no-message",
    },
    {
      // The reason this is asked by NAME and not by "did it record a conversation": a
      // conversation-bearing event records one, and is still an event no customer is waiting on.
      name: "a conversation event that names its conversation is still no message",
      ageMs: STALE_MS * 3,
      event: "conversation_updated",
      inboundMessageId: null,
      expected: "no-message",
    },
    {
      // The other half of the same rule, and the reason the constant is `message_created` alone
      // rather than "a body shaped like a message": a `message_updated` is our own media write-back
      // coming around, `isNewIncomingMessage` refuses to drive a turn on it, and so nothing was ever
      // owed. On a current build its inbound id is null and the check below would say so anyway; on
      // a row from a build that wrote no ids, this is the only thing that can.
      name: "a message_updated never owed a turn, so it never lost one",
      ageMs: STALE_MS * 3,
      event: "message_updated",
      inboundMessageId: null,
      conversationId: null,
      status: "PENDING",
      claimed: false,
      expected: "no-message",
    },
    {
      // The guard is on the event NAME, not on the ids: a message event whose id columns an older
      // build never wrote is still the row this sweep exists for.
      name: "a message event from a build we cannot read is still a loss",
      ageMs: STALE_MS * 3,
      event: "message_created",
      inboundMessageId: null,
      conversationId: null,
      status: "PENDING",
      claimed: false,
      expected: "lost",
    },
    {
      name: "stranded with a customer message is a loss",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      expected: "lost",
    },
    {
      // Chatwoot ids start at 1, but the guard is on null and not on falsiness — a 0 would be a
      // message like any other, and reading it as "no message" would drop a loss from the list.
      name: "message id zero is a message, not an absence",
      ageMs: STALE_MS * 3,
      inboundMessageId: 0,
      expected: "lost",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        verdict({
          ageMs: c.ageMs,
          inboundMessageId: c.inboundMessageId,
          event: c.event,
          status: c.status,
          claimed: c.claimed,
          conversationId: c.conversationId,
          receivedAgoMs: c.receivedAgoMs,
        }),
      ).toBe(c.expected);
    });
  }
});
