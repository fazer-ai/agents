import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { resetLandedAfter, stillInSameEpisode } from "@/graph/reset-episode";

// The comparison, as a table. It orders two stamps from the SAME clock — the command's `now()` and
// the delivery's `received_at` column default — and asks one question about the DELIVERY, never
// about anything the turn read for itself.
describe("whether the command landed after the message arrived", () => {
  const t0 = new Date("2026-08-30T10:00:00.000Z");
  const later = new Date("2026-08-30T10:00:00.001Z");
  const earlier = new Date("2026-08-29T09:00:00.000Z");

  const rows: [string, Date | null, Date | null, boolean][] = [
    ["never reset", t0, null, false],
    ["the command landed after this message arrived", t0, later, true],
    ["the reset is older than the message", t0, earlier, false],
    // Nobody can order two stamps in the same millisecond, and the cheaper half of the coincidence
    // is one refused message rather than a turn acting on a conversation that was just cleared.
    ["the same millisecond stands the turn down", t0, new Date(t0), true],
    // Not evidence of a reset: a caller that named no delivery (the playground, a test) leaves the
    // fence nothing to order, which is a different unknown from "the command landed".
    ["no delivery named itself", null, later, false],
    ["neither", null, null, false],
  ];
  for (const [name, deliveredAt, resetAt, expected] of rows) {
    test(name, () => {
      expect(resetLandedAfter(deliveredAt, resetAt)).toBe(expected);
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
  const fence = (
    tx: Record<string, unknown>,
    deliveredAt: Date | null = null,
  ) =>
    stillInSameEpisode({
      tenantId: 1n,
      conversationDbId: 7n,
      deliveredAt,
      base: base(tx),
    });

  // It stops by THROWING, not by answering `false`. `false` is the word for "the operator withdrew
  // this run", and the direct path reads it as a message consumed on purpose: settled, out of the
  // loss list, no reply and no alert. A database blip must not be able to say that.
  test("stops the run inside the critical section, without calling it withdrawn", async () => {
    expect(fence(reading)({ strict: true })).rejects.toThrow(
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
    expect(await fence(absent, new Date())({ strict: true })).toBe(true);
    expect(await fence(absent, new Date())({ strict: false })).toBe(true);
  });
});

// THE CALL SITE IS WHERE THIS CAN GO SILENT. `deliveredAt` is optional on `RunAgentTurnParams`, for
// the reason the field states (the hundred-odd tests that drive a turn with no command racing it
// would each have to say so, which is the same call `authContext` right above it made). What that
// buys in signal it gives up in enforcement: a production caller that omits it gets a `null`
// fence with nothing to order, so every reset reads as older than the message and no turn ever
// stands down — silently, since nothing fails.
//
// So the enforcement is here, and it is a scan of the SOURCE because that is where the omission
// lives. One production call site today; the assertion on the count is what keeps a scan that
// suddenly matches nothing from passing as "every call site is fine".
describe("every production caller names the delivery it is answering", () => {
  test("runAgentTurn is never called without deliveredAt", async () => {
    const src = await Bun.file(
      new URL("../../src/modules/chatwoot/webhook.ts", import.meta.url),
    ).text();
    const anchor = "runAgentTurn({";
    const sites: string[] = [];
    for (
      let i = src.indexOf(anchor);
      i !== -1;
      i = src.indexOf(anchor, i + 1)
    ) {
      // The object literal, by balancing braces from the one the anchor opens — a fixed window would
      // measure whatever happens to follow, and the argument here is forty lines long.
      let depth = 0;
      let end = i + anchor.length - 1;
      for (let j = end; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      sites.push(src.slice(i, end + 1));
    }
    // A scan that finds nothing is as wrong as one that finds a bad site: the anchor would have
    // moved (a rename, a call built from a variable) and this test would go on passing forever.
    expect(sites).toHaveLength(1);
    for (const site of sites) expect(site).toContain("deliveredAt");
  });
});
