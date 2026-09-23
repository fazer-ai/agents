import { describe, expect, test } from "bun:test";
import { withOwnershipFence } from "@/graph/ownership-fence";

// Issue #717: the rules the tool boundary's ownership question follows, one by one. The wiring into
// the reactive turn and the follow-up is measured against the database in runtime.test.ts and
// nudge.test.ts; these are the branches a live run reaches only by timing.
function fence(
  over: {
    base?: boolean;
    ownedAtStart?: boolean;
    handedOff?: boolean;
    owns?: () => Promise<boolean>;
  } = {},
) {
  let reads = 0;
  const f = withOwnershipFence(async () => over.base ?? true, {
    ownedAtStart: over.ownedAtStart ?? true,
    ownerChangedByThisTurn: () => over.handedOff ?? false,
    ownsNow: async () => {
      reads++;
      return (over.owns ?? (async () => true))();
    },
    conversationId: 1,
  });
  return { f, reads: () => reads };
}

describe("withOwnershipFence", () => {
  test("a conversation that changed hands refuses, and the fence remembers why", async () => {
    const { f } = fence({ owns: async () => false });
    expect(await f.ask()).toBe(false);
    expect(f.lostOwnership()).toBe(true);
  });

  test("still the bot's: the calls run", async () => {
    const { f, reads } = fence();
    expect(await f.ask()).toBe(true);
    expect(f.lostOwnership()).toBe(false);
    expect(reads()).toBe(1);
  });

  test("a withdrawal answers first, and is not an ownership loss", async () => {
    const { f, reads } = fence({ base: false, owns: async () => false });
    expect(await f.ask()).toBe(false);
    expect(f.lostOwnership()).toBe(false);
    expect(reads()).toBe(0);
  });

  test("a turn that did not start on the bot's conversation is not asked", async () => {
    const { f, reads } = fence({
      ownedAtStart: false,
      owns: async () => false,
    });
    expect(await f.ask()).toBe(true);
    expect(reads()).toBe(0);
  });

  test("after this turn's own handoff the question is not asked", async () => {
    const { f, reads } = fence({ handedOff: true, owns: async () => false });
    expect(await f.ask()).toBe(true);
    expect(reads()).toBe(0);
  });

  test("a read that fails lets the calls run", async () => {
    const { f } = fence({
      owns: async () => {
        throw new Error("db down");
      },
    });
    expect(await f.ask()).toBe(true);
    expect(f.lostOwnership()).toBe(false);
  });
});
