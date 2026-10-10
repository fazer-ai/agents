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

  test("recoveries run under the shared provider bound, whatever the drain's slots", async () => {
    install();
    for (const key of ["p1", "p2", "p3"]) {
      await arm("DELIVERY_RECOVERY", key);
    }
    const tick = await runTrafficTick(appDb, {
      slots: 4,
      window: new StartWindow(100),
      gate: new Semaphore(1),
      staleMs: 300_000,
      tenantId,
    });
    expect(tick.claimed).toBe(3);
    await until("one recovery to be running", () => h.started.length === 1);
    h.release();
    await tick.settled;
    expect(h.finished).toHaveLength(3);
    expect(h.state.maxInflight).toBe(1);
  });

  test("a recovery is claimed before older ingestion, and ingestion before an older NOTHING_TO_ANSWER", async () => {
    await arm("NOTHING_TO_ANSWER", "nta", 3_600_000);
    await arm("INGEST_MESSAGE", "ingest", 1_800_000);
    await arm("DELIVERY_RECOVERY", "recovery", 60_000);
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const jobs = await claimDueTrafficJobs(1, appDb, new Date(), tenantId);
      abandonClaimed(jobs);
      order.push(...jobs.map((job) => job.dedupeKey ?? ""));
    }
    expect(order).toEqual(["recovery", "ingest", "nta"]);
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
