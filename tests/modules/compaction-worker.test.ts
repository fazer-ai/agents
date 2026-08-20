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
  test("the default batch leaves model capacity for customer turns", () => {
    expect(defaultBatchSize()).toBeLessThan(config.agent.modelConcurrency);
    expect(defaultBatchSize()).toBeGreaterThanOrEqual(1);
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
  // new attendance arming this key mid-summary makes the row claimable again. A second handler on it
  // cuts an overlapping raw prefix and writes a second durable summary under a different
  // last-message id — the memory head then describes the same events twice — and the older handler
  // also completes or fails a row the newer claim owns.
  test("a row already running here is not run a second time", async () => {
    const started: bigint[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = async (j: ClaimedJob) => {
      started.push(j.id);
      await gate;
    };
    const claim = async () => [job(7)];

    // First tick claims and starts it; it is still running when the second tick claims the same row.
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
    expect(second.claimed).toBe(0);
    expect(started).toEqual([7n]);

    release();
    await first;

    // Once it finishes, the row is runnable again — the guard is about overlap, not a one-shot.
    const third = await runCompactionTick(base, 20, {
      claim,
      run: async (j: ClaimedJob) => {
        started.push(j.id);
      },
      reap: async () => [],
    });
    expect(third.claimed).toBe(1);
    expect(started).toEqual([7n, 7n]);
  });
});
