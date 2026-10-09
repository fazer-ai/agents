import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  beginWork,
  drainInFlight,
  inFlightWork,
  resetShutdownForTest,
} from "@/lib/shutdown";
import { runDebounceTick } from "@/modules/debounce/worker";
import * as schedulerService from "@/modules/scheduler/service";
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
  runSchedulerTick,
  SCHEDULER_STALE_MS,
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

  // The registry is process-wide: a suite that claimed rows without running them leaves them held.
  beforeEach(() => {
    resetShutdownForTest();
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

  // A run that committed (a message sent) and is cut still writes the outcome it returns late, so
  // the next process does not repeat the committed work; the drain waits for that write.
  test("a cut run that had committed has its late outcome written before the drain returns", async () => {
    install("HEARTBEAT", async (_job, _base, ctx) => {
      ctx?.commit();
      await new Promise((r) => ctx?.signal.addEventListener("abort", r));
      await sleep(200);
      return { outcome: "done" };
    });
    const job = await claimed("HEARTBEAT", "drain-committed");
    void runClaimed(job, appDb);
    const result = await drainInFlight({ boundMs: 200, settleMs: 1_500 });
    expect(result.unsettled).toBe(0);
    expect((await rowOf(job.id))?.status).toBe("DONE");
  });

  // The shared tick claims a batch and queues the provider-spending rows behind a permit. A row still
  // queued is the process's CLAIMED row all the same: it is handed back unrun, without an attempt.
  test("a claimed row still waiting for a provider permit is handed back unrun", async () => {
    const ran: string[] = [];
    const saw: { signal?: AbortSignal } = {};
    const hang = untilAborted(saw);
    const handler: JobHandler = async (job, base, ctx) => {
      ran.push(job.kind);
      return hang(job, base, ctx);
    };
    install("FOLLOWUP", handler);
    install("APPOINTMENT_REMINDER", handler);
    const first = await pending("FOLLOWUP", "drain-permit-first");
    const second = await pending("APPOINTMENT_REMINDER", "drain-permit-second");
    const tick = runSchedulerTick(appDb, {
      staleMs: SCHEDULER_STALE_MS,
      batchSize: 10,
      tenantId,
      providerConcurrency: 1,
    });
    await sleep(300);
    expect(ran).toHaveLength(1);
    const result = await drainInFlight({ boundMs: 200, settleMs: 1_500 });
    expect(result.stillRunning.total).toBe(2);
    expect(result.unsettled).toBe(0);
    const rows = await Promise.all([first, second].map(rowOf));
    const byStarted = ran[0] === "FOLLOWUP" ? rows : [rows[1], rows[0]];
    expect(byStarted.map((r) => [r?.status, r?.attempts])).toEqual([
      ["PENDING", 1],
      ["PENDING", 0],
    ]);
    expect(byStarted[1]?.claimedAt).toBeNull();
    await tick;
    expect(ran).toHaveLength(1);
  });

  test("a row claimed and not yet started is handed back, and is not run after", async () => {
    let ran = false;
    install("HEARTBEAT", async () => {
      ran = true;
      return { outcome: "done" };
    });
    const job = await claimed("HEARTBEAT", "drain-unstarted");
    const result = await drainInFlight({ boundMs: 100, settleMs: 1_500 });
    expect(result.stillRunning.byKind).toEqual({ HEARTBEAT: 1 });
    const row = await rowOf(job.id);
    expect([row?.status, row?.attempts, row?.claimedAt]).toEqual([
      "PENDING",
      0,
      null,
    ]);
    await runClaimed(job, appDb);
    expect(ran).toBe(false);
  });

  test("a row a turn's barrier claims after the bound is handed back at once", async () => {
    const key = `ingest:shutdown-late-${process.pid}`;
    const id = await pending("INGEST_MESSAGE", `${key}:1`);
    // A run that takes a while to end once cut keeps the drain in its settle wait, past the bound.
    const end = beginWork("DEBOUNCE", () => {
      setTimeout(() => end(), 400);
    });
    const drained = drainInFlight({ boundMs: 100, settleMs: 1_000 });
    await sleep(200);
    const jobs = await claimPendingByKeyPrefix(
      "INGEST_MESSAGE",
      key,
      10,
      appDb,
      tenantId,
    );
    expect(jobs.map((j) => j.id)).toEqual([id]);
    expect((await drained).unsettled).toBe(0);
    const row = await rowOf(id);
    expect([row?.status, row?.attempts]).toEqual(["PENDING", 0]);
  });

  test("rows a tick claimed and then abandoned on a failed claim stop holding the drain", async () => {
    const id = await pending("HEARTBEAT", "drain-abandoned");
    const spy = spyOn(
      schedulerService,
      "claimDueTrafficJobs",
    ).mockRejectedValue(new Error("pool exhausted"));
    try {
      await expect(
        runSchedulerTick(appDb, {
          staleMs: SCHEDULER_STALE_MS,
          batchSize: 10,
          tenantId,
        }),
      ).rejects.toThrow("pool exhausted");
    } finally {
      spy.mockRestore();
    }
    // Left CLAIMED for the reaper, as before, and the drain no longer waits for it.
    expect((await rowOf(id))?.status).toBe("CLAIMED");
    expect(inFlightWork().total).toBe(0);
  });

  test("a newer claim of the same row supersedes the older hold", async () => {
    install("HEARTBEAT", async () => ({ outcome: "done" }));
    const first = await claimed("HEARTBEAT", "drain-superseded");
    // The reaper's move, by hand: the row is claimable again under a new token.
    await suDb.schedulerJob.update({
      where: { id: first.id },
      data: { status: "PENDING", claimedAt: null },
    });
    const again = (await claimDueJobs(10, appDb, new Date(), tenantId)).find(
      (j) => j.id === first.id,
    );
    expect(again?.claimSeq).toBe(first.claimSeq + 1);
    expect(inFlightWork().total).toBe(1);
    await runClaimed(again as ClaimedJob, appDb);
    expect(inFlightWork().total).toBe(0);
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
