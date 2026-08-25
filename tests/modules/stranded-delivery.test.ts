import { describe, expect, test } from "bun:test";
import {
  classifyStrandedDelivery,
  type StrandedVerdict,
} from "@/modules/chatwoot/stranded-delivery";

// Whether a ledger row stuck non-terminal means a customer went unanswered, as a table.
//
// Stated here rather than exercised only through the sweep because the sweep's own test drives one
// row at a time through a database: the boundaries (a row one millisecond short of stale, a message
// exactly at the answered mark) are cheap here and expensive there, and the ORDER of the questions —
// which is a decision, not an implementation detail — has no other place that states it.
//
// `ageMs` is the age of the current ATTEMPT, not of the receipt. The sweep resolves which clock that
// is before calling (a claimed row is measured from its claim), and the distinction has its own case
// in the sweep's test, where a real row can carry both timestamps.

const STALE_MS = 30 * 60 * 1000;
const NOW = new Date("2026-08-25T12:00:00.000Z");

function verdict(row: {
  ageMs: number;
  inboundMessageId: number | null;
  answeredMessageId: number | null;
  coalesces?: boolean;
}): StrandedVerdict {
  return classifyStrandedDelivery(
    {
      attemptStartedAt: new Date(NOW.getTime() - row.ageMs),
      inboundMessageId: row.inboundMessageId,
    },
    {
      now: NOW,
      staleAfterMs: STALE_MS,
      answeredMessageId: row.answeredMessageId,
      coalesces: row.coalesces ?? true,
    },
  );
}

describe("classifying a delivery stranded non-terminal", () => {
  const cases: Array<{
    name: string;
    ageMs: number;
    inboundMessageId: number | null;
    answeredMessageId: number | null;
    coalesces?: boolean;
    expected: StrandedVerdict;
  }> = [
    {
      name: "received a moment ago: a live process may still be working it",
      ageMs: 1_000,
      inboundMessageId: 50,
      answeredMessageId: 10,
      expected: "in-flight",
    },
    {
      name: "one millisecond short of the threshold is still in flight",
      ageMs: STALE_MS - 1,
      inboundMessageId: 50,
      answeredMessageId: 10,
      expected: "in-flight",
    },
    {
      name: "exactly at the threshold is stranded",
      ageMs: STALE_MS,
      inboundMessageId: 50,
      answeredMessageId: 10,
      expected: "lost",
    },
    {
      name: "fresh outranks every other question",
      ageMs: 1_000,
      inboundMessageId: null,
      answeredMessageId: null,
      expected: "in-flight",
    },
    {
      // The bot's own reply comes back as a `message_created` too, and a conversation update carries
      // no message at all. Neither is a customer waiting, so neither may appear in the loss list.
      name: "carried no inbound message: nothing was lost",
      ageMs: STALE_MS * 3,
      inboundMessageId: null,
      answeredMessageId: null,
      expected: "no-message",
    },
    {
      name: "no inbound message outranks an unanswered mark",
      ageMs: STALE_MS * 3,
      inboundMessageId: null,
      answeredMessageId: 1,
      expected: "no-message",
    },
    {
      name: "the message is below the answered mark: a posted reply covered it",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      answeredMessageId: 90,
      expected: "already-answered",
    },
    {
      // The mark is an at-most-once CLAIM taken before the reply is sent, so level with this row's
      // own message means its own flush took the claim and then died — an intention nobody carried
      // out. Nothing else could put it exactly there: a later burst claims a LATER message.
      name: "the mark level with the message is a claim, not an answer",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      answeredMessageId: 50,
      expected: "lost",
    },
    {
      name: "one below the message is not answered",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      answeredMessageId: 49,
      expected: "lost",
    },
    {
      // The mark is proof only where the path COALESCES. With debouncing off each delivery answers
      // its own message directly, so a later message moves the mark past the stranded one without
      // the model ever having seen it — reading that as answered closes a real loss.
      name: "a later mark proves nothing when the agent does not coalesce",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      answeredMessageId: 90,
      coalesces: false,
      expected: "lost",
    },
    {
      name: "and a mark level with the message is lost either way",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      answeredMessageId: 50,
      coalesces: false,
      expected: "lost",
    },
    {
      name: "one past the message is the only mark that answers it",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      answeredMessageId: 51,
      expected: "already-answered",
    },
    {
      // The delivery died before the mirror write, so there is no mark to compare against. The
      // safe reading of a question that cannot be answered is the one that puts the row in front of
      // an operator instead of closing it quietly.
      name: "an unknown conversation reads as unanswered, not as closed",
      ageMs: STALE_MS * 3,
      inboundMessageId: 50,
      answeredMessageId: null,
      expected: "lost",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        verdict({
          ageMs: c.ageMs,
          inboundMessageId: c.inboundMessageId,
          answeredMessageId: c.answeredMessageId,
          coalesces: c.coalesces,
        }),
      ).toBe(c.expected);
    });
  }
});
