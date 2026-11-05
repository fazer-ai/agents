import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import {
  JOB_DEATH_CONSEQUENCE,
  JOB_NEVER_DEAD,
  JOB_SPENDS_PROVIDER,
  NEVER_DEAD_MAX_BACKOFF_MS,
} from "@/modules/scheduler/lanes";
import {
  claimDueJobs,
  enqueueJob,
  reapStaleJobs,
  type SchedulerJobKind,
} from "@/modules/scheduler/service";
import {
  announceReaped,
  getJobHandler,
  type JobHandler,
  registerJobHandler,
  runClaimed,
  unregisterJobHandler,
} from "@/modules/scheduler/worker";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";

// A self-rescheduling sweep is one row per tenant, and its death stops every follow-up of that tenant
// until a restart. A never-dead kind backs off past the budget and announces each failure from there;
// every other kind dies at the same budget, announced once; both lines say what the loss costs before
// the raw cause. Catches a sweep dead-lettered by a run of timeouts, by the worker or by the reaper.
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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
const BOOM = "canceling statement due to statement timeout";

// Runs the row once with `handler` standing in for its kind, putting the registry back afterwards: it
// is process-global, and another file's handler for the same kind must survive this one.
async function runOnce(
  kind: SchedulerJobKind,
  dedupeKey: string,
  handler: JobHandler,
): Promise<Date> {
  await suDb.schedulerJob.updateMany({
    where: { tenantId, kind, dedupeKey },
    data: { runAt: new Date(Date.now() - 1_000) },
  });
  const [job] = await claimDueJobs(1, appDb, new Date(), tenantId);
  if (!job || job.kind !== kind) throw new Error(`nothing claimed for ${kind}`);
  const previous = getJobHandler(kind);
  registerJobHandler(kind, handler);
  const at = new Date();
  try {
    await runClaimed(job, appDb);
  } finally {
    if (previous) registerJobHandler(kind, previous);
    else unregisterJobHandler(kind);
  }
  return at;
}

const failing: JobHandler = async () => {
  throw new Error(BOOM);
};

function rowOf(kind: SchedulerJobKind, dedupeKey: string) {
  return suDb.schedulerJob.findFirstOrThrow({
    where: { tenantId, kind, dedupeKey },
    select: { status: true, attempts: true, runAt: true },
  });
}

async function deadLetterLines(kind: SchedulerJobKind) {
  // flowlog-scope: tenant-wide — the subject is how many lines a run of failures wrote; each case
  // empties this file's tenant first.
  const rows = await flowLogRows(suDb, {
    where: { tenantId, stage: "dead_letter" },
    orderBy: { id: "asc" },
  });
  return rows.filter(
    (r) => (r.detail as Record<string, unknown> | null)?.kind === kind,
  );
}

test("a never-dead kind never spends a provider per run (catches a billing sweep retried every few minutes forever)", () => {
  for (const [kind, never] of Object.entries(JOB_NEVER_DEAD)) {
    if (never)
      expect(JOB_SPENDS_PROVIDER[kind as SchedulerJobKind]).toBe(false);
  }
  expect(JOB_NEVER_DEAD.FOLLOWUP_SWEEP).toBe(true);
  expect(JOB_NEVER_DEAD.FOLLOWUP).toBe(false);
});

describe.skipIf(!dbUp)("a never-dead sweep", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Never dead", slug: `neverdead1700-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    await clearFlowLog(suDb, { tenantId });
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("keeps backing off and announcing past the budget, then runs again once the cause goes", async () => {
    await clearFlowLog(suDb, { tenantId });
    await enqueueJob({
      tenantId,
      kind: "FOLLOWUP_SWEEP",
      dedupeKey: "sweep",
      runAt: new Date(),
      rearm: "same-work",
      base: appDb,
    });
    // Nine: past the fifth the uncapped backoff (2 s doubled per attempt) is always over the cap.
    for (let i = 1; i <= 9; i++) {
      const at = await runOnce("FOLLOWUP_SWEEP", "sweep", failing);
      const row = await rowOf("FOLLOWUP_SWEEP", "sweep");
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(i);
      expect(row.runAt.getTime()).toBeGreaterThan(at.getTime());
      expect(row.runAt.getTime()).toBeLessThanOrEqual(
        Date.now() + NEVER_DEAD_MAX_BACKOFF_MS,
      );
    }
    const lines = await deadLetterLines("FOLLOWUP_SWEEP");
    // Failures 5 to 9 are past the budget of five, and each one is announced.
    expect(lines.length).toBe(5);
    for (const line of lines) {
      expect(line.level).toBe("error");
      expect((line.detail as Record<string, unknown>).retrying).toBe(true);
      expect(line.errorMessage).toBe(
        `FOLLOWUP_SWEEP keeps failing and is still retrying: ${JOB_DEATH_CONSEQUENCE.FOLLOWUP_SWEEP}. Cause: ${BOOM}`,
      );
    }

    await runOnce("FOLLOWUP_SWEEP", "sweep", async () => ({
      outcome: "reschedule",
      runAt: new Date(Date.now() + 60_000),
    }));
    const healed = await rowOf("FOLLOWUP_SWEEP", "sweep");
    expect(healed.status).toBe("PENDING");
    expect(healed.attempts).toBe(0);
  });

  test("any other kind still dies at the budget, announced once with what it costs", async () => {
    await clearFlowLog(suDb, { tenantId });
    const key = `followup:${tenantId}:1:1700`;
    await enqueueJob({
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: key,
      runAt: new Date(),
      rearm: "new-work",
      payload: { threadId: `${tenantId}:1:1700` },
      base: appDb,
    });
    for (let i = 1; i <= 5; i++) await runOnce("FOLLOWUP", key, failing);
    expect((await rowOf("FOLLOWUP", key)).status).toBe("DEAD");
    const lines = await deadLetterLines("FOLLOWUP");
    expect(lines.length).toBe(1);
    expect(lines[0]?.errorMessage).toBe(
      `FOLLOWUP died: ${JOB_DEATH_CONSEQUENCE.FOLLOWUP}. Cause: ${BOOM}`,
    );
  });

  test("the failure log does not carry a credential the handler's error echoed", async () => {
    // Assembled at run time so no scanner reads the fixture as a real key.
    const key = ["sk", "A1b2C3d4E5f6G7h8J9k0"].join("-");
    await enqueueJob({
      tenantId,
      kind: "FOLLOWUP_SWEEP",
      dedupeKey: "sweep-log",
      runAt: new Date(),
      rearm: "same-work",
      base: appDb,
    });
    const warn = spyOn(logger, "warn");
    try {
      await runOnce("FOLLOWUP_SWEEP", "sweep-log", async () => {
        throw new Error(`provider said 401 for ${key}`);
      });
      // An Error stringifies to `{}`; the logger writes its message and stack, so they are read here too.
      const logged = JSON.stringify(warn.mock.calls, (_k, v) =>
        v instanceof Error ? { message: v.message, stack: v.stack } : v,
      );
      expect(logged).toContain("scheduler: job failed");
      expect(logged).not.toContain(key);
    } finally {
      warn.mockRestore();
    }
  });

  test("the reaper does not dead-letter a crash loop of a never-dead kind, and announces it", async () => {
    const stale = new Date(Date.now() - 60 * 60_000);
    const make = (kind: SchedulerJobKind, dedupeKey: string, attempts = 4) =>
      suDb.schedulerJob.create({
        data: {
          tenantId,
          kind,
          dedupeKey,
          status: "CLAIMED",
          attempts,
          runAt: stale,
          claimedAt: stale,
        },
        select: { id: true },
      });
    await clearFlowLog(suDb, { tenantId });
    const sweep = await make("FOLLOWUP_SWEEP", "reaped-sweep");
    const other = await make("FOLLOWUP", "reaped-followup");
    // Its fourth failure: the budget of five is not spent, so the reaper says nothing about it.
    const early = await make("FOLLOWUP_SWEEP", "reaped-sweep-early", 3);
    const reaped = await reapStaleJobs(60_000, appDb, new Date(), tenantId);
    await announceReaped(reaped, appDb);
    const status = async (id: bigint) =>
      (await suDb.schedulerJob.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(sweep.id)).toBe("PENDING");
    expect(await status(other.id)).toBe("DEAD");
    expect(await status(early.id)).toBe("PENDING");
    const lines = await deadLetterLines("FOLLOWUP_SWEEP");
    expect(lines.length).toBe(1);
    expect(
      (lines[0]?.detail as Record<string, unknown> | undefined)?.jobId,
    ).toBe(String(sweep.id));
    expect(
      (lines[0]?.detail as Record<string, unknown> | undefined)?.retrying,
    ).toBe(true);
  });
});
