import { afterEach, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import {
  type DebounceTickDeps,
  runDebounceTick,
  startDebounceWorker,
  stopDebounceWorker,
} from "@/modules/debounce/worker";
import type { ClaimedJob } from "@/modules/scheduler/service";

// Pure unit test for the drain: `claim`/`run` are injected, so no DB or Chatwoot is needed. The
// DB-backed half (real rows, the reaper, a re-arm) is tests/modules/debounce-drain-slots.test.ts.

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

// A run that stays pending until the test lets it go: the stand-in for a model call that does not
// return. Every test releases what it hung, because the in-flight set is process-wide and a job left
// in it would take a slot from the next test.
const hung: Array<() => void> = [];
function hang(): Promise<void> {
  return new Promise<void>((resolve) => {
    hung.push(resolve);
  });
}
afterEach(async () => {
  stopDebounceWorker();
  for (const release of hung.splice(0)) release();
  await sleep(0);
});

// Resolves to "timeout" when `p` has not settled within `ms`, so a drain that waits on a job that
// never settles fails an assertion instead of the test runner's own timeout.
function within<T>(p: Promise<T>, ms = 200): Promise<T | "timeout"> {
  return Promise.race([p, sleep(ms).then(() => "timeout" as const)]);
}

async function until(cond: () => boolean, ms = 1_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(5);
  }
  return cond();
}

// A queue of due rows: each claim takes up to `limit` of them, skipping the excluded ids, and
// records what it was asked. `again` puts a row back as due, which is what a re-arm or the reaper
// does to a row whose run is still in flight.
function dueQueue(ids: number[]) {
  const due = ids.map(job);
  const calls: Array<{ limit: number; exclude: bigint[] }> = [];
  const claim: NonNullable<DebounceTickDeps["claim"]> = async (
    limit,
    _base,
    _now,
    _tenantId,
    excludeIds = [],
  ) => {
    calls.push({ limit, exclude: [...excludeIds] });
    const out: ClaimedJob[] = [];
    for (const j of [...due]) {
      if (out.length >= limit) break;
      if (excludeIds.includes(j.id)) continue;
      due.splice(due.indexOf(j), 1);
      out.push(j);
    }
    return out;
  };
  return {
    claim,
    calls,
    again: (id: number) => due.push(job(id)),
    push: (id: number) => due.push(job(id)),
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
    await out.settled;

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
    await out.settled;

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
    await out.settled;
    expect(out.claimed).toBe(0);
    expect(calls).toBe(0);
  });

  // The test issue #807 asks for: one job whose run never settles, a second one that comes due after
  // it, and the second is claimed and run on the next tick.
  test("a job that never settles does not hold the next due job", async () => {
    const q = dueQueue([1]);
    const ran: bigint[] = [];
    const run = async (j: ClaimedJob) => {
      ran.push(j.id);
      if (j.id === 1n) await hang();
    };

    const first = await within(
      runDebounceTick(base, 20, { claim: q.claim, run }),
    );
    expect(first).not.toBe("timeout");

    q.push(2);
    const second = await within(
      runDebounceTick(base, 20, { claim: q.claim, run }),
    );
    expect(second).not.toBe("timeout");
    if (second === "timeout") return;
    expect(second.claimed).toBe(1);
    expect(await within(second.settled)).not.toBe("timeout");
    expect(ran).toEqual([1n, 2n]);
  });

  test("a job still in flight is kept out of the next claim, so it never runs twice at once", async () => {
    const q = dueQueue([1]);
    let runsOf1 = 0;
    const run = async (j: ClaimedJob) => {
      if (j.id === 1n) {
        runsOf1 += 1;
        await hang();
      }
    };

    await within(runDebounceTick(base, 20, { claim: q.claim, run }));
    // The row is due again while its first run is still pending (a re-arm, or the reaper).
    q.again(1);
    const second = await within(
      runDebounceTick(base, 20, { claim: q.claim, run }),
    );

    expect(q.calls[1]?.exclude).toEqual([1n]);
    expect(second === "timeout" ? -1 : second.claimed).toBe(0);
    expect(runsOf1).toBe(1);
  });

  test("a full lane does not claim at all, and a freed slot claims exactly one", async () => {
    const q = dueQueue([1, 2, 3, 4]);
    const run = async () => {
      await hang();
    };

    await within(runDebounceTick(base, 2, { claim: q.claim, run }));
    expect(q.calls.map((c) => c.limit)).toEqual([2]);

    const full = await within(
      runDebounceTick(base, 2, { claim: q.claim, run }),
    );
    expect(full === "timeout" ? -1 : full.claimed).toBe(0);
    // Not "a claim of zero": claimWhere clamps its limit to at least 1, so asking would take one more.
    expect(q.calls).toHaveLength(1);

    hung.shift()?.();
    await sleep(0);
    await within(runDebounceTick(base, 2, { claim: q.claim, run }));
    expect(q.calls.map((c) => c.limit)).toEqual([2, 1]);
  });

  test("a run that throws synchronously still frees its slot", async () => {
    const q = dueQueue([1, 2]);
    const run = ((j: ClaimedJob) => {
      if (j.id === 1n) throw new Error("sync boom");
      return Promise.resolve();
    }) as NonNullable<DebounceTickDeps["run"]>;

    const first = await within(
      runDebounceTick(base, 1, { claim: q.claim, run }),
    );
    expect(first).not.toBe("timeout");
    if (first !== "timeout") await first.settled;

    await within(runDebounceTick(base, 1, { claim: q.claim, run }));
    expect(q.calls.map((c) => c.limit)).toEqual([1, 1]);
    expect(q.calls[1]?.exclude).toEqual([]);
  });
});

describe("startDebounceWorker", () => {
  test("the interval keeps claiming while an earlier job is still running", async () => {
    const q = dueQueue([1]);
    const ran: bigint[] = [];
    const run = async (j: ClaimedJob) => {
      ran.push(j.id);
      if (j.id === 1n) await hang();
    };

    startDebounceWorker({
      base,
      intervalMs: 5,
      slots: 5,
      deps: { claim: q.claim, run },
    });
    expect(await until(() => ran.includes(1n))).toBe(true);
    q.push(2);

    expect(await until(() => ran.includes(2n))).toBe(true);
  });

  test("without an explicit slot count the lane is sized by the model semaphore", async () => {
    const saved = config.agent.modelConcurrency;
    // Not 20: the lane used to hard-code 20, which is also the semaphore's default, and a test on
    // the default would pass with the old constant.
    config.agent.modelConcurrency = 3;
    try {
      const q = dueQueue([1, 2, 3, 4, 5, 6]);
      let active = 0;
      let peak = 0;
      const run = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await hang();
        active -= 1;
      };

      startDebounceWorker({
        base,
        intervalMs: 5,
        deps: { claim: q.claim, run },
      });
      expect(await until(() => peak >= 3)).toBe(true);
      await sleep(50);

      expect(q.calls[0]?.limit).toBe(3);
      expect(peak).toBe(3);
    } finally {
      config.agent.modelConcurrency = saved;
    }
  });
});
