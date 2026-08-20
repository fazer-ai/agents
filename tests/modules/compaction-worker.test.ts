import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { defaultBatchSize, runCompactionTick } from "@/modules/memory/worker";
import type { ClaimedJob } from "@/modules/scheduler/service";

// Pure unit test for the tick's fan-out: `claim`/`run` are injected, so no DB and no provider are
// needed. Sibling of tests/modules/debounce-worker.test.ts, and for the sharper reason: this lane
// exists BECAUSE the scheduler drains serially, so a serial drain here would rebuild the same queue
// one level down.

const base = {} as PrismaClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function job(id: number): ClaimedJob {
  return {
    id: BigInt(id),
    tenantId: 1n,
    kind: "MEMORY_COMPACT",
    payload: {},
    attempts: 0,
  };
}

describe("runCompactionTick", () => {
  // The summarizer takes permits from the SAME semaphore a customer's turn does, so a batch sized at
  // the whole model budget lets compaction hold every one of them and a turn that just arrived waits
  // behind summaries. Nobody waits on this lane; somebody always waits on the other.
  //
  // Asserted ACROSS budgets, not only at the default: the invariant is "strictly less than the
  // budget", and the setting that breaks it is the small one. A floor of 1 reads as harmless at 20
  // and is 100% of the permits at 1, which src/config.ts accepts.
  test.each([
    [1, 0],
    [2, 1],
    [3, 1],
    [4, 1],
    [8, 2],
    [20, 5],
    [40, 10],
  ])("budget %d gives a batch of %d", (budget, expected) => {
    expect(defaultBatchSize(budget)).toBe(expected);
    expect(defaultBatchSize(budget)).toBeLessThan(budget);
  });

  test("the configured default never takes the whole model budget", () => {
    expect(defaultBatchSize()).toBeLessThan(config.agent.modelConcurrency);
  });

  // Batch 0 is the budget-of-1 case: the lane stands down rather than taking the only permit. It
  // still reaps, because a row left CLAIMED before the budget was lowered has no other reaper.
  test("a batch of 0 claims nothing and still reaps", async () => {
    let claimed = false;
    const out = await runCompactionTick(base, 0, {
      claim: async () => {
        claimed = true;
        return [job(1)];
      },
      run: async () => {},
      reap: async () => [
        {
          id: 9n,
          tenantId: 1n,
          kind: "MEMORY_COMPACT" as const,
          payload: {},
          attempts: 1,
          status: "PENDING" as const,
        },
      ],
    });
    expect(claimed).toBe(false);
    expect(out).toEqual({ claimed: 0, reaped: 1 });
  });

  test("drains the claimed batch concurrently, not serially", async () => {
    const jobs = [job(1), job(2), job(3)];
    const timeline: string[] = [];
    const run = async (j: ClaimedJob) => {
      timeline.push(`start:${j.id}`);
      await sleep(20);
      timeline.push(`end:${j.id}`);
    };

    const out = await runCompactionTick(base, 20, {
      claim: async () => jobs,
      run,
      reap: async () => [],
    });

    expect(out.claimed).toBe(3);
    // Concurrent: all three start before any finishes. Serial would read start,end,start,end,…, and
    // with a 60s ceiling per summary that is minutes of queue inside the lane.
    expect(timeline.slice(0, 3)).toEqual(["start:1", "start:2", "start:3"]);
  });

  test("a throwing job does not stall the rest of the batch (allSettled)", async () => {
    const jobs = [job(1), job(2), job(3)];
    const done: bigint[] = [];
    const run = async (j: ClaimedJob) => {
      if (j.id === 2n) throw new Error("boom");
      done.push(j.id);
    };

    const out = await runCompactionTick(base, 20, {
      claim: async () => jobs,
      run,
      reap: async () => [],
    });

    expect(out.claimed).toBe(3);
    expect(done.sort()).toEqual([1n, 3n]);
  });

  test("empty batch → claimed:0 and the runner is never called", async () => {
    let calls = 0;
    const out = await runCompactionTick(base, 20, {
      claim: async () => [],
      run: async () => {
        calls += 1;
      },
      reap: async () => [],
    });
    expect(out).toEqual({ claimed: 0, reaped: 0 });
    expect(calls).toBe(0);
  });

  // The two worker flags are independent, so with the scheduler off nothing else re-pends a row left
  // CLAIMED by a process that died mid-summary — and this tick only claims PENDING ones. That
  // attendance would wait on a future boundary that, for a resolved conversation, may never come.
  test("reaps its own stale claims, and only its own kind", async () => {
    const seen: (string | undefined)[] = [];
    const out = await runCompactionTick(
      base,
      20,
      {
        claim: async () => [],
        run: async () => {},
        reap: async (_stale, _base, _now, _tenant, kind) => {
          seen.push(kind);
          return [
            {
              id: 9n,
              tenantId: 1n,
              kind: "MEMORY_COMPACT",
              payload: {},
              attempts: 1,
              status: "PENDING" as const,
            },
          ];
        },
      },
      60_000,
    );
    expect(seen).toEqual(["MEMORY_COMPACT"]);
    expect(out.reaped).toBe(1);
  });

  // `enqueueJob` re-arms by upserting the SAME physical row back to PENDING, status included, so a
  // new attendance arming this key mid-summary makes the row claimable again. Claiming it a second
  // time is what does the damage in BOTH directions: a second handler cuts an overlapping prefix and
  // writes a duplicate durable summary, and the handler still running completes the newer arm out
  // from under it (both guarded only by id + CLAIMED), after which that attendance is never
  // compacted. So the id is excluded from the CLAIM, not filtered after it — left PENDING, the same
  // CAS is what protects the re-arm.
  test("a row running here is excluded from the claim, not claimed and dropped", async () => {
    const excluded: bigint[][] = [];
    const started: bigint[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const claim = async (
      _limit: number,
      _base?: PrismaClient,
      _now?: Date,
      _tenant?: bigint,
      excludeIds?: bigint[],
    ) => {
      excluded.push(excludeIds ?? []);
      // The row is only handed out when the caller did not exclude it.
      return (excludeIds ?? []).includes(7n) ? [] : [job(7)];
    };
    const run = async (j: ClaimedJob) => {
      started.push(j.id);
      await gate;
    };

    const first = runCompactionTick(base, 20, {
      claim,
      run,
      reap: async () => [],
    });
    await sleep(5);
    const second = await runCompactionTick(base, 20, {
      claim,
      run,
      reap: async () => [],
    });

    // The second tick asked for everything EXCEPT the row already running, and got nothing.
    expect(excluded[1]).toEqual([7n]);
    expect(second.claimed).toBe(0);
    expect(started).toEqual([7n]);

    release();
    await first;

    // Once its owner is done the id is released, so the row is claimable again.
    const third = await runCompactionTick(base, 20, {
      claim,
      run: async (j: ClaimedJob) => {
        started.push(j.id);
      },
      reap: async () => [],
    });
    expect(excluded[2]).toEqual([]);
    expect(third.claimed).toBe(1);
    expect(started).toEqual([7n, 7n]);
  });
});
