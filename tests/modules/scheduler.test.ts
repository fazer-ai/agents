import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import {
  type ClaimedJob,
  claimDueCompactionJobs,
  claimDueJobs,
  claimDueTrafficJobs,
  completeJob,
  enqueueJob,
  failJob,
  jobNotRetiredSql,
  jobRetired,
  jobRetiredStrict,
  reapStaleJobs,
  rescheduleJob,
  retireJobsByDedupeKey,
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

// The claim token the row currently carries. The tests in this file assert STATUS transitions, so
// they want whatever token is live at that moment; the token's own semantics — what a STALE one must
// refuse — are asserted in tests/modules/scheduler-claim-token.test.ts.
async function seqOf(id: bigint): Promise<number> {
  const row = await suDb.schedulerJob.findUniqueOrThrow({
    where: { id },
    select: { claimSeq: true },
  });
  return row.claimSeq;
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
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-idem",
      runAt: new Date(Date.now() + 3_600_000),
      base: appDb,
    });
    const id2 = await enqueueJob({
      rearm: "same-work",
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
      rearm: "same-work",
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: "dk-payload",
      runAt: past(),
      payload: { threadId: "1:2:3", stepIndex: 1 },
      base: appDb,
    });
    // The follow-up sweep restarts a sequence: re-enqueue with the step-0 payload must reset it.
    await enqueueJob({
      rearm: "same-work",
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
      rearm: "same-work",
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
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-lane-shared",
      runAt: past(),
      base: appDb,
    });
    const debounce = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "DEBOUNCE",
      dedupeKey: "dk-lane-debounce",
      runAt: past(),
      base: appDb,
    });
    const compaction = await enqueueJob({
      rearm: "same-work",
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

  // Round-12 review finding (P1). The shared lane holds one FIFO batch of a fixed size, and one kind
  // in it — INGEST_MESSAGE — has a row count proportional to how much contacts write, armed for
  // `now`. Ordered by run_at those rows are always the oldest, so on a fleet arming more of them per
  // tick than the batch holds, they fill every batch and an APPOINTMENT_REMINDER is never claimed at
  // all, however overdue: a kind whose entire purpose is to arrive BEFORE something.
  //
  // Staged at the boundary that matters: the batch is smaller than the ingestion backlog.
  test("a batch full of ingestion still leaves room for a due reminder", async () => {
    const reminder = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "APPOINTMENT_REMINDER",
      dedupeKey: "dk-share-reminder",
      // Due, but NEWER than the ingestion backlog below — which is the whole trap: FIFO by run_at
      // puts it last, and the batch never reaches it.
      runAt: past(),
      base: appDb,
    });
    const ingest: bigint[] = [];
    for (let i = 0; i < 8; i++) {
      ingest.push(
        await enqueueJob({
          rearm: "same-work",
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: `dk-share-ingest-${i}`,
          runAt: new Date(Date.now() - 600_000 - i * 1000),
          base: appDb,
        }),
      );
    }

    // A batch of four: smaller than the ingestion backlog, so a single claim ordered by run_at would
    // return four ingestion rows and nothing else.
    const fixed = await claimDueJobs(4, appDb, new Date(), tenantId);
    expect(fixed.map((j) => j.id)).toContain(reminder);
    expect(fixed.every((j) => j.kind !== "INGEST_MESSAGE")).toBe(true);

    // The traffic half is claimed separately and capped, so it drains steadily without ever being
    // able to crowd the batch above out.
    const traffic = await claimDueTrafficJobs(1, appDb, new Date(), tenantId);
    expect(traffic).toHaveLength(1);
    expect(traffic[0]?.kind).toBe("INGEST_MESSAGE");
    // The oldest one first: capped is not unordered.
    expect(traffic[0]?.id).toBe(ingest[7] as bigint);
  });

  // The exclusion has to happen in the CLAIM, not after it: a row left PENDING is protected by the
  // very CAS that would otherwise let a handler still running complete a newer arm (both are guarded
  // on id + CLAIMED).
  test("an excluded id is left PENDING, not claimed", async () => {
    const busy = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "MEMORY_COMPACT",
      dedupeKey: "dk-lane-busy",
      runAt: past(),
      base: appDb,
    });
    const free = await enqueueJob({
      rearm: "same-work",
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
      rearm: "same-work",
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
    await completeJob(tenantId, id, await seqOf(id), "FOLLOWUP", appDb);
    expect((await statusOf(id)).status).toBe("DONE");
  });

  // Issue #287. The failure budget bounds CONSECUTIVE failures, not the row's lifetime, so a pass
  // that completed spends the budget it earned. Started from a NON-ZERO count on purpose: the first
  // spelling of this test enqueued a fresh row and asserted `attempts === 0`, which is what the row
  // already carried, so it passed either way and pinned nothing.
  test("reschedule re-pends and clears the failure budget a completed pass earned", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-resched",
      runAt: past(),
      base: appDb,
    });
    await suDb.schedulerJob.update({ where: { id }, data: { attempts: 3 } });
    await claimDueJobs(10, appDb, new Date(), tenantId);
    await rescheduleJob(
      tenantId,
      id,
      await seqOf(id),
      new Date(Date.now() + 3_600_000),
      undefined,
      appDb,
    );
    const s = await statusOf(id);
    expect(s.status).toBe("PENDING");
    expect(s.attempts).toBe(0);
  });

  // `rescheduleJob` has TWO write paths — a Prisma update and a raw statement for the merging
  // `payloadPatch` — and the budget has to mean the same thing on both, or the reset depends on
  // whether the caller happened to carry a counter forward. Measured: removing it from the raw
  // branch alone left the rest of this file green, which is how the two would have drifted.
  // APPOINTMENT_REMINDER is the caller that takes it, and its own retry ladder (`nudgeRetries`) is
  // what bounds that work, not the scheduler's budget.
  test("the merging reschedule clears the budget too", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "APPOINTMENT_REMINDER",
      dedupeKey: "dk-resched-patch",
      runAt: past(),
      payload: { threadId: "1:2:3" },
      base: appDb,
    });
    await suDb.schedulerJob.update({ where: { id }, data: { attempts: 4 } });
    await claimDueJobs(10, appDb, new Date(), tenantId);
    await rescheduleJob(
      tenantId,
      id,
      await seqOf(id),
      past(),
      undefined,
      appDb,
      { nudgeRetries: 1 },
    );
    const row = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { status: true, attempts: true, payload: true },
    });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    // The patch still MERGES rather than replacing, which is the reason this branch exists.
    expect(row.payload).toEqual({ threadId: "1:2:3", nudgeRetries: 1 });
  });

  // The defect this issue reports, in the shape that produces it: a job that reschedules itself
  // forever (FLOWLOG_SWEEP, FOLLOWUP_SWEEP, HEARTBEAT) accumulates every failure it has ever had,
  // across weeks of otherwise successful passes, and the fifth one dead-letters the row for good.
  // Measured before the fix: DEAD after the fifth, with four healthy passes in between.
  test("a perpetual job outlives more lifetime failures than the cap", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "FLOWLOG_SWEEP",
      dedupeKey: "dk-perpetual",
      runAt: past(),
      base: appDb,
    });
    for (let round = 0; round < 8; round++) {
      await claimDueJobs(10, appDb, new Date(), tenantId);
      const before = await statusOf(id);
      await failJob(
        tenantId,
        id,
        await seqOf(id),
        before.attempts,
        "blip",
        appDb,
      );
      expect((await statusOf(id)).status).toBe("PENDING");
      // The next pass succeeds, which is what a transient blip looks like.
      await suDb.schedulerJob.update({
        where: { id },
        data: { runAt: past() },
      });
      await claimDueJobs(10, appDb, new Date(), tenantId);
      await rescheduleJob(
        tenantId,
        id,
        await seqOf(id),
        past(),
        undefined,
        appDb,
      );
    }
    expect((await statusOf(id)).status).toBe("PENDING");
  });

  // The control for the test above: the budget still bounds a unit of work that is genuinely broken,
  // because consecutive failures are never interleaved with a completed pass — a failure re-pends
  // with a backoff and the next claim fails again.
  test("consecutive failures still dead-letter at the cap", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "FLOWLOG_SWEEP",
      dedupeKey: "dk-consecutive",
      runAt: past(),
      base: appDb,
    });
    let status = "";
    for (let round = 0; round < 5; round++) {
      await suDb.schedulerJob.update({
        where: { id },
        data: { runAt: past() },
      });
      await claimDueJobs(10, appDb, new Date(), tenantId);
      const before = await statusOf(id);
      await failJob(
        tenantId,
        id,
        await seqOf(id),
        before.attempts,
        "broken",
        appDb,
      );
      status = (await statusOf(id)).status;
    }
    expect(status).toBe("DEAD");
  });

  // Issue #339, and the other half of #287. `rescheduleJob` clears the budget a completed pass
  // earned; DONE is the same pass with a different ending, and it did not. Every kind whose
  // dedupeKey names a permanent identity (a thread, a document) finishes its work with this call, so
  // the budget one attendance spent was still on the row when the next one re-armed it.
  test("completing a job clears the failure budget the pass earned", async () => {
    const id = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-complete-budget",
      runAt: past(),
      rearm: "same-work",
      base: appDb,
    });
    await suDb.schedulerJob.update({ where: { id }, data: { attempts: 3 } });
    await claimDueJobs(10, appDb, new Date(), tenantId);
    await completeJob(tenantId, id, await seqOf(id), "WEBHOOK_RETRY", appDb);
    const s = await statusOf(id);
    expect(s.status).toBe("DONE");
    expect(s.attempts).toBe(0);
  });

  // The defect #339 reports, in the shape that produces it: MEMORY_COMPACT's dedupeKey is the
  // THREAD, so one physical row serves every attendance that contact ever has. A transient failure
  // in one of them was inherited by the next, and the fifth, months later with healthy attendances in
  // between, retired compaction for that contact for good.
  //
  // The re-arm here declares "same-work" ON PURPOSE, which is the declaration that keeps the budget:
  // the row survives because the passes COMPLETED, not because the caller asked for a clean slate.
  test("a row re-armed by new work outlives more lifetime failures than the cap", async () => {
    const key = "dk-rearmed-lifetime";
    for (let attendance = 0; attendance < 8; attendance++) {
      const id = await enqueueJob({
        tenantId,
        kind: "MEMORY_COMPACT",
        dedupeKey: key,
        runAt: past(),
        rearm: "same-work",
        base: appDb,
      });
      await claimDueCompactionJobs(10, appDb, new Date(), tenantId);
      const before = await statusOf(id);
      await failJob(
        tenantId,
        id,
        await seqOf(id),
        before.attempts,
        "blip",
        appDb,
      );
      expect((await statusOf(id)).status).toBe("PENDING");
      // The retry succeeds, which is what a transient blip looks like: the attendance compacted.
      await suDb.schedulerJob.update({
        where: { id },
        data: { runAt: past() },
      });
      await claimDueCompactionJobs(10, appDb, new Date(), tenantId);
      await completeJob(tenantId, id, await seqOf(id), "MEMORY_COMPACT", appDb);
      expect((await statusOf(id)).status).toBe("DONE");
    }
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, kind: "MEMORY_COMPACT", dedupeKey: key },
      select: { status: true, attempts: true },
    });
    expect(row.status).toBe("DONE");
    expect(row.attempts).toBe(0);
  });

  // What a re-arm MEANS is the caller's knowledge, and it is the only thing left deciding the budget
  // once a completed pass clears it: the row still carries a count when its LAST pass failed. Both
  // directions are asserted here, because a field that only ever reads one way is a field nothing
  // measures.
  test("a re-arm declares whether the budget survives it", async () => {
    const id = await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-rearm-declares",
      runAt: past(),
      rearm: "same-work",
      base: appDb,
    });
    await suDb.schedulerJob.update({ where: { id }, data: { attempts: 3 } });
    await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-rearm-declares",
      runAt: past(),
      rearm: "same-work",
      base: appDb,
    });
    expect((await statusOf(id)).attempts).toBe(3);
    await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-rearm-declares",
      runAt: past(),
      rearm: "new-work",
      base: appDb,
    });
    expect((await statusOf(id)).attempts).toBe(0);
  });

  // A DEAD row re-armed for new work is the case `rearm` exists for, and the one a completed pass
  // cannot reach: five consecutive failures retired it, and every later unit of work would get ONE
  // attempt instead of five until something cleared the count.
  test("new work gets the whole budget on a row that dead-lettered", async () => {
    const id = await enqueueJob({
      tenantId,
      kind: "MEMORY_COMPACT",
      dedupeKey: "dk-dead-rearm",
      runAt: past(),
      rearm: "new-work",
      base: appDb,
    });
    await suDb.schedulerJob.update({
      where: { id },
      data: { attempts: 5, status: "DEAD" },
    });
    await enqueueJob({
      tenantId,
      kind: "MEMORY_COMPACT",
      dedupeKey: "dk-dead-rearm",
      runAt: past(),
      rearm: "new-work",
      base: appDb,
    });
    const s = await statusOf(id);
    expect(s.status).toBe("PENDING");
    expect(s.attempts).toBe(0);
  });

  test("reschedule with a payload REPLACES the row payload (step advance)", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
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
      await seqOf(id),
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
    await rescheduleJob(
      tenantId,
      id,
      await seqOf(id),
      past(),
      undefined,
      appDb,
    );
    const row2 = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { payload: true },
    });
    expect(row2.payload).toEqual({ threadId: "1:2:3", stepIndex: 1 });
  });

  test("fail retries until the cap, then DEAD", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-fail",
      runAt: past(),
      base: appDb,
    });
    await claimDueJobs(10, appDb, new Date(), tenantId);
    await failJob(tenantId, id, await seqOf(id), 0, "boom", appDb);
    expect((await statusOf(id)).status).toBe("PENDING"); // retry
    // simulate near the cap
    await suDb.schedulerJob.update({
      where: { id },
      data: { attempts: 4, status: "CLAIMED" },
    });
    await failJob(tenantId, id, await seqOf(id), 4, "boom again", appDb);
    expect((await statusOf(id)).status).toBe("DEAD");
  });

  // The tombstone calls off a RUN, so it reaches the two statuses that have one. A DEAD row does not:
  // nothing is executing it for the claim_seq bump to fence, and DONE would erase the classification
  // an operator reads to know the work was definitively lost — the reason revokeJobsByKeyPrefixOn
  // spares it too, and the invariant memory/compact.ts already writes down ("a DEAD row is not
  // PENDING and reset leaves it alone").
  test("retire calls off PENDING and CLAIMED runs, and spares a DEAD row", async () => {
    const ids: Record<string, bigint> = {};
    for (const [key, status] of [
      ["dk-retire-pending", "PENDING"],
      ["dk-retire-claimed", "CLAIMED"],
      ["dk-retire-dead", "DEAD"],
    ] as const) {
      ids[key] = await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: key,
        runAt: past(),
        base: appDb,
      });
      if (status !== "PENDING") {
        await suDb.schedulerJob.update({
          where: { id: ids[key] },
          data: { status, lastError: status === "DEAD" ? "boom" : null },
        });
      }
      await retireJobsByDedupeKey(tenantId, "FOLLOWUP", key, appDb);
    }

    expect((await statusOf(ids["dk-retire-pending"] as bigint)).status).toBe(
      "DONE",
    );
    expect((await statusOf(ids["dk-retire-claimed"] as bigint)).status).toBe(
      "DONE",
    );

    const dead = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: ids["dk-retire-dead"] as bigint },
      select: { status: true, lastError: true, payload: true },
    });
    expect(dead.status).toBe("DEAD");
    expect(dead.lastError).toBe("boom");
    // Not even the stamp: for this kind `cancelledAt` is read only by jobRetired, which asks about a
    // run — writing it on a row nobody runs says nothing and only muddies the record.
    expect(
      (dead.payload as { cancelledAt?: unknown }).cancelledAt,
    ).toBeUndefined();
  });

  // "Is this run retired?" is written twice — once as a read (`jobRetired`) and once as a SQL
  // predicate (`jobNotRetiredSql`), because one caller has to evaluate it inside the statement that
  // writes. Two expressions of one rule is how a rule starts drifting, so this pins them to the same
  // answer on every state a row can be in. The absent row is in the table on purpose: both must say
  // NOT retired there, since an unknown is not a retirement.
  test("the retirement predicate agrees with the retirement read, in both forms", async () => {
    const claimOf = async (dedupeKey: string): Promise<ClaimedJob> => {
      const id = await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey,
        runAt: past(),
        base: appDb,
      });
      const [claimed] = await claimDueJobs(1, appDb, new Date(), tenantId);
      if (!claimed || claimed.id !== id) {
        throw new Error(`claim did not return ${dedupeKey}`);
      }
      return claimed;
    };
    const sqlSaysRetired = async (job: ClaimedJob): Promise<boolean> => {
      const rows = await suDb.$queryRaw<Array<{ live: boolean }>>(
        Prisma.sql`SELECT ${jobNotRetiredSql(job)} AS live`,
      );
      return !rows[0]?.live;
    };

    // (a) claimed and untouched
    const live = await claimOf("dk-pred-live");
    expect(await jobRetired(live, appDb)).toBe(false);
    expect(await sqlSaysRetired(live)).toBe(false);

    // (b) tombstoned by the command
    const tombstoned = await claimOf("dk-pred-tomb");
    await retireJobsByDedupeKey(tenantId, "FOLLOWUP", "dk-pred-tomb", appDb);
    expect(await jobRetired(tombstoned, appDb)).toBe(true);
    expect(await sqlSaysRetired(tombstoned)).toBe(true);

    // (c) token moved with no tombstone — a re-arm this run was superseded by, which is the half a
    // condition written from the stamp alone would miss.
    const superseded = await claimOf("dk-pred-seq");
    await suDb.schedulerJob.update({
      where: { id: superseded.id },
      data: { claimSeq: superseded.claimSeq + 1 },
    });
    expect(await jobRetired(superseded, appDb)).toBe(true);
    expect(await sqlSaysRetired(superseded)).toBe(true);

    // (e) stamped with the token untouched. Not hypothetical: the per-event appointment cancel
    // (cancelAppointmentReminders) writes exactly this shape — `cancelledAt` on every row of an
    // event, no claim_seq bump — so a predicate written from the token alone would read a cancelled
    // booking as a live run.
    const stamped = await claimOf("dk-pred-stamp");
    await suDb.$executeRaw`
      UPDATE scheduler_jobs
         SET payload = payload || '{"cancelledAt":"2026-01-01T00:00:00.000Z"}'::jsonb
       WHERE id = ${stamped.id}`;
    expect(await jobRetired(stamped, appDb)).toBe(true);
    expect(await sqlSaysRetired(stamped)).toBe(true);

    // (d) absent
    const gone = await claimOf("dk-pred-gone");
    await suDb.schedulerJob.delete({ where: { id: gone.id } });
    expect(await jobRetired(gone, appDb)).toBe(false);
    expect(await sqlSaysRetired(gone)).toBe(false);
  });

  // The reason jobRetired takes a connection at all, measured rather than argued. runScopedOn opens
  // a $transaction, which PINS a pooled connection, and withEntityLock's advisory lock is held by
  // that same transaction — so a retirement read that opens its own asks a pinned pool for a second
  // connection. `DB_POOL_MAX=1` is a supported setting, and there the read does not wait: it fails.
  // Which would be survivable if it were loud, and it is not — jobRetired swallows a failed read as
  // NOT retired (deliberately: an unknown must not drop a legitimate message), so on that setting
  // the fence inside the claim would answer "keep going" every single time.
  test("the retirement read answers inside a pinned transaction, on a pool of one", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: "dk-pool-one",
      runAt: past(),
      base: appDb,
    });
    const [job] = await claimDueJobs(1, appDb, new Date(), tenantId);
    if (!job || job.id !== id)
      throw new Error("claim did not return dk-pool-one");
    await retireJobsByDedupeKey(tenantId, "FOLLOWUP", "dk-pool-one", appDb);

    const onePool = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl as string, max: 1 }),
    });
    try {
      const answers = await runScopedOn(
        onePool,
        { tenantId, userId: null, role: "SUPER_ADMIN" } as never,
        async (scoped) => ({
          // Handed the transaction's own connection: reads the row and sees the tombstone.
          shared: await jobRetired(job, onePool, scoped),
          // Opening its own from in here is the bug: the read cannot run, and the swallow turns
          // that into "not retired" — the fence silently off.
          own: await jobRetired(job, onePool),
        }),
      );
      expect(answers.shared).toBe(true);
      expect(answers.own).toBe(false);

      // THE STRICT VARIANT REFUSES TO GUESS. Same unreadable read, and it propagates instead of
      // reporting "not retired". That is what the thread's critical section asks, because there the
      // wrong guess recreates the graph state /reset just cleared, and no later fence catches it.
      await expect(
        runScopedOn(
          onePool,
          { tenantId, userId: null, role: "SUPER_ADMIN" } as never,
          async () => jobRetiredStrict(job, onePool),
        ),
      ).rejects.toThrow();
    } finally {
      await onePool.$disconnect();
    }
  });

  // Strict is only about the UNREADABLE case: on a readable row it answers exactly like the lenient
  // one, so swapping it in at a call site does not change the ordinary path.
  test("the strict probe still answers when the read succeeds", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: "dk-strict-ok",
      runAt: past(),
      base: appDb,
    });
    const [job] = await claimDueJobs(1, appDb, new Date(), tenantId);
    if (!job || job.id !== id)
      throw new Error("claim did not return dk-strict-ok");
    expect(await jobRetiredStrict(job, appDb)).toBe(false);
    await retireJobsByDedupeKey(tenantId, "FOLLOWUP", "dk-strict-ok", appDb);
    expect(await jobRetiredStrict(job, appDb)).toBe(true);
  });

  test("reaper requeues a stranded CLAIMED job", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
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
      rearm: "same-work",
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
