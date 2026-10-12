import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import {
  kindThroughputState,
  readInstanceHealth,
} from "@/modules/instance-health/read";
import {
  resetSamplerState,
  type SamplerSources,
  sampleOnce,
  snapshot,
} from "@/modules/instance-health/sampler";
import {
  SIGNALS,
  schedulerDoneSignal,
  schedulerFailedSignal,
  schedulerStalledSignal,
  THROUGHPUT_KINDS,
} from "@/modules/instance-health/signals";
import { JOB_DELETE_ON_DONE } from "@/modules/scheduler/lanes";
import {
  claimDueTrafficJobs,
  enqueueJob,
  reapStaleJobs,
  revokeJobsByKeyPrefixOn,
  type SchedulerJobKind,
} from "@/modules/scheduler/service";
import {
  jobsPerMinute,
  lastCompletedAt,
  recordJobOutcome,
  resetJobThroughput,
} from "@/modules/scheduler/throughput";
import { announceReaped, runClaimed } from "@/modules/scheduler/worker";
import { dbProbeFailed } from "@/tests/db-gate";
import { withJobHandler } from "@/tests/utils/job-registry";

// Throughput per scheduler kind: a kind whose row is deleted on DONE leaves nothing in
// the table once it ran, so the process counts what finished and what failed, and the instance
// health sampler turns that into per-minute signals and a "no progress for" signal that only grows
// while due work waits and nothing completes.

const DELETE_KINDS = (
  Object.entries(JOB_DELETE_ON_DONE) as [SchedulerJobKind, boolean][]
)
  .filter(([, del]) => del)
  .map(([k]) => k);

describe("the throughput signals in the registry", () => {
  test("every kind deleted on DONE has done, failed and stalled signals, and no kept kind has one (catches a recovery kind left blind)", () => {
    expect([...THROUGHPUT_KINDS].sort()).toEqual([...DELETE_KINDS].sort());
    const names = new Set(SIGNALS.map((s) => s.name));
    for (const kind of DELETE_KINDS) {
      expect(names.has(schedulerDoneSignal(kind))).toBe(true);
      expect(names.has(schedulerFailedSignal(kind))).toBe(true);
      expect(names.has(schedulerStalledSignal(kind))).toBe(true);
    }
    expect(names.has(schedulerDoneSignal("FOLLOWUP"))).toBe(false);
  });

  test("only the stalled signal alerts by default (catches a busy queue paging for its own completions)", () => {
    for (const kind of DELETE_KINDS) {
      const by = (n: string) => SIGNALS.find((s) => s.name === n);
      expect(by(schedulerDoneSignal(kind))?.defaultEnabled).toBe(false);
      expect(by(schedulerFailedSignal(kind))?.defaultEnabled).toBe(false);
      expect(by(schedulerStalledSignal(kind))?.defaultEnabled ?? true).toBe(
        true,
      );
      expect(by(schedulerStalledSignal(kind))?.unit).toBe("ms");
      expect(by(schedulerDoneSignal(kind))?.unit).toBe("per_minute");
    }
  });
});

describe("the in-process counter", () => {
  beforeEach(resetJobThroughput);

  test("counts the last minute only, done and failed apart (catches a rate that never falls back)", () => {
    const t0 = 1_000_000;
    recordJobOutcome("INGEST_MESSAGE", "done", t0);
    recordJobOutcome("INGEST_MESSAGE", "done", t0 + 30_000);
    recordJobOutcome("INGEST_MESSAGE", "failed", t0 + 30_000);
    expect(jobsPerMinute("INGEST_MESSAGE", "done", t0 + 30_000)).toBe(2);
    expect(jobsPerMinute("INGEST_MESSAGE", "failed", t0 + 30_000)).toBe(1);
    expect(jobsPerMinute("INGEST_MESSAGE", "done", t0 + 61_000)).toBe(1);
    expect(jobsPerMinute("INGEST_MESSAGE", "done", t0 + 95_000)).toBe(0);
    expect(jobsPerMinute("DELIVERY_RECOVERY", "done", t0)).toBe(0);
    expect(lastCompletedAt("INGEST_MESSAGE")).toBe(t0 + 30_000);
    expect(lastCompletedAt("DELIVERY_RECOVERY")).toBeNull();
  });

  test("a failure is not progress (catches a kind failing every run read as draining)", () => {
    recordJobOutcome("TAKEOVER_RECOVERY", "failed", 5_000);
    expect(lastCompletedAt("TAKEOVER_RECOVERY")).toBeNull();
  });
});

function sources(
  now: number,
  kindAges: Partial<Record<SchedulerJobKind, number>>,
): SamplerSources {
  return {
    now: () => now,
    eventLoopP99Ms: () => 0,
    modelPermitWaiters: () => 0,
    modelPermitOldestMs: () => 0,
    debounceLaneFullMs: () => 0,
    ingressLagP95Ms: () => 0,
    jobsPerMinute: (kind, outcome, at) => jobsPerMinute(kind, outcome, at),
    lastCompletedAt: (kind) => lastCompletedAt(kind),
    readDatabase: async () => ({ kindAges, chatwootPendingOldestMs: 0 }),
  };
}

describe("the sampler's throughput readings", () => {
  beforeEach(() => {
    resetSamplerState();
    resetJobThroughput();
  });

  test("a kind with no traffic reads 0 on every throughput signal, not absent (catches a quiet kind missing from the screen)", async () => {
    const values = await sampleOnce(sources(1_000_000, {}), {
      database: true,
    });
    for (const kind of DELETE_KINDS) {
      expect(values[schedulerDoneSignal(kind)]).toBe(0);
      expect(values[schedulerFailedSignal(kind)]).toBe(0);
      expect(values[schedulerStalledSignal(kind)]).toBe(0);
    }
  });

  test("due work with completions keeps the stalled reading at the time since the last one (catches a slow queue read as stuck)", async () => {
    const t0 = 10_000_000;
    // The process has been sampling for ten minutes.
    await sampleOnce(sources(t0, {}), { database: false });
    recordJobOutcome("DELIVERY_RECOVERY", "done", t0 + 590_000);
    const values = await sampleOnce(
      sources(t0 + 600_000, { DELIVERY_RECOVERY: 480_000 }),
      { database: true },
    );
    expect(values[schedulerDoneSignal("DELIVERY_RECOVERY")]).toBe(1);
    expect(values[schedulerStalledSignal("DELIVERY_RECOVERY")]).toBe(10_000);
  });

  test("due work and nothing completing grows with the oldest due row (catches a stuck queue read as quiet)", async () => {
    const t0 = 10_000_000;
    await sampleOnce(sources(t0, {}), { database: false });
    recordJobOutcome("DELIVERY_RECOVERY", "done", t0 + 1_000);
    const values = await sampleOnce(
      sources(t0 + 600_000, { DELIVERY_RECOVERY: 400_000 }),
      { database: true },
    );
    // The last completion was 599 s ago, but the oldest due row has only waited 400 s of it.
    expect(values[schedulerStalledSignal("DELIVERY_RECOVERY")]).toBe(400_000);
  });

  test("before any completion the stall counts from the process's first sample, not from before it started (catches every restart paging for its downtime)", async () => {
    const t0 = 10_000_000;
    await sampleOnce(sources(t0, {}), { database: false });
    const values = await sampleOnce(
      sources(t0 + 120_000, { NOTHING_TO_ANSWER: 3_600_000 }),
      { database: true },
    );
    expect(values[schedulerStalledSignal("NOTHING_TO_ANSWER")]).toBe(120_000);
  });

  test("nothing due reads 0 however long since the last completion (catches an idle queue read as stuck)", async () => {
    const t0 = 10_000_000;
    await sampleOnce(sources(t0, {}), { database: false });
    const values = await sampleOnce(sources(t0 + 3_600_000, {}), {
      database: true,
    });
    expect(values[schedulerStalledSignal("INGEST_MESSAGE")]).toBe(0);
  });

  test("an unreadable database leaves the stalled signal at its last point, the rates still refresh (catches a stall invented from a failed read)", async () => {
    const t0 = 10_000_000;
    await sampleOnce(sources(t0, { INGEST_MESSAGE: 50_000 }), {
      database: true,
    });
    const failing: SamplerSources = {
      ...sources(t0 + 15_000, {}),
      readDatabase: async () => {
        throw new Error("down");
      },
    };
    recordJobOutcome("INGEST_MESSAGE", "done", t0 + 14_000);
    const values = await sampleOnce(failing, { database: true });
    expect(values[schedulerStalledSignal("INGEST_MESSAGE")]).toBeUndefined();
    expect(values[schedulerDoneSignal("INGEST_MESSAGE")]).toBe(1);
    const stalled = snapshot(t0 + 15_000).signals.find(
      (s) => s.signal === schedulerStalledSignal("INGEST_MESSAGE"),
    );
    expect(stalled?.at).toBe(t0);
  });
});

describe("the reading of a kind", () => {
  test("nothing due is idle, due and progressing is draining, due and a minute without a completion is stuck (catches a slow queue and a stuck one reading the same)", () => {
    expect(kindThroughputState(null, 0)).toBe("idle");
    expect(kindThroughputState(480_000, 10_000)).toBe("draining");
    // Just completed, oldest row still due: progressing, not idle.
    expect(kindThroughputState(480_000, 0)).toBe("draining");
    expect(kindThroughputState(480_000, 59_999)).toBe("draining");
    expect(kindThroughputState(480_000, 60_000)).toBe("stuck");
    // Never read (the database half failing since boot): no claim either way.
    expect(kindThroughputState(null, null)).toBe("unknown");
  });
});

// ── the worker records what it settled ──

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;
let tenantId = 0n;

afterAll(async () => {
  if (dbUp && tenantId) {
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
  }
});

const past = () => new Date(Date.now() - 60_000);

async function claimOne(kind: SchedulerJobKind, dedupeKey: string) {
  const id = await enqueueJob({
    rearm: "same-work",
    tenantId,
    kind,
    dedupeKey,
    runAt: past(),
    base: appDb,
  });
  const claimed = (
    await claimDueTrafficJobs(50, appDb, new Date(), tenantId)
  ).find((j) => j.id === id);
  expect(claimed).toBeDefined();
  return claimed as NonNullable<typeof claimed>;
}

describe.skipIf(!dbUp)("the scheduler worker counts what it settles", () => {
  beforeEach(async () => {
    resetJobThroughput();
    if (!tenantId) {
      const t = await suDb.tenant.create({
        data: { name: "TP", slug: `tp-${process.pid}-${Date.now()}` },
      });
      tenantId = t.id;
    }
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  test("a delete-on-done run that finishes counts once as done, though its row is gone (catches the deletion erasing the only trace)", async () => {
    const job = await claimOne("DELIVERY_RECOVERY", "tp-done");
    await withJobHandler(
      "DELIVERY_RECOVERY",
      async () => ({ outcome: "done" }),
      () => runClaimed(job, appDb),
    );
    expect(await suDb.schedulerJob.count({ where: { id: job.id } })).toBe(0);
    expect(jobsPerMinute("DELIVERY_RECOVERY", "done")).toBe(1);
    expect(jobsPerMinute("DELIVERY_RECOVERY", "failed")).toBe(0);
    expect(lastCompletedAt("DELIVERY_RECOVERY")).not.toBeNull();
  });

  test("a run that fails counts as failed and not as done (catches a failing kind read as draining)", async () => {
    const job = await claimOne("TAKEOVER_RECOVERY", "tp-fail");
    await withJobHandler(
      "TAKEOVER_RECOVERY",
      async () => ({ outcome: "fail", error: "boom" }),
      () => runClaimed(job, appDb),
    );
    expect(jobsPerMinute("TAKEOVER_RECOVERY", "failed")).toBe(1);
    expect(jobsPerMinute("TAKEOVER_RECOVERY", "done")).toBe(0);
    expect(lastCompletedAt("TAKEOVER_RECOVERY")).toBeNull();
  });

  test("a run whose claim was superseded counts nothing (catches a discarded outcome read as progress)", async () => {
    const job = await claimOne("HUMAN_REPLY_RECOVERY", "tp-superseded");
    await withJobHandler(
      "HUMAN_REPLY_RECOVERY",
      async () => {
        await suDb.schedulerJob.update({
          where: { id: job.id },
          data: { claimSeq: { increment: 1 } },
        });
        return { outcome: "done" };
      },
      () => runClaimed(job, appDb),
    );
    expect(jobsPerMinute("HUMAN_REPLY_RECOVERY", "done")).toBe(0);
    expect(lastCompletedAt("HUMAN_REPLY_RECOVERY")).toBeNull();
  });

  test("the health read carries each kind's rates, oldest due job, stall and reading (catches the screen and MCP left to guess the state)", async () => {
    resetSamplerState();
    const t0 = Date.now() - 600_000;
    await sampleOnce(sources(t0, {}), { database: false });
    recordJobOutcome("DELIVERY_RECOVERY", "done", t0 + 590_000);
    recordJobOutcome("DELIVERY_RECOVERY", "failed", t0 + 595_000);
    await sampleOnce(
      sources(t0 + 600_000, {
        DELIVERY_RECOVERY: 480_000,
        TAKEOVER_RECOVERY: 200_000,
      }),
      { database: true },
    );
    const health = await readInstanceHealth(true, appDb, t0 + 600_000);
    expect(health.schedulerThroughput.DELIVERY_RECOVERY).toEqual({
      donePerMin: 1,
      failedPerMin: 1,
      oldestDueMs: 480_000,
      stalledMs: 10_000,
      state: "draining",
    });
    expect(health.schedulerThroughput.TAKEOVER_RECOVERY?.state).toBe("stuck");
    expect(health.schedulerThroughput.INGEST_MESSAGE).toEqual({
      donePerMin: 0,
      failedPerMin: 0,
      oldestDueMs: null,
      stalledMs: 0,
      state: "idle",
    });
    const muted = health.signals.find(
      (s) => s.signal === schedulerDoneSignal("DELIVERY_RECOVERY"),
    );
    expect(muted?.enabled).toBe(false);
    resetSamplerState();
  });

  test("rows a reset revokes count as nothing, even the one already running when it lands (catches erased work read as completed)", async () => {
    await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "INGEST_MESSAGE",
      dedupeKey: "ingest:tp-thread:2",
      runAt: new Date(Date.now() + 3_600_000),
      base: appDb,
    });
    const running = await claimOne("INGEST_MESSAGE", "ingest:tp-thread:1");
    await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        revokeJobsByKeyPrefixOn(db, "INGEST_MESSAGE", "ingest:tp-thread:"),
    );
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, dedupeKey: { startsWith: "ingest:tp-thread:" } },
      }),
    ).toBe(0);
    await withJobHandler(
      "INGEST_MESSAGE",
      async () => ({ outcome: "done" }),
      () => runClaimed(running, appDb),
    );
    expect(jobsPerMinute("INGEST_MESSAGE", "done")).toBe(0);
    expect(jobsPerMinute("INGEST_MESSAGE", "failed")).toBe(0);
    expect(lastCompletedAt("INGEST_MESSAGE")).toBeNull();
  });

  test("a claim the reaper takes back counts as failed (catches a crashed run vanishing from the rate)", async () => {
    const job = await claimOne("NOTHING_TO_ANSWER", "tp-reaped");
    await suDb.schedulerJob.update({
      where: { id: job.id },
      data: { claimedAt: new Date(Date.now() - 600_000) },
    });
    const reaped = await reapStaleJobs(5 * 60_000, appDb, new Date(), tenantId);
    expect(reaped.some((r) => r.id === job.id)).toBe(true);
    await announceReaped(reaped, appDb);
    expect(jobsPerMinute("NOTHING_TO_ANSWER", "failed")).toBe(1);
    expect(jobsPerMinute("NOTHING_TO_ANSWER", "done")).toBe(0);
  });
});
