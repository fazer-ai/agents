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
import { drainInFlight, resetShutdownForTest } from "@/lib/shutdown";
import { runDebounceTick } from "@/modules/debounce/worker";
import {
  type ClaimedJob,
  claimDueDebounceJobs,
  claimDueJobs,
  claimPendingByKeyPrefix,
  enqueueJob,
  type SchedulerJobKind,
} from "@/modules/scheduler/service";
import {
  getJobHandler,
  type JobHandler,
  registerJobHandler,
  runClaimed,
  unregisterJobHandler,
} from "@/modules/scheduler/worker";

// The job lanes under the shutdown drain (src/lib/shutdown.ts). A run that ends inside the bound has
// its outcome written before the process may exit; a run still going at the bound is ended the way
// its deadline ends it, so its row is PENDING for the next process instead of CLAIMED until the
// reaper's stale window; and from the signal on, no lane claims a row. Real Postgres, real claims.

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const past = () => new Date(Date.now() - 60_000);

async function rowOf(id: bigint) {
  return suDb.schedulerJob.findUnique({
    where: { id },
    select: {
      status: true,
      attempts: true,
      lastError: true,
      claimSeq: true,
      claimedAt: true,
      runAt: true,
    },
  });
}

async function pending(kind: SchedulerJobKind, key: string): Promise<bigint> {
  return enqueueJob({
    rearm: "same-work",
    tenantId,
    kind,
    dedupeKey: key,
    runAt: past(),
    base: appDb,
  });
}

async function claimed(
  kind: SchedulerJobKind,
  key: string,
): Promise<ClaimedJob> {
  const id = await pending(kind, key);
  const jobs = await claimDueJobs(10, appDb, new Date(), tenantId);
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error(`row ${id} was not claimed`);
  return job;
}

const installed: Array<{ kind: string; previous: JobHandler | undefined }> = [];
function install(kind: string, handler: JobHandler) {
  installed.push({ kind, previous: getJobHandler(kind) });
  registerJobHandler(kind, handler);
}

// A handler that runs until its signal aborts, like a model call that honours it.
function untilAborted(saw: { signal?: AbortSignal }): JobHandler {
  return async (_job, _base, ctx) => {
    saw.signal = ctx?.signal;
    await new Promise((_, reject) =>
      ctx?.signal.addEventListener("abort", () => reject(ctx.signal.reason)),
    );
    return { outcome: "done" };
  };
}

describe.skipIf(!dbUp)("the job lanes under the shutdown drain", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SHUTDOWN", slug: `shutdown-drain-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterEach(async () => {
    resetShutdownForTest();
    for (const { kind, previous } of installed.splice(0).reverse()) {
      if (previous) registerJobHandler(kind, previous);
      else unregisterJobHandler(kind);
    }
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a run that ends inside the bound has its outcome written before the drain returns", async () => {
    install("HEARTBEAT", async () => {
      await sleep(300);
      return { outcome: "done" };
    });
    const job = await claimed("HEARTBEAT", "drain-finishes");
    const run = runClaimed(job, appDb);
    const result = await drainInFlight({ boundMs: 5_000 });
    expect(result.drained).toBe(true);
    expect((await rowOf(job.id))?.status).toBe("DONE");
    await run;
  });

  test("a run still going at the bound is failed for retry, its signal aborted", async () => {
    const saw: { signal?: AbortSignal } = {};
    install("HEARTBEAT", untilAborted(saw));
    const job = await claimed("HEARTBEAT", "drain-cut");
    void runClaimed(job, appDb);
    const t = performance.now();
    const result = await drainInFlight({ boundMs: 300, settleMs: 1_500 });
    expect(performance.now() - t).toBeLessThan(1_800);
    expect(result.drained).toBe(false);
    expect(result.stillRunning.byKind).toEqual({ HEARTBEAT: 1 });
    expect(result.unsettled).toBe(0);
    expect(saw.signal?.aborted).toBe(true);
    // Read as the drain returns, with no wait: the process exits right after this.
    const row = await rowOf(job.id);
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("shutdown");
  });

  test("the debounce lane: of three flushes, the one that ends is DONE and the two cut are PENDING", async () => {
    const saw: { signal?: AbortSignal } = {};
    const hang = untilAborted(saw);
    install("DEBOUNCE", async (job, base, ctx) => {
      if (job.dedupeKey?.endsWith(":quick")) {
        await sleep(150);
        return { outcome: "done" };
      }
      return hang(job, base, ctx);
    });
    const ids = await Promise.all(
      ["quick", "slow-a", "slow-b"].map((k) =>
        pending("DEBOUNCE", `debounce:shutdown-${process.pid}:${k}`),
      ),
    );
    const tick = await runDebounceTick(appDb, 3, {
      claim: (limit, base, now, _tenant, exclude) =>
        claimDueDebounceJobs(limit, base, now, tenantId, exclude),
    });
    expect(tick.claimed).toBe(3);
    const result = await drainInFlight({ boundMs: 500, settleMs: 1_500 });
    expect(result.stillRunning).toEqual({
      total: 2,
      byKind: { DEBOUNCE: 2 },
    });
    const rows = await Promise.all(ids.map(rowOf));
    expect(rows.map((r) => r?.status)).toEqual(["DONE", "PENDING", "PENDING"]);
    await tick.settled;
  });

  test("from the drain on, no lane claims a due row, and the rows are untouched", async () => {
    const shared = await pending("HEARTBEAT", "drain-no-claim-shared");
    const debounce = await pending(
      "DEBOUNCE",
      `debounce:shutdown-${process.pid}:no-claim`,
    );
    const before = await Promise.all([shared, debounce].map(rowOf));
    await drainInFlight({ boundMs: 50 });
    expect(await claimDueJobs(10, appDb, new Date(), tenantId)).toEqual([]);
    expect(await claimDueDebounceJobs(10, appDb, new Date(), tenantId)).toEqual(
      [],
    );
    expect(await Promise.all([shared, debounce].map(rowOf))).toEqual(before);
  });

  // The barrier belongs to a turn that is already running, which is what the drain waits for: refusing
  // it would have that turn answer without the messages queued for it.
  test("a running turn's barrier still claims during the drain", async () => {
    const key = `ingest:shutdown-${process.pid}`;
    const id = await pending("INGEST_MESSAGE", `${key}:1`);
    await drainInFlight({ boundMs: 50 });
    const jobs = await claimPendingByKeyPrefix(
      "INGEST_MESSAGE",
      key,
      10,
      appDb,
      tenantId,
    );
    expect(jobs.map((j) => j.id)).toEqual([id]);
  });
});
