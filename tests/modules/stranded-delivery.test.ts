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
  status?: "PENDING" | "PROCESSING";
  // Whether the age above is a CLAIM (the default, the common case) or only a receipt.
  claimed?: boolean;
  // When the two clocks disagree: how long ago the row was RECEIVED, against `ageMs` as the claim.
  receivedAgoMs?: number;
}): StrandedVerdict {
  const at = new Date(NOW.getTime() - row.ageMs);
  const claimed = row.claimed ?? true;
  return classifyStrandedDelivery(
    {
      status: row.status ?? "PROCESSING",
      receivedAt: new Date(NOW.getTime() - (row.receivedAgoMs ?? row.ageMs)),
      claimedAt: claimed ? at : null,
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
    status?: "PENDING" | "PROCESSING";
    claimed?: boolean;
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
      // PENDING makes no such promise: nothing has claimed it, so the missing stamp says nothing.
      name: "PENDING with no claim stamp and no message is still just an empty delivery",
      ageMs: STALE_MS * 3,
      inboundMessageId: null,
      status: "PENDING",
      claimed: false,
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
        verdict({
          ageMs: c.ageMs,
          inboundMessageId: c.inboundMessageId,
          status: c.status,
          claimed: c.claimed,
          receivedAgoMs: c.receivedAgoMs,
        }),
      ).toBe(c.expected);
    });
  }
});
