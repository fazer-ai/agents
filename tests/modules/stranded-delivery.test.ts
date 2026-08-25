import { describe, expect, test } from "bun:test";
import {
  classifyStrandedDelivery,
  type StrandedVerdict,
} from "@/modules/chatwoot/stranded-delivery";

// The rule the recovery sweep applies to a ledger row still on PROCESSING, as a table.
//
// Stated here rather than exercised only through the sweep because the sweep's own test can drive
// one row at a time through a database and a network stub: the boundaries (a row that is one
// millisecond short of stale, a row exactly at the attempt bound) are cheap here and expensive
// there, and the ORDER of the questions — which is a decision, not an implementation detail — has
// no other place that states it.

const STALE_MS = 10 * 60 * 1000;
const MAX = 3;
const NOW = new Date("2026-08-25T12:00:00.000Z");

function verdict(row: {
  ageMs: number;
  attempts: number;
  conversationId: number | null;
}): StrandedVerdict {
  return classifyStrandedDelivery(
    {
      receivedAt: new Date(NOW.getTime() - row.ageMs),
      attempts: row.attempts,
      conversationId: row.conversationId,
    },
    { now: NOW, staleAfterMs: STALE_MS, maxAttempts: MAX },
  );
}

describe("classifying a delivery stranded on PROCESSING", () => {
  const cases: Array<{
    name: string;
    ageMs: number;
    attempts: number;
    conversationId: number | null;
    expected: StrandedVerdict;
  }> = [
    {
      name: "claimed a moment ago: a live process may still be working it",
      ageMs: 1_000,
      attempts: 0,
      conversationId: 55,
      expected: "in-flight",
    },
    {
      name: "one millisecond short of the threshold is still in flight",
      ageMs: STALE_MS - 1,
      attempts: 0,
      conversationId: 55,
      expected: "in-flight",
    },
    {
      name: "exactly at the threshold is stale",
      ageMs: STALE_MS,
      attempts: 0,
      conversationId: 55,
      expected: "recover",
    },
    {
      name: "fresh beats every other question: attempts do not age a row",
      ageMs: 1_000,
      attempts: MAX + 10,
      conversationId: null,
      expected: "in-flight",
    },
    {
      name: "stale, names a conversation, attempts left",
      ageMs: STALE_MS * 3,
      attempts: 0,
      conversationId: 55,
      expected: "recover",
    },
    {
      name: "the last attempt still recovers",
      ageMs: STALE_MS * 3,
      attempts: MAX - 1,
      conversationId: 55,
      expected: "recover",
    },
    {
      name: "at the bound, recovery is given up on",
      ageMs: STALE_MS * 3,
      attempts: MAX,
      conversationId: 55,
      expected: "exhausted",
    },
    {
      name: "past the bound stays given up on",
      ageMs: STALE_MS * 3,
      attempts: MAX + 5,
      conversationId: 55,
      expected: "exhausted",
    },
    {
      name: "stale with no conversation: nothing to re-arm",
      ageMs: STALE_MS * 3,
      attempts: 0,
      conversationId: null,
      expected: "unrecoverable",
    },
    {
      // The ordering decision, and the reason it is a test rather than a comment: a row that names
      // no conversation can never be recovered however many attempts remain, so answering
      // "exhausted" here would name a retry budget it never spent and send an operator looking for
      // a transient fault that does not exist.
      name: "no conversation outranks an exhausted attempt count",
      ageMs: STALE_MS * 3,
      attempts: MAX + 5,
      conversationId: null,
      expected: "unrecoverable",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        verdict({
          ageMs: c.ageMs,
          attempts: c.attempts,
          conversationId: c.conversationId,
        }),
      ).toBe(c.expected);
    });
  }
});
