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
import {
  abandonClaimed,
  type ClaimedJob,
  claimDueTrafficJobs,
  enqueueJob,
  type SchedulerJobKind,
} from "@/modules/scheduler/service";
import { StartWindow } from "@/modules/scheduler/start-window";
import {
  getJobHandler,
  type JobHandler,
  registerJobHandler,
  runObserveTick,
  runSchedulerTick,
  runTrafficTick,
  startScheduler,
  stopScheduler,
  unregisterJobHandler,
} from "@/modules/scheduler/worker";
import { until } from "@/tests/utils/poll";

// The traffic-proportional kinds' drain (src/modules/scheduler/worker.ts, runTrafficTick): how many
// run at once, how many start in a minute, and in which order a backlog is claimed. Every case
// fences on this file's tenant: the claim is cross-tenant by design.

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
const KINDS: SchedulerJobKind[] = [
  "INGEST_MESSAGE",
  "DELIVERY_RECOVERY",
  "NOTHING_TO_ANSWER",
  "WEBHOOK_RETRY",
];

async function arm(kind: SchedulerJobKind, key: string, agoMs = 60_000) {
  return enqueueJob({
    rearm: "same-work",
    tenantId,
    kind,
    dedupeKey: key,
    runAt: new Date(Date.now() - agoMs),
    base: appDb,
  });
}

// A handler a test can hold open. `inflight` and `maxInflight` count the rows running at once.
function held() {
  const started: string[] = [];
  const finished: string[] = [];
  const waiting = new Map<string, () => void>();
  const openKeys = new Set<string>();
  let openAll = false;
  let inflight = 0;
  const state = { maxInflight: 0 };
  const handler: JobHandler = async (job: ClaimedJob) => {
    const key = job.dedupeKey ?? "";
    started.push(key);
    inflight += 1;
    state.maxInflight = Math.max(state.maxInflight, inflight);
    if (!openAll && !openKeys.has(key)) {
      await new Promise<void>((r) => waiting.set(key, r));
    }
    inflight -= 1;
    finished.push(key);
    return { outcome: "done" };
  };
  return {
    started,
    finished,
    state,
    handler,
    open(key: string) {
      openKeys.add(key);
    },
    release() {
      openAll = true;
      for (const r of waiting.values()) r();
      waiting.clear();
    },
  };
}

describe.skipIf(!dbUp)("the traffic drain", () => {
  const previous = new Map<SchedulerJobKind, JobHandler | undefined>();
  let h = held();

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TRAFFIC-DRAIN", slug: `traffic-drain-${process.pid}` },
    });
    tenantId = t.id;
    for (const kind of KINDS) previous.set(kind, getJobHandler(kind));
  });

  afterEach(async () => {
    h.release();
    stopScheduler();
    await until("every held row to finish", () =>
      h.started.every((key) => h.finished.includes(key)),
    );
    // A handler returns before its run writes the outcome; deleting under that write is a race.
    await until(
      "every run's outcome to be written",
      async () =>
        (await suDb.schedulerJob.count({
          where: {
            tenantId,
            status: "CLAIMED",
            dedupeKey: { in: h.started },
          },
        })) === 0,
    );
    for (const kind of KINDS) {
      const handler = previous.get(kind);
      if (handler) registerJobHandler(kind, handler);
      else unregisterJobHandler(kind);
    }
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  function install() {
    h = held();
    for (const kind of KINDS) registerJobHandler(kind, h.handler);
  }

  test("a slow recovery holds one slot, and the rows behind it drain past it", async () => {
    install();
    await arm("DELIVERY_RECOVERY", "slow", 120_000);
    const quick = ["q1", "q2", "q3", "q4", "q5", "q6"];
    for (const key of quick) {
      h.open(key);
      await arm("INGEST_MESSAGE", key);
    }
    startScheduler({
      base: appDb,
      intervalMs: 50,
      observeIntervalMs: 60_000,
      tenantId,
      providerConcurrency: 2,
      trafficConcurrency: 3,
      trafficPerMinute: 1_000,
    });
    await until("every quick row to finish", () =>
      quick.every((key) => h.finished.includes(key)),
    );
    expect(h.started).toContain("slow");
    expect(h.finished).not.toContain("slow");
  });

  test("a backlog runs as many rows at once as the concurrency allows, and never more", async () => {
    install();
    const keys = Array.from({ length: 10 }, (_, i) => `c${i}`);
    for (const key of keys) await arm("INGEST_MESSAGE", key);
    startScheduler({
      base: appDb,
      intervalMs: 50,
      observeIntervalMs: 60_000,
      tenantId,
      trafficConcurrency: 8,
      trafficPerMinute: 1_000,
    });
    await until("eight rows to be running", () => h.started.length >= 8);
    h.release();
    await until("every row to finish", () => h.finished.length === 10);
    expect(h.state.maxInflight).toBe(8);
  });

  test("the start window stops the claim, and says how long until it admits again", async () => {
    install();
    h.release();
    for (const key of ["w1", "w2", "w3", "w4", "w5"]) {
      await arm("INGEST_MESSAGE", key);
    }
    const window = new StartWindow(3);
    const opts = {
      slots: 10,
      window,
      gate: new Semaphore(2),
      staleMs: 300_000,
      tenantId,
    };
    let freed = 0;
    const first = await runTrafficTick(appDb, {
      ...opts,
      onFreed: () => {
        freed += 1;
      },
    });
    await first.settled;
    expect(first.claimed).toBe(3);
    expect(freed).toBe(3);
    const second = await runTrafficTick(appDb, opts);
    expect(second.claimed).toBe(0);
    expect(second.waitMs).toBeGreaterThan(59_000);
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "INGEST_MESSAGE", status: "PENDING" },
      }),
    ).toBe(2);
  });

  test("a recovery is claimed only with a provider permit in hand, and the rest of the lane is not held for it", async () => {
    install();
    h.release();
    for (const key of ["p1", "p2", "p3"]) {
      await arm("DELIVERY_RECOVERY", key, 120_000);
    }
    await arm("INGEST_MESSAGE", "free");
    const gate = new Semaphore(1);
    const tick = await runTrafficTick(appDb, {
      slots: 4,
      window: new StartWindow(100),
      gate,
      staleMs: 300_000,
      tenantId,
    });
    await tick.settled;
    expect(h.started.sort()).toEqual(["free", "p1"]);
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "DELIVERY_RECOVERY", status: "PENDING" },
      }),
    ).toBe(2);
    // The permit went back with the row.
    expect(gate.tryAcquire()).not.toBeNull();
  });

  test("with every permit taken, no recovery is claimed", async () => {
    install();
    h.release();
    await arm("DELIVERY_RECOVERY", "blocked");
    const gate = new Semaphore(1);
    const taken = gate.tryAcquire();
    const tick = await runTrafficTick(appDb, {
      slots: 4,
      window: new StartWindow(100),
      gate,
      staleMs: 300_000,
      tenantId,
    });
    taken?.();
    expect(tick.claimed).toBe(0);
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "DELIVERY_RECOVERY", status: "PENDING" },
      }),
    ).toBe(1);
  });

  test("after the observe drain was refused a permit, the traffic drain leaves one free for it", async () => {
    install();
    h.release();
    await arm("DELIVERY_RECOVERY", "yields");
    const gate = new Semaphore(1);
    const held = gate.tryAcquire();
    const refused = await runObserveTick(appDb, {
      slots: 1,
      gate,
      staleMs: 300_000,
      tenantId,
    });
    expect(refused.claimed).toBe(0);
    held?.();
    const opts = {
      slots: 2,
      window: new StartWindow(100),
      gate,
      staleMs: 300_000,
      tenantId,
    };
    expect((await runTrafficTick(appDb, opts)).claimed).toBe(0);
    // The observe drain takes the permit it was owed (no row due here, so it hands it back).
    await (
      await runObserveTick(appDb, {
        slots: 1,
        gate,
        staleMs: 300_000,
        tenantId,
      })
    ).settled;
    const tick = await runTrafficTick(appDb, opts);
    await tick.settled;
    expect(h.started).toEqual(["yields"]);
  });

  test("a claim short of permits says it wants one, and a claim that had room does not", async () => {
    install();
    h.release();
    await arm("DELIVERY_RECOVERY", "waits");
    const gate = new Semaphore(1);
    const taken = gate.tryAcquire();
    const opts = {
      slots: 2,
      window: new StartWindow(100),
      gate,
      staleMs: 300_000,
      tenantId,
    };
    const starved = await runTrafficTick(appDb, opts);
    expect(starved.claimed).toBe(0);
    expect(starved.wantsPermit).toBe(true);
    taken?.();
    const ran = await runTrafficTick(appDb, { ...opts, slots: 1 });
    await ran.settled;
    expect(ran.claimed).toBe(1);
    expect(ran.wantsPermit).toBe(false);
  });

  // Both statements: the shared tick's fallback claims without a permit cap, the drain with one.
  test.each([
    ["the tick's claim", undefined],
    ["the drain's claim", 5],
  ])(
    "%s takes a recovery before older ingestion, and ingestion before an older NOTHING_TO_ANSWER",
    async (_, spendCap) => {
      await arm("NOTHING_TO_ANSWER", "nta", 3_600_000);
      await arm("INGEST_MESSAGE", "ingest", 1_800_000);
      await arm("DELIVERY_RECOVERY", "recovery", 60_000);
      const order: string[] = [];
      for (let i = 0; i < 3; i++) {
        const jobs = await claimDueTrafficJobs(
          1,
          appDb,
          new Date(),
          tenantId,
          spendCap,
        );
        abandonClaimed(jobs);
        order.push(...jobs.map((job) => job.dedupeKey ?? ""));
      }
      expect(order).toEqual(["recovery", "ingest", "nta"]);
      await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    },
  );

  test.each([
    ["the tick's claim", undefined],
    ["the drain's claim", 5],
  ])(
    "%s takes a recovery a busy conversation deferred before the recoveries armed after it",
    async (_, spendCap) => {
      // The deferred row was armed first and is due again a minute later than the rest: its place
      // is its age, and the later run_at only says when it may run.
      await arm("DELIVERY_RECOVERY", "deferred", 1_000);
      await arm("DELIVERY_RECOVERY", "later-1", 1_800_000);
      await arm("DELIVERY_RECOVERY", "later-2", 1_800_000);
      const ago = (ms: number) => new Date(Date.now() - ms);
      await suDb.schedulerJob.updateMany({
        where: { tenantId, dedupeKey: "deferred" },
        data: { createdAt: ago(3_600_000) },
      });
      await suDb.schedulerJob.updateMany({
        where: { tenantId, dedupeKey: { in: ["later-1", "later-2"] } },
        data: { createdAt: ago(1_800_000) },
      });
      const order: string[] = [];
      for (let i = 0; i < 3; i++) {
        const jobs = await claimDueTrafficJobs(
          1,
          appDb,
          new Date(),
          tenantId,
          spendCap,
        );
        abandonClaimed(jobs);
        order.push(...jobs.map((job) => job.dedupeKey ?? ""));
      }
      expect(order[0]).toBe("deferred");
      expect(order.slice(1).sort()).toEqual(["later-1", "later-2"]);
      await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    },
  );

  test("with one permit, the permit goes to the older recovery, not to the one due earlier", async () => {
    await arm("DELIVERY_RECOVERY", "older", 1_000);
    await arm("DELIVERY_RECOVERY", "due-earlier", 1_800_000);
    await suDb.schedulerJob.updateMany({
      where: { tenantId, dedupeKey: "older" },
      data: { createdAt: new Date(Date.now() - 3_600_000) },
    });
    await suDb.schedulerJob.updateMany({
      where: { tenantId, dedupeKey: "due-earlier" },
      data: { createdAt: new Date(Date.now() - 1_800_000) },
    });
    const jobs = await claimDueTrafficJobs(5, appDb, new Date(), tenantId, 1);
    abandonClaimed(jobs);
    expect(jobs.map((job) => job.dedupeKey)).toEqual(["older"]);
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  test("a row whose run_at is still ahead is not claimed, however old it is", async () => {
    await arm("DELIVERY_RECOVERY", "not-yet", -60_000);
    await suDb.schedulerJob.updateMany({
      where: { tenantId, dedupeKey: "not-yet" },
      data: { createdAt: new Date(Date.now() - 3_600_000) },
    });
    await arm("DELIVERY_RECOVERY", "due", 1_000);
    const jobs = await claimDueTrafficJobs(5, appDb, new Date(), tenantId);
    abandonClaimed(jobs);
    expect(jobs.map((job) => job.dedupeKey)).toEqual(["due"]);
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  test("the permits no claimed row spends go back at once", async () => {
    install();
    await arm("DELIVERY_RECOVERY", "spends", 120_000);
    await arm("INGEST_MESSAGE", "cheap-1");
    await arm("INGEST_MESSAGE", "cheap-2");
    const gate = new Semaphore(3);
    const tick = await runTrafficTick(appDb, {
      slots: 3,
      window: new StartWindow(100),
      gate,
      staleMs: 300_000,
      tenantId,
    });
    expect(tick.claimed).toBe(3);
    expect(gate.free).toBe(2);
    h.release();
    await tick.settled;
    expect(gate.free).toBe(3);
  });

  test("the shared tick leaves traffic rows to the drain when told to", async () => {
    install();
    h.release();
    await arm("INGEST_MESSAGE", "left");
    await arm("WEBHOOK_RETRY", "taken");
    await runSchedulerTick(appDb, {
      staleMs: 300_000,
      batchSize: 20,
      tenantId,
      claimTraffic: false,
    });
    expect(h.started).toEqual(["taken"]);
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "INGEST_MESSAGE", status: "PENDING" },
      }),
    ).toBe(1);
  });
});
