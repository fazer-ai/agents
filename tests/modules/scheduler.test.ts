import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  claimDueCompactionJobs,
  claimDueJobs,
  completeJob,
  enqueueJob,
  failJob,
  reapStaleJobs,
  rescheduleJob,
} from "@/modules/scheduler/service";
import { registerJobHandler, runClaimed } from "@/modules/scheduler/worker";

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

async function statusOf(id: bigint) {
  const row = await suDb.schedulerJob.findUniqueOrThrow({
    where: { id },
    select: { status: true, attempts: true },
  });
  return row;
}

describe.skipIf(!dbUp)("scheduler", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SCH", slug: `sch-${process.pid}` },
    });
    tenantId = t.id;
    // NOTE: this used to wipe scheduler_jobs GLOBALLY so the cross-tenant claim would only see this
    // file's rows. That made the file destructive to anything else on the database — including a
    // second suite running at the same time, whose jobs vanished mid-test. The claim and the reaper
    // now take a tenant fence instead (see claimDueJobs), so the isolation no longer needs a
    // table-wide delete.
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("enqueue is idempotent per (tenant, kind, dedupeKey)", async () => {
    const id1 = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-idem",
      runAt: new Date(Date.now() + 3_600_000),
      base: appDb,
    });
    const id2 = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-idem",
      runAt: new Date(Date.now() + 7_200_000),
      base: appDb,
    });
    expect(id2).toBe(id1);
    const count = await suDb.schedulerJob.count({
      where: { tenantId, kind: "WEBHOOK_RETRY", dedupeKey: "dk-idem" },
    });
    expect(count).toBe(1);
  });

  test("re-enqueue with a payload overwrites it; without one preserves it", async () => {
    const id = await enqueueJob({
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: "dk-payload",
      runAt: past(),
      payload: { threadId: "1:2:3", stepIndex: 1 },
      base: appDb,
    });
    // The follow-up sweep restarts a sequence: re-enqueue with the step-0 payload must reset it.
    await enqueueJob({
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: "dk-payload",
      runAt: past(),
      payload: { threadId: "1:2:3" },
      base: appDb,
    });
    const a = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { payload: true },
    });
    expect(a.payload).toEqual({ threadId: "1:2:3" });

    // A payload-less re-enqueue preserves the existing payload (e.g. the SWEEP heartbeat).
    await enqueueJob({
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: "dk-payload",
      runAt: past(),
      base: appDb,
    });
    const b = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { payload: true },
    });
    expect(b.payload).toEqual({ threadId: "1:2:3" });
  });

  // THE LANE SPLIT. The scheduler tick awaits its claimed jobs one at a time, so a kind that takes
  // seconds per job holds up everything behind it. Two kinds are drained by their own workers for
  // opposite reasons — DEBOUNCE because it must be fast, MEMORY_COMPACT because it is slow and fires
  // for every agent on every closed attendance — and neither may be picked up here, or the split
  // buys nothing.
  test("the shared lane claims neither debounce nor compaction jobs", async () => {
    const shared = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-lane-shared",
      runAt: past(),
      base: appDb,
    });
    const debounce = await enqueueJob({
      tenantId,
      kind: "DEBOUNCE",
      dedupeKey: "dk-lane-debounce",
      runAt: past(),
      base: appDb,
    });
    const compaction = await enqueueJob({
      tenantId,
      kind: "MEMORY_COMPACT",
      dedupeKey: "dk-lane-compaction",
      runAt: past(),
      base: appDb,
    });

    const claimed = await claimDueJobs(50, appDb, new Date(), tenantId);
    const ids = claimed.map((j) => j.id);
    expect(ids).toContain(shared);
    expect(ids).not.toContain(debounce);
    expect(ids).not.toContain(compaction);
    // Still PENDING, waiting for their own lane — not skipped, not lost.
    expect((await statusOf(compaction)).status).toBe("PENDING");

    // And the compaction lane claims that one, and only that one.
    const mine = await claimDueCompactionJobs(50, appDb, new Date(), tenantId);
    const mineIds = mine.map((j) => j.id);
    expect(mineIds).toEqual([compaction]);
  });

  // The exclusion has to happen in the CLAIM, not after it: a row left PENDING is protected by the
  // very CAS that would otherwise let a handler still running complete a newer arm (both are guarded
  // on id + CLAIMED).
  test("an excluded id is left PENDING, not claimed", async () => {
    const busy = await enqueueJob({
      tenantId,
      kind: "MEMORY_COMPACT",
      dedupeKey: "dk-lane-busy",
      runAt: past(),
      base: appDb,
    });
    const free = await enqueueJob({
      tenantId,
      kind: "MEMORY_COMPACT",
      dedupeKey: "dk-lane-free",
      runAt: past(),
      base: appDb,
    });

    const claimed = await claimDueCompactionJobs(
      50,
      appDb,
      new Date(),
      tenantId,
      [busy],
    );
    const ids = claimed.map((j) => j.id);
    expect(ids).toContain(free);
    expect(ids).not.toContain(busy);
    expect((await statusOf(busy)).status).toBe("PENDING");
  });

  test("claim → complete", async () => {
    const id = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-complete",
      runAt: past(),
      base: appDb,
    });
    const claimed = await claimDueJobs(10, appDb, new Date(), tenantId);
    const mine = claimed.find((j) => j.id === id);
    expect(mine).toBeDefined();
    expect((await statusOf(id)).status).toBe("CLAIMED");
    await completeJob(tenantId, id, appDb);
    expect((await statusOf(id)).status).toBe("DONE");
  });

  test("reschedule keeps attempts unchanged and re-pends", async () => {
    const id = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-resched",
      runAt: past(),
      base: appDb,
    });
    await claimDueJobs(10, appDb, new Date(), tenantId);
    await rescheduleJob(
      tenantId,
      id,
      new Date(Date.now() + 3_600_000),
      undefined,
      appDb,
    );
    const s = await statusOf(id);
    expect(s.status).toBe("PENDING");
    expect(s.attempts).toBe(0);
  });

  test("reschedule with a payload REPLACES the row payload (step advance)", async () => {
    const id = await enqueueJob({
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: "dk-resched-payload",
      runAt: past(),
      payload: { threadId: "1:2:3" },
      base: appDb,
    });
    await claimDueJobs(10, appDb, new Date(), tenantId);
    // Reschedule to the past so it can be re-claimed for the second leg of the test.
    await rescheduleJob(
      tenantId,
      id,
      past(),
      { threadId: "1:2:3", stepIndex: 1 },
      appDb,
    );
    const row = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { status: true, payload: true },
    });
    expect(row.status).toBe("PENDING");
    expect(row.payload).toEqual({ threadId: "1:2:3", stepIndex: 1 });

    // Omitting the payload on a later reschedule keeps the current one.
    await claimDueJobs(10, appDb, new Date(), tenantId);
    await rescheduleJob(tenantId, id, past(), undefined, appDb);
    const row2 = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { payload: true },
    });
    expect(row2.payload).toEqual({ threadId: "1:2:3", stepIndex: 1 });
  });

  test("fail retries until the cap, then DEAD", async () => {
    const id = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-fail",
      runAt: past(),
      base: appDb,
    });
    await claimDueJobs(10, appDb, new Date(), tenantId);
    await failJob(tenantId, id, 0, "boom", appDb);
    expect((await statusOf(id)).status).toBe("PENDING"); // retry
    // simulate near the cap
    await suDb.schedulerJob.update({
      where: { id },
      data: { attempts: 4, status: "CLAIMED" },
    });
    await failJob(tenantId, id, 4, "boom again", appDb);
    expect((await statusOf(id)).status).toBe("DEAD");
  });

  test("reaper requeues a stranded CLAIMED job", async () => {
    const id = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-reap",
      runAt: past(),
      base: appDb,
    });
    // strand it as CLAIMED with an old claimed_at
    await suDb.schedulerJob.update({
      where: { id },
      data: { status: "CLAIMED", claimedAt: new Date(Date.now() - 600_000) },
    });
    const reaped = await reapStaleJobs(5 * 60_000, appDb, new Date(), tenantId);
    expect(reaped.length).toBeGreaterThanOrEqual(1);
    // The reaper reports what it touched: it is the other road to DEAD, and a caller reacting to a
    // definitively lost job has to hear about those too.
    expect(reaped.map((r) => r.id)).toContain(id);
    expect(reaped.find((r) => r.id === id)?.status).toBe("PENDING");
    const s = await statusOf(id);
    expect(s.status).toBe("PENDING");
    expect(s.attempts).toBe(1);
  });

  test("runClaimed dispatches to the registered handler", async () => {
    let seen = false;
    registerJobHandler("WEBHOOK_RETRY", async () => {
      seen = true;
      return { outcome: "done" };
    });
    const id = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-run",
      runAt: past(),
      base: appDb,
    });
    const claimed = (await claimDueJobs(10, appDb, new Date(), tenantId)).find(
      (j) => j.id === id,
    );
    expect(claimed).toBeDefined();
    await runClaimed(claimed as NonNullable<typeof claimed>, appDb);
    expect(seen).toBe(true);
    expect((await statusOf(id)).status).toBe("DONE");
  });
});
