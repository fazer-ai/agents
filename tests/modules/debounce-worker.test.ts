import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { runDebounceTick } from "@/modules/debounce/worker";
import type { ClaimedJob } from "@/modules/scheduler/service";

// Pure unit test for the tick's fan-out: `claim`/`run` are injected, so no DB or Chatwoot is needed.
// It nails the exact change (serial for-await → concurrent Promise.allSettled).

const base = {} as PrismaClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function job(id: number): ClaimedJob {
  return {
    id: BigInt(id),
    tenantId: 1n,
    kind: "DEBOUNCE",
    payload: {},
    attempts: 0,
    claimSeq: 0,
  };
}

describe("runDebounceTick", () => {
  test("drains the claimed batch concurrently, not serially", async () => {
    const jobs = [job(1), job(2), job(3)];
    const timeline: string[] = [];
    const run = async (j: ClaimedJob) => {
      timeline.push(`start:${j.id}`);
      await sleep(20);
      timeline.push(`end:${j.id}`);
    };

    const out = await runDebounceTick(base, 20, {
      claim: async () => jobs,
      run,
    });

    expect(out.claimed).toBe(3);
    // Concurrent: all three start before any finishes. Serial would read start,end,start,end,...
    expect(timeline.slice(0, 3)).toEqual(["start:1", "start:2", "start:3"]);
  });

  test("a throwing job does not stall the rest of the batch (allSettled)", async () => {
    const jobs = [job(1), job(2), job(3)];
    const done: bigint[] = [];
    const run = async (j: ClaimedJob) => {
      if (j.id === 2n) throw new Error("boom");
      done.push(j.id);
    };

    const out = await runDebounceTick(base, 20, {
      claim: async () => jobs,
      run,
    });

    expect(out.claimed).toBe(3);
    expect(done.sort()).toEqual([1n, 3n]);
  });

  test("empty batch → claimed:0 and the runner is never called", async () => {
    let calls = 0;
    const out = await runDebounceTick(base, 20, {
      claim: async () => [],
      run: async () => {
        calls += 1;
      },
    });
    expect(out.claimed).toBe(0);
    expect(calls).toBe(0);
  });
});
