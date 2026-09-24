import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import {
  type DebounceTickDeps,
  type LaneWait,
  runDebounceTick,
} from "@/modules/debounce/worker";
import type { ClaimedJob } from "@/modules/scheduler/service";

// Issue #812: a due flush that waits for a slot because the lane is full is announced ONCE, while it
// is still waiting, and only when the wait is the lane's doing. The clock, the claim, the query for
// waiting rows and the announcement are injected, so this runs without a DB; the DB-backed half is
// tests/modules/debounce-lane-wait-db.test.ts.

const base = {} as PrismaClient;
const THRESHOLD_MS = 30_000;
const T0 = new Date("2026-09-23T12:00:00.000Z").getTime();
const at = (ms: number) => new Date(T0 + ms);

let saved: number | undefined;
beforeEach(() => {
  saved = config.agent.capacityWaitAlertMs;
  config.agent.capacityWaitAlertMs = THRESHOLD_MS;
});

function job(id: number, tenantId = 1n): ClaimedJob {
  return {
    id: BigInt(id),
    tenantId,
    kind: "DEBOUNCE",
    payload: {},
    attempts: 0,
    claimSeq: 0,
  };
}

// Runs that stay pending until the test lets them go: the slots a hung model call holds.
const hung: Array<() => void> = [];
const hang = () =>
  new Promise<void>((resolve) => {
    hung.push(resolve);
  });
afterEach(async () => {
  for (const release of hung.splice(0)) release();
  await new Promise((r) => setTimeout(r, 0));
  if (saved !== undefined) config.agent.capacityWaitAlertMs = saved;
});

interface Row {
  id: bigint;
  tenantId: bigint;
  runAt: Date;
  dedupeKey: string;
}

// The world the lane sees: which rows are claimable on the next claim, and which rows are due and
// unclaimed when the lane asks who is waiting.
function world() {
  const claimable: ClaimedJob[] = [];
  const waitingRows: Row[] = [];
  const announced: LaneWait[] = [];
  const asked: Array<{ dueBefore: Date; exclude: bigint[] }> = [];
  let clock = 0;
  const deps: DebounceTickDeps = {
    now: () => at(clock),
    claim: async (limit, _b, _n, _t, excludeIds = []) =>
      claimable
        .splice(0)
        .filter((j) => !excludeIds.includes(j.id))
        .slice(0, limit),
    run: () => hang(),
    waiting: async (dueBefore, exclude) => {
      asked.push({ dueBefore, exclude: [...exclude] });
      return waitingRows.filter(
        (r) => r.runAt <= dueBefore && !exclude.includes(r.id),
      );
    },
    announce: (w) => {
      announced.push(w);
    },
  };
  return {
    deps,
    claimable,
    waitingRows,
    announced,
    asked,
    set: (ms: number) => {
      clock = ms;
    },
  };
}

// One tick, and the capacity question it may have started, which runs off the drain's path.
async function tick(slots: number, deps: DebounceTickDeps) {
  const out = await runDebounceTick(base, slots, deps);
  await out.reported;
  return out;
}

// Leaves the lane state as a fresh process would: a tick that finds room and nothing due.
async function emptyLane() {
  await runDebounceTick(base, 1, { claim: async () => [] });
}

const row = (id: number, runAtMs: number, tenantId = 1n): Row => ({
  id: BigInt(id),
  tenantId,
  runAt: at(runAtMs),
  dedupeKey: `debounce:t:${id}`,
});

describe("a flush waiting for a slot of a full lane", () => {
  beforeEach(emptyLane);

  test("is announced once it has waited past the threshold, with the wait and the limit", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps); // job 1 takes the only slot
    w.waitingRows.push(row(2, 2_000)); // due 2 s later, and nowhere to go
    w.set(2_500);
    await tick(1, w.deps);
    expect(w.announced).toEqual([]);
    w.set(32_500);
    await tick(1, w.deps);
    expect(w.announced).toHaveLength(1);
    expect(w.announced[0]).toMatchObject({
      jobId: 2n,
      tenantId: 1n,
      dedupeKey: "debounce:t:2",
      waitedMs: 30_500,
      thresholdMs: THRESHOLD_MS,
    });
  });

  test("is announced once, not once per tick while it keeps waiting", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    w.waitingRows.push(row(2, 0));
    for (const ms of [31_000, 33_500, 36_000, 60_000]) {
      w.set(ms);
      await tick(1, w.deps);
    }
    expect(w.announced.map((a) => a.jobId)).toEqual([2n]);
  });

  test("a row announced, claimed and due again later is a new wait, announced again", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    w.waitingRows.push(row(2, 0));
    w.set(31_000);
    await tick(1, w.deps);
    expect(w.announced).toHaveLength(1);
    // The slot frees and row 2 is claimed and runs to the end; then it is re-armed and stuck behind
    // another hung job.
    const flush = async () => {
      for (const release of hung.splice(0)) release();
      await new Promise((r) => setTimeout(r, 0));
    };
    await flush();
    w.waitingRows.splice(0);
    w.claimable.push(job(2));
    w.set(32_000);
    await tick(1, w.deps);
    await flush();
    w.claimable.push(job(3));
    w.set(35_000);
    await tick(1, w.deps);
    w.waitingRows.push(row(2, 40_000));
    w.set(71_000);
    await tick(1, w.deps);
    expect(w.announced.map((a) => a.jobId)).toEqual([2n, 2n]);
  });

  test("a wait below the threshold is not announced", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    w.waitingRows.push(row(2, 10_000));
    w.set(39_000);
    await tick(1, w.deps);
    expect(w.announced).toEqual([]);
  });

  test("the rows in flight are never announced as waiting", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    w.set(31_000);
    await tick(1, w.deps);
    expect(w.asked.at(-1)?.exclude).toContain(1n);
  });
});

describe("a wait that is not the lane's doing is not announced", () => {
  beforeEach(emptyLane);

  test("a lane with room never asks who is waiting", async () => {
    const w = world();
    w.claimable.push(job(1));
    w.waitingRows.push(row(9, -120_000));
    w.set(0);
    await tick(5, w.deps);
    w.set(60_000);
    await tick(5, w.deps);
    expect(w.asked).toEqual([]);
    expect(w.announced).toEqual([]);
  });

  test("time a row spent due before the lane filled does not count (a restart, a stopped worker)", async () => {
    const w = world();
    // Overdue by two minutes when this process first sees the lane full.
    w.waitingRows.push(row(2, -120_000));
    w.claimable.push(job(1));
    w.set(0);
    await tick(1, w.deps);
    w.set(20_000);
    await tick(1, w.deps);
    expect(w.announced).toEqual([]);
    w.set(30_000);
    await tick(1, w.deps);
    expect(w.announced).toHaveLength(1);
    expect(w.announced[0]?.waitedMs).toBe(30_000);
  });

  test("a lane that drains resets the clock: the next saturation measures from its own start", async () => {
    const w = world();
    w.claimable.push(job(1));
    w.set(0);
    await tick(1, w.deps);
    for (const release of hung.splice(0)) release();
    await new Promise((r) => setTimeout(r, 0));
    w.set(20_000);
    await tick(1, w.deps); // room, nothing due: not full any more
    w.claimable.push(job(3));
    w.set(25_000);
    await tick(1, w.deps); // full again from here
    w.waitingRows.push(row(4, 0));
    w.set(50_000);
    await tick(1, w.deps);
    expect(w.announced).toEqual([]);
    w.set(55_000);
    await tick(1, w.deps);
    expect(w.announced[0]?.waitedMs).toBe(30_000);
  });

  test("the question is not asked before the lane has been full for the threshold", async () => {
    const w = world();
    w.claimable.push(job(1));
    w.set(0);
    await tick(1, w.deps);
    w.set(29_000);
    await tick(1, w.deps);
    expect(w.asked).toEqual([]);
  });
});

describe("the threshold is the operator's", () => {
  beforeEach(emptyLane);

  test("a lower threshold announces a shorter wait", async () => {
    config.agent.capacityWaitAlertMs = 10_000;
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    w.waitingRows.push(row(2, 0));
    w.set(19_000);
    await tick(1, w.deps);
    expect(w.announced).toHaveLength(1);
    expect(w.announced[0]?.thresholdMs).toBe(10_000);
  });
});

describe("a failing announcement never costs the drain", () => {
  beforeEach(emptyLane);

  test("a row claimed while the question was open is not announced, and its next wait still is", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    w.waitingRows.push(row(2, 0));
    let answer: () => void = () => {};
    w.set(31_000);
    const out = await runDebounceTick(base, 1, {
      ...w.deps,
      waiting: async (dueBefore, exclude) => {
        const rows = await w.deps.waiting?.(dueBefore, exclude, base);
        await new Promise<void>((r) => {
          answer = r;
        });
        return rows ?? [];
      },
    });
    // Meanwhile job 1 ends and a tick claims row 2.
    for (const release of hung.splice(0)) release();
    await new Promise((r) => setTimeout(r, 0));
    w.claimable.push(job(2));
    w.set(32_000);
    await runDebounceTick(base, 1, { ...w.deps, waiting: async () => [] });
    answer();
    await out.reported;
    expect(w.announced).toEqual([]);
    // Row 2 runs to the end, is re-armed, and waits behind another job: that wait is announced.
    for (const release of hung.splice(0)) release();
    await new Promise((r) => setTimeout(r, 0));
    w.claimable.push(job(3));
    w.set(33_000);
    await tick(1, w.deps);
    w.waitingRows.splice(0);
    w.waitingRows.push(row(2, 40_000));
    w.set(71_000);
    await tick(1, w.deps);
    expect(w.announced.map((a) => a.jobId)).toEqual([2n]);
  });

  test("a row claimed and already finished while the question was open is not announced", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    w.waitingRows.push(row(2, 0));
    let answer: () => void = () => {};
    w.set(31_000);
    const out = await runDebounceTick(base, 1, {
      ...w.deps,
      waiting: async (dueBefore, exclude) => {
        const rows = await w.deps.waiting?.(dueBefore, exclude, base);
        await new Promise<void>((r) => {
          answer = r;
        });
        return rows ?? [];
      },
    });
    // Job 1 ends, a tick claims row 2 (filling the lane again, so the saturation goes on), and row
    // 2's run finishes too, all before the answer arrives.
    for (const release of hung.splice(0)) release();
    await new Promise((r) => setTimeout(r, 0));
    w.claimable.push(job(2));
    w.set(32_000);
    await runDebounceTick(base, 1, w.deps);
    for (const release of hung.splice(0)) release();
    await new Promise((r) => setTimeout(r, 0));
    answer();
    await out.reported;
    expect(w.announced).toEqual([]);
  });

  test("an answer to a question asked during a saturation that has since ended is dropped", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    w.waitingRows.push(row(2, 0));
    let answer: () => void = () => {};
    w.set(31_000);
    const out = await runDebounceTick(base, 1, {
      ...w.deps,
      waiting: async (dueBefore, exclude) => {
        const rows = await w.deps.waiting?.(dueBefore, exclude, base);
        await new Promise<void>((r) => {
          answer = r;
        });
        return rows ?? [];
      },
    });
    // The lane drains: a tick finds room and nothing due.
    for (const release of hung.splice(0)) release();
    await new Promise((r) => setTimeout(r, 0));
    w.set(32_000);
    await runDebounceTick(base, 1, w.deps);
    answer();
    await out.reported;
    expect(w.announced).toEqual([]);
  });

  test("a slow question neither delays the jobs just claimed nor the tick's return", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    for (const release of hung.splice(0)) release();
    await new Promise((r) => setTimeout(r, 0));
    // The lane is full again from job 2, and the question about who waits takes forever.
    let answer: () => void = () => {};
    const started: bigint[] = [];
    w.claimable.push(job(2));
    w.set(40_000);
    const out = await runDebounceTick(base, 1, {
      ...w.deps,
      run: (j) => {
        started.push(j.id);
        return hang();
      },
      waiting: () =>
        new Promise((resolve) => {
          answer = () => resolve([]);
        }),
    });
    expect(out.claimed).toBe(1);
    expect(started).toEqual([2n]);
    // A second tick while the question is still open does not stack another one on it.
    let asked = 0;
    await runDebounceTick(base, 1, {
      ...w.deps,
      waiting: async () => {
        asked++;
        return [];
      },
    });
    expect(asked).toBe(0);
    answer();
    await out.reported;
  });

  test("the waiting query throwing still leaves the claim done", async () => {
    const w = world();
    w.claimable.push(job(1));
    await tick(1, w.deps);
    w.set(31_000);
    const out = await runDebounceTick(base, 1, {
      ...w.deps,
      waiting: async () => {
        throw new Error("db down");
      },
    });
    expect(out.claimed).toBe(0);
  });
});
