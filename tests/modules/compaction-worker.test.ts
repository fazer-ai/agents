import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { runCompactionTick } from "@/modules/memory/worker";
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
});
