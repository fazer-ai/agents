import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { Semaphore } from "@/lib/semaphore";
import { armObserve } from "@/modules/observe/job";
import type { MonitoringConfig } from "@/modules/observe/settings";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import {
  getJobHandler,
  type JobHandler,
  registerJobHandler,
  runObserveTick,
  runSchedulerTick,
  startScheduler,
  stopScheduler,
  unregisterJobHandler,
  wakeObserveDrainAt,
} from "@/modules/scheduler/worker";
import { POLL_DEADLINE_MS } from "@/tests/utils/poll";

// The observe lane's fast drain (src/modules/scheduler/worker.ts, runObserveTick). A monitoring
// agent's verdict is read while the conversation is happening, so what is asserted here is WHEN a
// due OBSERVE row starts and under which bound, against the database and the worker's own timers.
// Every case fences on this file's tenant: the claim is cross-tenant by design.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
const past = () => new Date(Date.now() - 60_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(holds: () => boolean, ms = POLL_DEADLINE_MS) {
  const end = Date.now() + ms;
  while (!holds() && Date.now() < end) await sleep(10);
}

async function arm(key: string, kind: "OBSERVE" | "FOLLOWUP" = "OBSERVE") {
  return enqueueJob({
    rearm: "same-work",
    tenantId,
    kind,
    dedupeKey: key,
    runAt: past(),
    base: appDb,
  });
}

// A handler a test can hold open: `started` lists the rows in the order they began, and each row
// finishes only when `release` is called for it (or for all).
function held() {
  const started: string[] = [];
  const waiting = new Map<string, () => void>();
  let open = false;
  const handler: JobHandler = async (job: ClaimedJob) => {
    const key = job.dedupeKey ?? "";
    started.push(key);
    if (!open) {
      await new Promise<void>((r) => waiting.set(key, r));
    }
    return { outcome: "done" };
  };
  return {
    started,
    handler,
    release(key?: string) {
      if (key === undefined) {
        open = true;
        for (const r of waiting.values()) r();
        waiting.clear();
        return;
      }
      waiting.get(key)?.();
      waiting.delete(key);
    },
  };
}

describe.skipIf(!dbUp)("the observe lane's fast drain", () => {
  let previous: JobHandler | undefined;
  let previousFollowup: JobHandler | undefined;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "OBS-DRAIN", slug: `obs-drain-${process.pid}` },
    });
    tenantId = t.id;
    previous = getJobHandler("OBSERVE");
    previousFollowup = getJobHandler("FOLLOWUP");
  });

  afterEach(async () => {
    stopScheduler();
    if (previous) registerJobHandler("OBSERVE", previous);
    else unregisterJobHandler("OBSERVE");
    if (previousFollowup) registerJobHandler("FOLLOWUP", previousFollowup);
    else unregisterJobHandler("FOLLOWUP");
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // The shared tick is set a minute away, so anything that runs here ran on the drain.
  test("a due observation starts at the drain's cadence, not the shared tick's", async () => {
    const h = held();
    h.release();
    registerJobHandler("OBSERVE", h.handler);
    await arm("drain-cadence");
    const armedAt = Date.now();
    startScheduler({
      base: appDb,
      intervalMs: 60_000,
      observeIntervalMs: 50,
      tenantId,
      providerConcurrency: 2,
    });
    await until(() => h.started.length > 0, 3_000);
    expect(h.started).toEqual(["drain-cadence"]);
    expect(Date.now() - armedAt).toBeLessThan(3_000);
    await until(() => false, 100);
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "OBSERVE", status: "DONE" },
      }),
    ).toBe(1);
  });

  test("the drain holds as many observations as the provider bound, and the next starts when one ends", async () => {
    const h = held();
    registerJobHandler("OBSERVE", h.handler);
    for (const key of ["slot-a", "slot-b", "slot-c"]) await arm(key);
    // A drain interval far longer than the test: what starts after the first claim was started by a
    // slot being freed, not by the clock.
    startScheduler({
      base: appDb,
      intervalMs: 60_000,
      observeIntervalMs: 400,
      tenantId,
      providerConcurrency: 2,
    });
    await until(() => h.started.length >= 2, 3_000);
    // Two ticks more, and the third row is still waiting for a slot.
    await sleep(900);
    expect(h.started).toHaveLength(2);
    const freedAt = Date.now();
    h.release(h.started[0]);
    await until(() => h.started.length >= 3, 3_000);
    expect(h.started).toHaveLength(3);
    // Well inside one interval: the freed slot was filled at once.
    expect(Date.now() - freedAt).toBeLessThan(300);
    h.release();
  });

  test("an observation waits for a permit the shared tick's provider work holds", async () => {
    const h = held();
    registerJobHandler("OBSERVE", h.handler);
    const gate = new Semaphore(1);
    let free!: () => void;
    const busy = gate.run(() => new Promise<void>((r) => (free = r)));
    await arm("permit");
    const tick = await runObserveTick(appDb, {
      slots: 1,
      gate,
      staleMs: 300_000,
      tenantId,
    });
    expect(tick.claimed).toBe(1);
    await sleep(100);
    expect(h.started).toEqual([]);
    free();
    await busy;
    h.release();
    await tick.settled;
    expect(h.started).toEqual(["permit"]);
  });

  // A burst landing while the row waits puts the SAME row back to PENDING (armObserve's upsert).
  test("a row the drain already holds is not claimed again when a burst re-arms it", async () => {
    const h = held();
    registerJobHandler("OBSERVE", h.handler);
    const gate = new Semaphore(1);
    let free!: () => void;
    const busy = gate.run(() => new Promise<void>((r) => (free = r)));
    await arm("held-row");
    const first = await runObserveTick(appDb, {
      slots: 2,
      gate,
      staleMs: 300_000,
      tenantId,
    });
    expect(first.claimed).toBe(1);
    await enqueueJob({
      rearm: "new-work",
      tenantId,
      kind: "OBSERVE",
      dedupeKey: "held-row",
      runAt: past(),
      base: appDb,
    });
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "OBSERVE", status: "PENDING" },
      }),
    ).toBe(1);
    const second = await runObserveTick(appDb, {
      slots: 2,
      gate,
      staleMs: 300_000,
      tenantId,
    });
    expect(second.claimed).toBe(0);
    free();
    await busy;
    h.release();
    await first.settled;
    expect(h.started).toEqual(["held-row"]);
  });

  test("a full lane claims nothing", async () => {
    const h = held();
    registerJobHandler("OBSERVE", h.handler);
    const gate = new Semaphore(4);
    for (const key of ["full-a", "full-b"]) await arm(key);
    const first = await runObserveTick(appDb, {
      slots: 1,
      gate,
      staleMs: 300_000,
      tenantId,
    });
    expect(first.claimed).toBe(1);
    const second = await runObserveTick(appDb, {
      slots: 1,
      gate,
      staleMs: 300_000,
      tenantId,
    });
    expect(second.claimed).toBe(0);
    let freed = 0;
    h.release();
    await first.settled;
    const third = await runObserveTick(appDb, {
      slots: 1,
      gate,
      staleMs: 300_000,
      tenantId,
      onFreed: () => {
        freed += 1;
      },
    });
    expect(third.claimed).toBe(1);
    await third.settled;
    expect(freed).toBe(1);
    expect(h.started).toHaveLength(2);
  });

  // The interval is set a minute away, so what runs here ran on the wake-up asked for at arm time.
  test("a drain asked for at the instant a row becomes due does not wait for the interval", async () => {
    const h = held();
    h.release();
    registerJobHandler("OBSERVE", h.handler);
    startScheduler({
      base: appDb,
      intervalMs: 60_000,
      observeIntervalMs: 60_000,
      tenantId,
      providerConcurrency: 2,
    });
    const dueAt = new Date(Date.now() + 300);
    await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "OBSERVE",
      dedupeKey: "woken",
      runAt: dueAt,
      base: appDb,
    });
    // Asked twice for the same instant, as two messages of one burst do: one timer, one drain.
    wakeObserveDrainAt(dueAt);
    wakeObserveDrainAt(dueAt);
    await sleep(150);
    expect(h.started).toEqual([]);
    await until(() => h.started.length > 0, 3_000);
    expect(h.started).toEqual(["woken"]);
    expect(Date.now() - dueAt.getTime()).toBeLessThan(1_000);
  });

  test("arming an observation asks the drain for the instant its window ends", async () => {
    const h = held();
    h.release();
    registerJobHandler("OBSERVE", h.handler);
    startScheduler({
      base: appDb,
      intervalMs: 60_000,
      observeIntervalMs: 60_000,
      tenantId,
      providerConcurrency: 2,
    });
    const armedAt = Date.now();
    expect(
      await armObserve({
        tenantId,
        instanceId: 1n,
        conversationId: 7701,
        agentId: 1n,
        reason: "burst",
        cfg: {
          analysis: "incremental",
          debounce: { windowSeconds: 0.3, maxWindowSeconds: 1 },
        } as MonitoringConfig,
        base: appDb,
      }),
    ).toBe("armed");
    await until(() => h.started.length > 0, 3_000);
    expect(h.started).toHaveLength(1);
    const took = Date.now() - armedAt;
    // Not before the window, and not an interval after it.
    expect(took).toBeGreaterThanOrEqual(300);
    expect(took).toBeLessThan(1_500);
  });

  test("a wake-up asked for with no drain running does nothing, and stopping drops the ones pending", async () => {
    const h = held();
    h.release();
    registerJobHandler("OBSERVE", h.handler);
    await arm("nobody-wakes");
    wakeObserveDrainAt(new Date());
    startScheduler({
      base: appDb,
      intervalMs: 60_000,
      observeIntervalMs: 60_000,
      tenantId,
      providerConcurrency: 2,
    });
    wakeObserveDrainAt(new Date(Date.now() + 200));
    stopScheduler();
    await sleep(500);
    expect(h.started).toEqual([]);
  });

  test("the shared tick leaves observations alone when a drain owns the lane", async () => {
    const h = held();
    h.release();
    registerJobHandler("OBSERVE", h.handler);
    const followups: string[] = [];
    registerJobHandler("FOLLOWUP", async (job) => {
      followups.push(job.dedupeKey ?? "");
      return { outcome: "done" };
    });
    await arm("left-alone");
    await arm("followup-still-runs", "FOLLOWUP");
    await runSchedulerTick(appDb, {
      staleMs: 300_000,
      batchSize: 20,
      tenantId,
      providerConcurrency: 2,
      claimObserve: false,
    });
    expect(followups).toEqual(["followup-still-runs"]);
    expect(h.started).toEqual([]);
    // Without the option the tick claims them itself, as an install with no drain needs.
    await runSchedulerTick(appDb, {
      staleMs: 300_000,
      batchSize: 20,
      tenantId,
      providerConcurrency: 2,
    });
    expect(h.started).toEqual(["left-alone"]);
  });
});
