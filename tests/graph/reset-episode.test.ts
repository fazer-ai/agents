import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { sameEpisode, stillInSameEpisode } from "@/graph/reset-episode";

// The comparison, as a table. It is a value comparison and not an ordering, so the row that matters
// most is the last one: a clock that moved backwards still reads as a different episode, because the
// question is "is this the reading my run started with", never "is this newer".
describe("the episode a run started in", () => {
  const t0 = new Date("2026-08-30T10:00:00.000Z");
  const t1 = new Date("2026-08-30T10:00:00.001Z");
  const before = new Date("2026-08-30T09:59:59.000Z");

  const rows: [string, Date | null, Date | null, boolean][] = [
    ["never reset, and still not", null, null, true],
    ["the first reset lands under the run", null, t0, false],
    ["the same reading, a different object", t0, new Date(t0.getTime()), true],
    ["a later reset", t0, t1, false],
    ["a mark that went backwards is still a different one", t0, before, false],
    // A conversation cannot un-reset itself, so this row is not a state the command produces. It is
    // here because the answer must not depend on which side is null: whatever put it there, this run
    // is no longer in the episode it started in.
    ["the mark disappeared", t0, null, false],
  ];
  for (const [name, started, now, expected] of rows) {
    test(name, () => {
      expect(sameEpisode(started, now)).toBe(expected);
    });
  }
});

// The `strict` contract runLoadedTurn states, from the one side this module owns: what an
// UNREADABLE answer means. Inside the critical section it has to stop the run (guessing "still
// wanted" recreates the thread /reset just cleared, and no later fence catches it); at a send it has
// to let the run continue, because throwing there abandons the bookkeeping of a message already
// delivered and the CAS at the end is the real fence.
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
  const fence = (tx: Record<string, unknown>, startedAt: Date | null = null) =>
    stillInSameEpisode({
      tenantId: 1n,
      conversationDbId: 7n,
      startedAt,
      base: base(tx),
    });

  test("stops the run inside the critical section", async () => {
    expect(await fence(reading)({ strict: true })).toBe(false);
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

// THE CALL SITE IS WHERE THIS CAN GO SILENT. `episodeAt` is optional on `RunAgentTurnParams`, for
// the reason the field states (the hundred-odd tests that drive a turn with no command racing it
// would each have to say so, which is the same call `authContext` right above it made). What that
// buys in signal it gives up in enforcement: a production caller that omits it gets a `null`
// baseline, which still catches a reset landing after the turn started and misses one that landed
// before — silently, since nothing fails.
//
// So the enforcement is here, and it is a scan of the SOURCE because that is where the omission
// lives. One production call site today; the assertion on the count is what keeps a scan that
// suddenly matches nothing from passing as "every call site is fine".
describe("every production caller names the episode it observed", () => {
  test("runAgentTurn is never called without episodeAt", async () => {
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
    for (const site of sites) expect(site).toContain("episodeAt:");
  });
});
