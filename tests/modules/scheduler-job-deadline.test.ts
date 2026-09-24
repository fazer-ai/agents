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
import { runDebounceTick } from "@/modules/debounce/worker";
import { runningJobIds } from "@/modules/scheduler/running";
import {
  type ClaimedJob,
  claimDueDebounceJobs,
  claimDueJobs,
  enqueueJob,
  enqueueJobUnlessClaimed,
  type SchedulerJobKind,
} from "@/modules/scheduler/service";
import {
  getJobHandler,
  type JobHandler,
  jobDeadlineMs,
  registerJobHandler,
  runClaimed,
  runSchedulerTick,
  SCHEDULER_STALE_MS,
  unregisterJobHandler,
} from "@/modules/scheduler/worker";

// Issue #811: nothing ended a scheduler job that was still running. The reaper re-pends a CLAIMED row
// once its claim is older than the stale window, but the handler holding it kept running, so a hung
// handler held its slot until whatever it awaited returned, and after the reap the same row could be
// claimed again beside it. A job now runs under a deadline below the stale window: when it fires, the
// handler's signal aborts, the run is failed through failJob, and the slot is released whether or not
// the handler listens. Whatever the handler returns afterwards is discarded, and its row is not
// claimed again in this process until the handler has actually returned. Real Postgres, real claims.

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
let otherTenantId = 0n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const past = () => new Date(Date.now() - 60_000);

async function rowOf(id: bigint) {
  return suDb.schedulerJob.findUniqueOrThrow({
    where: { id },
    select: { status: true, attempts: true, lastError: true },
  });
}

async function claimed(
  kind: SchedulerJobKind,
  key: string,
): Promise<ClaimedJob> {
  const id = await enqueueJob({
    rearm: "same-work",
    tenantId,
    kind,
    dedupeKey: key,
    runAt: past(),
    base: appDb,
  });
  const jobs =
    kind === "DEBOUNCE"
      ? await claimDueDebounceJobs(10, appDb, new Date(), tenantId)
      : await claimDueJobs(10, appDb, new Date(), tenantId);
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error(`row ${id} was not claimed`);
  return job;
}

// A handler for `kind` for the length of one test, and the one that was there put back after it:
// the registry is process-global, and every test file shares the process.
const installed: Array<{ kind: string; previous: JobHandler | undefined }> = [];
function install(kind: string, handler: JobHandler) {
  installed.push({ kind, previous: getJobHandler(kind) });
  registerJobHandler(kind, handler);
}

// A handler that never returns on its own and ignores its signal, like a provider call that does
// not listen. `release` lets it return, with whatever outcome the test wants to see discarded.
function hung() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let signal: AbortSignal | undefined;
  const handler: JobHandler = async (_job, _base, ctx) => {
    signal = ctx?.signal;
    await gate;
    return { outcome: "done" };
  };
  return { handler, release: () => release(), signal: () => signal };
}

describe.skipIf(!dbUp)(
  "a scheduler job runs under a deadline (issue #811)",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "DEADLINE", slug: `deadline-${process.pid}` },
      });
      tenantId = t.id;
      const o = await suDb.tenant.create({
        data: { name: "DEADLINE-B", slug: `deadline-b-${process.pid}` },
      });
      otherTenantId = o.id;
    });

    afterEach(async () => {
      for (const { kind, previous } of installed.splice(0).reverse()) {
        if (previous) registerJobHandler(kind, previous);
        else unregisterJobHandler(kind);
      }
      await suDb.schedulerJob.deleteMany({
        where: { tenantId: { in: [tenantId, otherTenantId] } },
      });
    });

    afterAll(async () => {
      await suDb.tenant.deleteMany({
        where: { id: { in: [tenantId, otherTenantId] } },
      });
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("a hung handler is failed at its deadline, and its signal aborts", async () => {
      const h = hung();
      install("HEARTBEAT", h.handler);
      const job = await claimed("HEARTBEAT", "deadline-hung");
      const t = performance.now();
      try {
        await runClaimed(job, appDb, { deadlineMs: 150 });
        expect(performance.now() - t).toBeLessThan(2_000);
        expect(h.signal()?.aborted).toBe(true);
        const row = await rowOf(job.id);
        expect(row.status).toBe("PENDING");
        expect(row.attempts).toBe(1);
        expect(row.lastError).toContain("deadline");
      } finally {
        h.release();
      }
    });

    test("what a handler returns after its deadline is discarded", async () => {
      const h = hung();
      install("HEARTBEAT", h.handler);
      const job = await claimed("HEARTBEAT", "deadline-late");
      await runClaimed(job, appDb, { deadlineMs: 100 });
      h.release();
      await sleep(300);
      const row = await rowOf(job.id);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
    });

    // A handler that did what it cannot take back before its deadline fired (a message sent, a step
    // stamped) says so, and its outcome is written after all: discarded, its retry would repeat the
    // work, or read the stamp as the step being over and end the sequence.
    test("a run that committed before its deadline has its late reschedule written", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const next = new Date(Date.now() + 3_600_000);
      install("HEARTBEAT", async (_job, _base, ctx) => {
        ctx?.commit();
        await gate;
        return {
          outcome: "reschedule",
          runAt: next,
          payload: { step: 2 },
        };
      });
      const job = await claimed("HEARTBEAT", "deadline-committed");
      await runClaimed(job, appDb, { deadlineMs: 100 });
      expect((await rowOf(job.id)).attempts).toBe(1);
      release();
      await sleep(300);
      const row = await suDb.schedulerJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect({
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        runAt: row.runAt.getTime(),
        payload: row.payload,
      }).toEqual({
        status: "PENDING",
        attempts: 0,
        lastError: null,
        runAt: next.getTime(),
        payload: { step: 2 },
      });
    });

    test("a run that committed before its deadline has its late done written", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      install("HEARTBEAT", async (_job, _base, ctx) => {
        ctx?.commit();
        await gate;
        return { outcome: "done" };
      });
      const job = await claimed("HEARTBEAT", "deadline-committed-done");
      await runClaimed(job, appDb, { deadlineMs: 100 });
      release();
      await sleep(300);
      expect((await rowOf(job.id)).status).toBe("DONE");
    });

    // The failure is written first, and the late outcome over it, never the other way round: a
    // handler that returns in the same instant its deadline fires would otherwise have its outcome
    // written and then overwritten by the failure.
    test("a committed run returning as its deadline fires still ends with its own outcome", async () => {
      install("HEARTBEAT", async (_job, _base, ctx) => {
        ctx?.commit();
        await sleep(100);
        return { outcome: "done" };
      });
      const job = await claimed("HEARTBEAT", "deadline-committed-race");
      await runClaimed(job, appDb, { deadlineMs: 100 });
      await sleep(300);
      expect((await rowOf(job.id)).status).toBe("DONE");
    });

    // The same order, forced: a handler that returns the moment its signal aborts reaches its late
    // outcome while the failure is still being written. Taking the row back before the failure lands
    // finds it CLAIMED, the outcome is dropped, and the failure then wins.
    test("a committed run that returns as its signal aborts has its outcome written after the failure", async () => {
      install("HEARTBEAT", async (_job, _base, ctx) => {
        ctx?.commit();
        await new Promise((r) => ctx?.signal.addEventListener("abort", r));
        return { outcome: "done" };
      });
      const job = await claimed("HEARTBEAT", "deadline-committed-abort");
      // The failure's transaction, the run's first write, held back: the late outcome is then ready
      // well before the failure lands, which is the order a slow database produces.
      let first = true;
      const slowFailure = new Proxy(appDb, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== "$extends" || typeof value !== "function") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (...args: unknown[]) => {
            const extended = value.apply(target, args);
            if (!first) return extended;
            first = false;
            return new Proxy(extended, {
              get(ext, p, r) {
                const v = Reflect.get(ext, p, r);
                if (p === "$transaction") {
                  return async (...a: unknown[]) => {
                    await sleep(150);
                    return v.apply(ext, a);
                  };
                }
                return typeof v === "function" ? v.bind(ext) : v;
              },
            });
          };
        },
      });
      await runClaimed(job, slowFailure, { deadlineMs: 100 });
      await sleep(400);
      expect((await rowOf(job.id)).status).toBe("DONE");
    });

    // Every write of the run, the late one included, happens while the row is still kept out of the
    // claims: a retry claimed between the handler returning and its outcome being written would run
    // the committed work again.
    test("a committed run's row stays out of the claims until its late outcome is written", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      install("HEARTBEAT", async (_job, _base, ctx) => {
        ctx?.commit();
        await gate;
        return { outcome: "done" };
      });
      const job = await claimed("HEARTBEAT", "deadline-committed-held");
      const heldAtEachWrite: boolean[] = [];
      const watched = new Proxy(appDb, {
        get(target, prop, receiver) {
          if (prop === "$extends") {
            heldAtEachWrite.push(runningJobIds().includes(job.id));
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await runClaimed(job, watched, { deadlineMs: 100 });
      release();
      await sleep(300);
      expect((await rowOf(job.id)).status).toBe("DONE");
      // The failure, the take-back and the outcome.
      expect(heldAtEachWrite.length).toBeGreaterThanOrEqual(3);
      expect(heldAtEachWrite.every(Boolean)).toBe(true);
    });

    // A re-arm puts the row back to PENDING under the same claim token, carrying work newer than
    // this run's outcome (the customer replied, the ladder restarts). The late write must not land on
    // it: the row no longer carries this run's failure.
    test("a committed run whose row was re-armed since the failure leaves the new arm alone", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      install("HEARTBEAT", async (_job, _base, ctx) => {
        ctx?.commit();
        await gate;
        return {
          outcome: "reschedule",
          runAt: new Date(Date.now() + 3_600_000),
          payload: { stage: "old" },
        };
      });
      const job = await claimed("HEARTBEAT", "deadline-committed-rearmed");
      await runClaimed(job, appDb, { deadlineMs: 100 });
      const rearmAt = new Date(Date.now() + 60_000);
      await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "HEARTBEAT",
        dedupeKey: "deadline-committed-rearmed",
        runAt: rearmAt,
        payload: { stage: "new" },
        base: appDb,
      });
      release();
      await sleep(300);
      const row = await suDb.schedulerJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect({
        status: row.status,
        payload: row.payload,
        runAt: row.runAt.getTime(),
      }).toEqual({
        status: "PENDING",
        payload: { stage: "new" },
        runAt: rearmAt.getTime(),
      });
    });

    // The follow-up sweep re-arms its episodes through `enqueueJobUnlessClaimed`, which leaves a
    // CLAIMED row alone. A row its deadline put back to PENDING while the handler still runs is as
    // taken as a claimed one: re-armed under it, the step that handler is finishing could not be
    // written, and the retry would start the episode over.
    test("a re-arm unless claimed leaves a row whose handler still runs past its deadline", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const next = new Date(Date.now() + 3_600_000);
      install("HEARTBEAT", async (_job, _base, ctx) => {
        ctx?.commit();
        await gate;
        return { outcome: "reschedule", runAt: next, payload: { step: 1 } };
      });
      const job = await claimed("HEARTBEAT", "deadline-sweep-rearm");
      await runClaimed(job, appDb, { deadlineMs: 100 });
      const rearmed = await enqueueJobUnlessClaimed({
        rearm: "same-work",
        tenantId,
        kind: "HEARTBEAT",
        dedupeKey: "deadline-sweep-rearm",
        runAt: past(),
        payload: { step: 0 },
        base: appDb,
      });
      expect(rearmed).toBe(false);
      release();
      await sleep(300);
      const row = await suDb.schedulerJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect({ payload: row.payload, runAt: row.runAt.getTime() }).toEqual({
        payload: { step: 1 },
        runAt: next.getTime(),
      });
    });

    test("a committed run whose row moved on since the failure has its outcome discarded", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      install("HEARTBEAT", async (_job, _base, ctx) => {
        ctx?.commit();
        await gate;
        return { outcome: "done" };
      });
      const job = await claimed("HEARTBEAT", "deadline-committed-moved");
      await runClaimed(job, appDb, { deadlineMs: 100 });
      // A claim token that is no longer the run's: what a later claim leaves behind.
      await suDb.schedulerJob.update({
        where: { id: job.id },
        data: { claimSeq: { increment: 1 } },
      });
      release();
      await sleep(300);
      const row = await rowOf(job.id);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
    });

    test("a handler that honors its signal is failed once, not twice", async () => {
      install("HEARTBEAT", async (_job, _base, ctx) => {
        await new Promise((_, reject) =>
          ctx?.signal.addEventListener("abort", () =>
            reject(ctx.signal.reason),
          ),
        );
        return { outcome: "done" };
      });
      const job = await claimed("HEARTBEAT", "deadline-listens");
      await runClaimed(job, appDb, { deadlineMs: 100 });
      await sleep(200);
      const row = await rowOf(job.id);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
    });

    test("a run that finishes inside its deadline is not failed afterwards", async () => {
      install("HEARTBEAT", async () => {
        await sleep(20);
        return { outcome: "done" };
      });
      const job = await claimed("HEARTBEAT", "deadline-fast");
      await runClaimed(job, appDb, { deadlineMs: 150 });
      await sleep(300);
      const row = await rowOf(job.id);
      expect(row.status).toBe("DONE");
      expect(row.attempts).toBe(0);
    });

    test("a row whose handler still runs past its deadline is not claimed again until it returns", async () => {
      const h = hung();
      install("HEARTBEAT", h.handler);
      const job = await claimed("HEARTBEAT", "deadline-twice");
      try {
        await runClaimed(job, appDb, { deadlineMs: 100 });
        // The backoff put it in the future; what matters is that it is due and still running here.
        await suDb.schedulerJob.update({
          where: { id: job.id },
          data: { runAt: past() },
        });
        const during = await claimDueJobs(10, appDb, new Date(), tenantId);
        expect(during.map((j) => j.id)).not.toContain(job.id);
      } finally {
        h.release();
      }
      await sleep(50);
      const after = await claimDueJobs(10, appDb, new Date(), tenantId);
      expect(after.map((j) => j.id)).toContain(job.id);
    });

    test("the deadline sits below the reaper's stale window and follows it", () => {
      expect(jobDeadlineMs(SCHEDULER_STALE_MS)).toBeLessThan(
        SCHEDULER_STALE_MS,
      );
      expect(jobDeadlineMs(SCHEDULER_STALE_MS)).toBe(240_000);
      expect(jobDeadlineMs(1_000)).toBe(800);
    });

    test("a hung job no longer holds the scheduler tick, and the job is failed, not reaped", async () => {
      const h = hung();
      install("HEARTBEAT", h.handler);
      const id = await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "HEARTBEAT",
        dedupeKey: "deadline-tick",
        runAt: past(),
        base: appDb,
      });
      const t = performance.now();
      try {
        const out = await runSchedulerTick(appDb, {
          staleMs: 500,
          batchSize: 5,
          tenantId,
        });
        expect(out.claimed).toBe(1);
        expect(performance.now() - t).toBeLessThan(3_000);
        const row = await rowOf(id);
        expect(row.status).toBe("PENDING");
        expect(row.attempts).toBe(1);
        expect(row.lastError).toContain("deadline");
      } finally {
        h.release();
      }
    });

    test("the debounce lane's slot frees at the deadline, and another conversation is claimed", async () => {
      const h = hung();
      install("DEBOUNCE", h.handler);
      const tenants = [tenantId, otherTenantId];
      // The production claim, fenced to this file's two tenants.
      const claim: typeof claimDueDebounceJobs = (
        limit,
        base,
        now,
        _tenant,
        excludeIds,
      ) =>
        Promise.all(
          tenants.map((tenantId) =>
            claimDueDebounceJobs(limit, base, now, tenantId, excludeIds),
          ),
        ).then((all) => all.flat().slice(0, limit));
      const deps = { claim, deadlineMs: 150 };
      const a = await enqueueJob({
        rearm: "new-work",
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: `debounce:${tenantId}:deadline:a`,
        runAt: past(),
        payload: { threadId: `${tenantId}:deadline:a` },
        base: appDb,
      });
      try {
        const first = await runDebounceTick(appDb, 1, deps);
        expect(first.claimed).toBe(1);
        const b = await enqueueJob({
          rearm: "new-work",
          tenantId: otherTenantId,
          kind: "DEBOUNCE",
          dedupeKey: `debounce:${otherTenantId}:deadline:b`,
          runAt: past(),
          payload: { threadId: `${otherTenantId}:deadline:b` },
          base: appDb,
        });
        await first.settled;
        const second = await runDebounceTick(appDb, 1, deps);
        expect(second.claimed).toBe(1);
        const row = await suDb.schedulerJob.findUniqueOrThrow({
          where: { id: b },
          select: { status: true },
        });
        expect(row.status).toBe("CLAIMED");
        expect((await rowOf(a)).lastError).toContain("deadline");
        await second.settled;
      } finally {
        h.release();
        await sleep(0);
      }
    });
  },
);
