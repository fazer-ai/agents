import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { resetLandedAfter, stillInSameEpisode } from "@/graph/reset-episode";

// The comparison, as a table. It orders two CHATWOOT message ids — the one this turn is answering
// and the one the command carried — because the source's sequence is the order the operator and the
// customer actually experienced, and our own ledger row is inserted after the ack.
describe("whether the message predates the command", () => {
  const rows: [string, number | null, number | null, boolean][] = [
    ["never reset", 900, null, false],
    ["the message predates the command", 899, 900, true],
    // The command's own message carries the boundary, so a turn answering that id would be a turn on
    // the command itself.
    ["the command's own message", 900, 900, true],
    ["the message came after the command", 901, 900, false],
    // Not evidence of a reset: a caller that named no message (the playground, a test) leaves the
    // fence nothing to order, which is a different unknown from "the command landed".
    ["no trigger named itself", null, 900, false],
    ["neither", null, null, false],
  ];
  for (const [name, triggerId, resetId, expected] of rows) {
    test(name, () => {
      expect(resetLandedAfter(triggerId, resetId)).toBe(expected);
    });
  }
});

describe("a read that cannot answer", () => {
  // Shaped like `runScopedOn` uses it — `$extends`, then `$transaction`, then the GUC statement and
  // the query — so the failure under test is a READ that fails, not a stub that is missing a method.
  // A stub without `$extends` also lands in the same catch, and would pass both tests below while
  // proving nothing about a database.
  function base(tx: Record<string, unknown>): PrismaClient {
    return {
      $extends: () => ({
        $transaction: async (fn: (db: unknown) => Promise<unknown>) => fn(tx),
      }),
    } as unknown as PrismaClient;
  }
  const reading = {
    $executeRaw: async () => 1,
    conversation: {
      findUnique: async () => {
        throw new Error("connection reset");
      },
    },
  };
  const absent = {
    $executeRaw: async () => 1,
    conversation: { findUnique: async () => null },
  };
  const fence = (tx: Record<string, unknown>, triggerMessageId: number = 900) =>
    stillInSameEpisode({
      tenantId: 1n,
      conversationDbId: 7n,
      triggerMessageId,
      base: base(tx),
    });

  // It stops by THROWING, not by answering `false`. `false` is the word for "the operator withdrew
  // this run", and the direct path reads it as a message consumed on purpose: settled, out of the
  // loss list, no reply and no alert. A database blip must not be able to say that.
  test("stops the run inside the critical section, without calling it withdrawn", async () => {
    await expect(fence(reading)({ strict: true })).rejects.toThrow(
      "connection reset",
    );
  });

  test("lets the run reach its own fence at a send", async () => {
    expect(await fence(reading)({ strict: false })).toBe(true);
  });

  // A conversation row that is GONE is a different unknown, and not this fence's question: nothing
  // about a missing row says the operator asked for a clean slate. Same rule `jobNotRetiredSql`
  // writes for an absent job row — an unknown is not a retirement — and it holds under `strict`,
  // where a read that FAILED would stop the run.
  test("a row that is not there is not a reset, strict or not", async () => {
    expect(await fence(absent, 900)({ strict: true })).toBe(true);
    expect(await fence(absent, 900)({ strict: false })).toBe(true);
  });
});
