import { describe, expect, test } from "bun:test";
import {
  classifyStrandedDelivery,
  type StrandedVerdict,
} from "@/modules/chatwoot/stranded-delivery";

// Whether a ledger row stuck non-terminal means a customer went unanswered, as a table.
//
// Stated here rather than exercised only through the sweep because the sweep's own test drives one
// row at a time through a database: the boundaries (a row one millisecond short of stale, a message
// exactly at the watermark) are cheap here and expensive there, and the ORDER of the questions —
// which is a decision, not an implementation detail — has no other place that states it.

const STALE_MS = 30 * 60 * 1000;
const NOW = new Date("2026-08-25T12:00:00.000Z");

function verdict(row: {
  ageMs: number;
  inboundMessageId: number | null;
  handledMessageId: number | null;
}): StrandedVerdict {
  return classifyStrandedDelivery(
    {
      receivedAt: new Date(NOW.getTime() - row.ageMs),
      inboundMessageId: row.inboundMessageId,
    },
    {
      now: NOW,
      staleAfterMs: STALE_MS,
      handledMessageId: row.handledMessageId,
    },
  );
}

describe("classifying a delivery stranded non-terminal", () => {
  const cases: Array<{
    name: string;
    ageMs: number;
    inboundMessageId: number | null;
    handledMessageId: number | null;
    expected: StrandedVerdict;
  }> = [
    {
      name: "received a moment ago: a live process may still be working it",
      ageMs: 1_000,
      inboundMessageId: 50,
      handledMessageId: 10,
      expected: "in-flight",
    },
    {
      name: "one millisecond short of the threshold is still in flight",
      ageMs: STALE_MS - 1,
      inboundMessageId: 50,
      handledMessageId: 10,
      expected: "in-flight",
    },
    {
      name: "exactly at the threshold is stranded",
      ageMs: STALE_MS,
      inboundMessageId: 50,
      handledMessageId: 10,
      expected: "lost",
    },
    {
      name: "fresh outranks every other question",
      ageMs: 1_000,
      inboundMessageId: null,
      handledMessageId: null,
      expected: "in-flight",
    },
    {
      // The bot's own reply comes back as a `message_created` too, and a conversation update carries
      // no message at all. Neither is a customer waiting, so neither may appear in the loss list.
      name: "carried no inbound message: nothing was lost",
      ageMs: STALE_MS * 3,
      inboundMessageId: null,
      handledMessageId: null,
      expected: "no-message",
    },
    {
      name: "no inbound message outranks an unanswered watermark",
      ageMs: STALE_MS * 3,
      inboundMessageId: null,
      handledMessageId: 1,
      expected: "no-message",
    },
    {
      name: "the message is below the watermark: something else answered it",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      handledMessageId: 90,
      expected: "already-answered",
    },
    {
      name: "the watermark exactly at the message counts as answered",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      handledMessageId: 50,
      expected: "already-answered",
    },
    {
      name: "one below the message is not answered",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      handledMessageId: 49,
      expected: "lost",
    },
    {
      // The delivery died before the mirror write, so there is no watermark to compare against. The
      // safe reading of a question that cannot be answered is the one that puts the row in front of
      // an operator instead of closing it quietly.
      name: "an unknown conversation reads as unanswered, not as closed",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      handledMessageId: null,
      expected: "lost",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        verdict({
          ageMs: c.ageMs,
          inboundMessageId: c.inboundMessageId,
          handledMessageId: c.handledMessageId,
        }),
      ).toBe(c.expected);
    });
  }
});
