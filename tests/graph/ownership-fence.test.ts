import { describe, expect, test } from "bun:test";
import {
  type OwnershipVerdict,
  withOwnershipFence,
} from "@/graph/ownership-fence";

// Issue #717: the rules the tool boundary's ownership question follows, one by one. The wiring into
// the reactive turn and the follow-up is measured against the database in runtime.test.ts and
// nudge.test.ts; these are the branches a live run reaches only by timing.
const TAKEN = {
  ours: false,
  closed: { closedBy: "human_takeover" },
} as unknown as OwnershipVerdict;

function fence(
  over: {
    base?: boolean;
    ownedAtStart?: boolean;
    changed?: () => boolean;
    owns?: () => Promise<OwnershipVerdict>;
  } = {},
) {
  let reads = 0;
  const f = withOwnershipFence(async () => over.base ?? true, {
    ownedAtStart: over.ownedAtStart ?? true,
    ownerChangedByThisTurn: over.changed ?? (() => false),
    ownsNow: async () => {
      reads++;
      return (over.owns ?? (async () => ({ ours: true }) as const))();
    },
    conversationId: 1,
  });
  return { f, reads: () => reads };
}

describe("withOwnershipFence", () => {
  test("a conversation that changed hands refuses, and keeps the refusing read's detail", async () => {
    const { f } = fence({ owns: async () => TAKEN });
    expect(await f.ask()).toBe(false);
    expect(f.lost()).toEqual({
      closed: { closedBy: "human_takeover" },
    } as never);
  });

  test("still the bot's: the calls run", async () => {
    const { f, reads } = fence();
    expect(await f.ask()).toBe(true);
    expect(f.lost()).toBeNull();
    expect(reads()).toBe(1);
  });

  test("a withdrawal answers first, and is not an ownership loss", async () => {
    const { f, reads } = fence({ base: false, owns: async () => TAKEN });
    expect(await f.ask()).toBe(false);
    expect(f.lost()).toBeNull();
    expect(reads()).toBe(0);
  });

  test("a turn that did not start on the bot's conversation is not asked", async () => {
    const { f, reads } = fence({
      ownedAtStart: false,
      owns: async () => TAKEN,
    });
    expect(await f.ask()).toBe(true);
    expect(reads()).toBe(0);
  });

  test("after this turn changed the owner itself the question is not asked", async () => {
    const { f, reads } = fence({
      changed: () => true,
      owns: async () => TAKEN,
    });
    expect(await f.ask()).toBe(true);
    expect(reads()).toBe(0);
  });

  // Review round 2: calls of one batch run concurrently, so a label's ask can start before the
  // handoff beside it completes and read the status that handoff wrote.
  test("the turn's own change landing during the read is still the turn's own", async () => {
    let handedOff = false;
    const { f } = fence({
      changed: () => handedOff,
      owns: async () => {
        handedOff = true;
        return TAKEN;
      },
    });
    expect(await f.ask()).toBe(true);
    expect(f.lost()).toBeNull();
  });

  test("a read that fails lets the calls run", async () => {
    const { f } = fence({
      owns: async () => {
        throw new Error("db down");
      },
    });
    expect(await f.ask()).toBe(true);
    expect(f.lost()).toBeNull();
  });

  // The FIRST refusal is the one that stopped the tools; a later ask must not rewrite it.
  test("the detail kept is the first refusal's", async () => {
    const reads: OwnershipVerdict[] = [
      TAKEN,
      {
        ours: false,
        closed: { closedBy: "other" },
      } as unknown as OwnershipVerdict,
    ];
    const { f } = fence({ owns: async () => reads.shift() ?? TAKEN });
    await f.ask();
    await f.ask();
    expect(f.lost()).toEqual({
      closed: { closedBy: "human_takeover" },
    } as never);
  });
});
