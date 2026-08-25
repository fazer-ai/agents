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
}): StrandedVerdict {
  return classifyStrandedDelivery(
    {
      attemptStartedAt: new Date(NOW.getTime() - row.ageMs),
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
        verdict({ ageMs: c.ageMs, inboundMessageId: c.inboundMessageId }),
      ).toBe(c.expected);
    });
  }
});
