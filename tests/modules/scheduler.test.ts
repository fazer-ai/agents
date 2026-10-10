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
  type SchedulerJobKind,
  upsertJobRows,
} from "@/modules/scheduler/service";
import { registerJobHandler, runClaimed } from "@/modules/scheduler/worker";
import { burnSchedulerJobId } from "../utils/scheduler";

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
    // NOTE: no table-wide delete: the claim and the reaper take a tenant fence (see claimDueJobs),
    // and wiping scheduler_jobs globally would destroy the jobs of a suite running at the same time.
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

  // NOTE: the set-based sibling of the single-row upsert. It exists because a caller that arms many
  // rows INSIDE one transaction pays a round trip per row against a five-second budget, and it has
  // to answer the same two questions the single-row version does: what a re-arm means for the
  // failure budget, and whether the payload it carries is authoritative.
  describe("arming many rows at once", () => {
    const key = (n: number) => `bulk-${process.pid}-${n}`;
    const sysCtx = () => ({
      tenantId,
      userId: null,
      role: "TENANT_ADMIN" as const,
    });

    // NOTE: the set-based sibling cannot express `upsertJobRow`'s "no payload means keep the stored
    // one": the rows travel as a `text[]`, and every JSON spelling of an omission is also a payload
    // somebody could mean; coercing it to `{}` would REPLACE the stored payload and clear its secret
    // half. `@ts-expect-error` is the assertion, as in `delivery-sweep.test.ts`: making the field
    // optional again removes the error and fails the typecheck on this line.
    test("refuses at COMPILE time to arm a row with no payload", () => {
      const shape = (rows: Parameters<typeof upsertJobRows>[1]["rows"]) =>
        rows.length;
      expect(
        shape([
          // @ts-expect-error: a bulk row carries its own payload; omitting it does not typecheck.
          { dedupeKey: key(99) },
        ]),
      ).toBe(1);
    });

    test("arms every row it is given, and nothing for an empty list", async () => {
      expect(
        await runScopedOn(appDb, sysCtx(), (db) =>
          upsertJobRows(db, {
            tenantId,
            kind: "RAG_INGEST",
            rearm: "new-work",
            runAt: past(),
            rows: [],
          }),
        ),
      ).toBe(0);
      const written = await runScopedOn(appDb, sysCtx(), (db) =>
        upsertJobRows(db, {
          tenantId,
          kind: "RAG_INGEST",
          rearm: "new-work",
          runAt: past(),
          rows: [
            { dedupeKey: key(1), payload: { documentId: "1" } },
            { dedupeKey: key(2), payload: { documentId: "2" } },
          ],
        }),
      );
      expect(written).toBe(2);
      const rows = await suDb.schedulerJob.findMany({
        where: { tenantId, dedupeKey: { in: [key(1), key(2)] } },
        orderBy: { dedupeKey: "asc" },
        select: { status: true, attempts: true, payload: true },
      });
      expect(rows.map((r) => r.status)).toEqual(["PENDING", "PENDING"]);
      expect(rows.map((r) => r.attempts)).toEqual([0, 0]);
      expect(rows.map((r) => r.payload)).toEqual([
        { documentId: "1" },
        { documentId: "2" },
      ]);
    });

    test("a re-arm answers the budget question the same way the single-row upsert does", async () => {
      await suDb.schedulerJob.updateMany({
        where: { tenantId, dedupeKey: key(1) },
        data: { attempts: 4, status: "FAILED", lastError: "boom" },
      });
      await suDb.schedulerJob.updateMany({
        where: { tenantId, dedupeKey: key(2) },
        data: { attempts: 4, status: "FAILED", lastError: "boom" },
      });
      await runScopedOn(appDb, sysCtx(), (db) =>
        upsertJobRows(db, {
          tenantId,
          kind: "RAG_INGEST",
          rearm: "same-work",
          runAt: past(),
          rows: [{ dedupeKey: key(1), payload: { documentId: "1b" } }],
        }),
      );
      await runScopedOn(appDb, sysCtx(), (db) =>
        upsertJobRows(db, {
          tenantId,
          kind: "RAG_INGEST",
          rearm: "new-work",
          runAt: past(),
          rows: [{ dedupeKey: key(2), payload: { documentId: "2b" } }],
        }),
      );
      const same = await suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, dedupeKey: key(1) },
        select: {
          attempts: true,
          status: true,
          lastError: true,
          payload: true,
        },
      });
      const fresh = await suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, dedupeKey: key(2) },
        select: {
          attempts: true,
          status: true,
          lastError: true,
          payload: true,
        },
      });
      // Same work pushed again keeps the budget it has already spent; new work gets a fresh one.
      expect(same.attempts).toBe(4);
      expect(fresh.attempts).toBe(0);
      // Both are live again, with the payload of the LATEST arming.
      expect([same.status, fresh.status]).toEqual(["PENDING", "PENDING"]);
      expect([same.lastError, fresh.lastError]).toEqual([null, null]);
      expect(same.payload).toEqual({ documentId: "1b" });
      expect(fresh.payload).toEqual({ documentId: "2b" });
    });

    // The ceiling is Postgres's, not ours: a statement takes at most 65535 bind parameters, so a
    // tuple list at five per row dies at 13108 documents. Nothing upstream caps a knowledge base at
    // any number, and an import fills one in bulk, so the size that trips it is the customer's
    // catalogue. 14000 is over the line by enough that a tuple list cannot pass it.
    test("arms more rows in one statement than a tuple list could carry parameters for", async () => {
      const many = Array.from({ length: 14000 }, (_, i) => ({
        dedupeKey: `bulk-wide-${process.pid}-${i}`,
        payload: { documentId: String(i) },
      }));
      const written = await runScopedOn(appDb, sysCtx(), (db) =>
        upsertJobRows(db, {
          tenantId,
          kind: "RAG_INGEST",
          rearm: "new-work",
          runAt: past(),
          rows: many,
        }),
      );
      expect(written).toBe(14000);
      expect(
        await suDb.schedulerJob.count({
          where: {
            tenantId,
            dedupeKey: { startsWith: `bulk-wide-${process.pid}-` },
          },
        }),
      ).toBe(14000);
      await suDb.schedulerJob.deleteMany({
        where: {
          tenantId,
          dedupeKey: { startsWith: `bulk-wide-${process.pid}-` },
        },
      });
    });
  });

  // NOTE: the lane split. Two kinds are drained by their own workers for opposite reasons (DEBOUNCE
  // because it must be fast, MEMORY_COMPACT because it is slow and fires for every agent on every
  // closed attendance), and neither may be picked up by the shared lane, or the split buys nothing.
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

  // NOTE: the shared lane holds one FIFO batch of a fixed size, and one kind in it (INGEST_MESSAGE)
  // has a row count proportional to how much contacts write, armed for `now`. Ordered by run_at
  // those rows are always the oldest, so a fleet arming more of them per tick than the batch holds
  // would leave an APPOINTMENT_REMINDER unclaimed however overdue, a kind whose purpose is to
  // arrive BEFORE something. Staged at the boundary that matters: the batch is smaller than the
  // ingestion backlog.
  test("the fixed-rate claim still takes the row due first, not the row created first", async () => {
    const createdFirst = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "APPOINTMENT_REMINDER",
      dedupeKey: "dk-fixed-created-first",
      runAt: new Date(Date.now() - 60_000),
      base: appDb,
    });
    const dueFirst = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "APPOINTMENT_REMINDER",
      dedupeKey: "dk-fixed-due-first",
      runAt: new Date(Date.now() - 600_000),
      base: appDb,
    });
    await suDb.schedulerJob.update({
      where: { id: createdFirst },
      data: { createdAt: new Date(Date.now() - 3_600_000) },
    });
    const [first] = await claimDueJobs(1, appDb, new Date(), tenantId);
    expect(first?.id).toBe(dueFirst);
  });

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
      const at = new Date(Date.now() - 600_000 - i * 1000);
      const id = await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: `dk-share-ingest-${i}`,
        runAt: at,
        base: appDb,
      });
      // A traffic row is armed for the moment it is created, and the traffic claim orders by age.
      await suDb.schedulerJob.update({
        where: { id },
        data: { createdAt: at },
      });
      ingest.push(id);
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

  // NOTE: `SKIP LOCKED` lets a second tick walk PAST a row the first one holds instead of queueing
  // behind it; a queued claim, under the worker's non-overlap guard, stalls every lane and tenant.
  // Every other claim test runs with nobody holding a row, so only this one tells `FOR UPDATE` from
  // `FOR UPDATE SKIP LOCKED`: the lock is real and held from another connection. The deadline is
  // the assertion (as in scheduler-lanes.test.ts): without SKIP LOCKED the claim blocks instead of
  // failing an expectation.
  test("the claim walks past a row another holder has, instead of queueing behind it", async () => {
    const held = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-contention-held",
      // NOTE: older, which is the shape contention takes: the claim is FIFO on run_at, so the row
      // two ticks reach together is the oldest. The discrimination does NOT depend on it: a claim
      // whose limit exceeds the due rows scans every one of them and blocks on whichever is held.
      runAt: new Date(Date.now() - 120_000),
      base: appDb,
    });
    const free = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-contention-free",
      runAt: past(),
      base: appDb,
    });

    let holding!: () => void;
    const isHeld = new Promise<void>((r) => {
      holding = r;
    });
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    // A separate client, so the lock is held by another SESSION: the same connection would not
    // contend with itself, and the test would prove nothing.
    const holder = suDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM scheduler_jobs WHERE id = ${held} FOR UPDATE`;
        holding();
        await released;
      },
      { timeout: 20_000 },
    );

    try {
      await isHeld;
      const timedOut = Symbol("timeout");
      const outcome = await Promise.race([
        claimDueJobs(10, appDb, new Date(), tenantId),
        new Promise<typeof timedOut>((r) =>
          setTimeout(() => r(timedOut), 4_000),
        ),
      ]);
      expect(outcome).not.toBe(timedOut);
      const ids = (outcome as ClaimedJob[]).map((j) => j.id);
      expect(ids).toContain(free);
      expect(ids).not.toContain(held);
      // And the row somebody else holds is LEFT ALONE, not stamped CLAIMED by this claim.
      expect((await statusOf(held)).status).toBe("PENDING");
    } finally {
      release();
      await holder;
    }
  }, 30_000);

  // NOTE: the failure budget bounds CONSECUTIVE failures, not the row's lifetime, so a pass that
  // completed spends the budget it earned. Started from a NON-ZERO count on purpose: a fresh row
  // already carries `attempts === 0`, so asserting it would pin nothing.
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

  // NOTE: `rescheduleJob` has TWO write paths (a Prisma update and a raw statement for the merging
  // `payloadPatch`), and the budget has to mean the same thing on both, or the reset depends on
  // whether the caller happened to carry a counter forward. Nothing else in this file covers the
  // raw branch alone.
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

  // NOTE: `rescheduleJob` clears the budget a completed pass earned, and DONE is the same pass with
  // a different ending, so it clears it too. Every kind whose dedupeKey names a permanent identity
  // (a thread, a document) finishes its work with this call, and the budget one attendance spent
  // would otherwise still be on the row when the next one re-arms it.
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
    await failJob(
      tenantId,
      id,
      await seqOf(id),
      0,
      "WEBHOOK_RETRY",
      "boom",
      appDb,
    );
    expect((await statusOf(id)).status).toBe("PENDING"); // retry
    // simulate near the cap
    await suDb.schedulerJob.update({
      where: { id },
      data: { attempts: 4, status: "CLAIMED" },
    });
    await failJob(
      tenantId,
      id,
      await seqOf(id),
      4,
      "WEBHOOK_RETRY",
      "boom again",
      appDb,
    );
    expect((await statusOf(id)).status).toBe("DEAD");
  });

  // A job that fails on every try (a Chatwoot that is down), measured by how long after
  // its first run it goes DEAD, with each retry claimed exactly when it falls due. The recoveries are
  // armed once and nothing re-arms them, so this span is the whole outage they can outlast.
  async function deathAfterMs(kind: SchedulerJobKind, key: string) {
    const start = new Date(Date.now() - 1_000);
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind,
      dedupeKey: key,
      runAt: start,
      base: appDb,
    });
    let now = start;
    for (let run = 0; run < 10; run++) {
      // Both halves of the shared lane: the recoveries are traffic-proportional, WEBHOOK_RETRY is not.
      const claimed = [
        ...(await claimDueJobs(10, appDb, now, tenantId)),
        ...(await claimDueTrafficJobs(10, appDb, now, tenantId)),
      ].find((j) => j.id === id);
      if (!claimed) throw new Error(`not due at run ${run}`);
      const { deadLettered } = await failJob(
        tenantId,
        id,
        claimed.claimSeq,
        claimed.attempts,
        kind,
        "chatwoot unreachable",
        appDb,
        now,
      );
      if (deadLettered) return now.getTime() - start.getTime();
      now = (
        await suDb.schedulerJob.findUniqueOrThrow({
          where: { id },
          select: { runAt: true },
        })
      ).runAt;
    }
    throw new Error("never went DEAD");
  }

  test("a recovery outlasts a Chatwoot restart before it goes DEAD (#744)", async () => {
    for (const kind of [
      "DELIVERY_RECOVERY",
      "TAKEOVER_RECOVERY",
      "HUMAN_REPLY_RECOVERY",
    ] as const) {
      expect(await deathAfterMs(kind, `dk-744-${kind}`)).toBeGreaterThan(
        15 * 60_000,
      );
    }
  });

  // The control: every other kind keeps the ladder it had, which is retrying against a blip.
  test("a kind outside the recovery family still gives up within a minute (#744)", async () => {
    const span = await deathAfterMs("WEBHOOK_RETRY", "dk-744-webhook");
    expect(span).toBeGreaterThan(30_000);
    expect(span).toBeLessThan(60_000);
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

  // The absent row above is the branch every hand-built `ClaimedJob` in this suite rides: an id
  // nobody holds reads as NOT retired, which is what makes a fixture a fixture. What keeps it there
  // is `burnSchedulerJobId`, and the guarantee it owes is not "an id that looks free" but one the
  // sequence has already spent, since anything else is a number some later insert lands on.
  // tests/modules/claimed-job-fixture-ids.test.ts carries the failure that costs.
  test("a burned fixture id is one no insert can land on", async () => {
    const burned = await burnSchedulerJobId(suDb);
    expect(burned).toBeGreaterThan(0n);
    const fixture: ClaimedJob = {
      id: burned,
      tenantId,
      kind: "FOLLOWUP",
      payload: {},
      attempts: 0,
      claimSeq: 0,
    };
    expect(await jobRetired(fixture, appDb)).toBe(false);

    // The next row the sequence hands out, and the next burn after it: both strictly past the id the
    // fixture holds, which is the whole claim. A helper that returned a constant would pass every
    // other test in the tree, because an unreachable id and a stale one read the same until an
    // insert takes it.
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: "dk-burned-next",
      // Not due, and deleted below: a claimable row left behind here is one the next test's
      // `claimDueJobs(1, ...)` returns instead of its own.
      runAt: new Date(Date.now() + 3_600_000),
      base: appDb,
    });
    expect(id).toBeGreaterThan(burned);
    expect(await burnSchedulerJobId(suDb)).toBeGreaterThan(id);
    expect(await jobRetired(fixture, appDb)).toBe(false);
    await suDb.schedulerJob.delete({ where: { id } });
  });

  // NOTE: why jobRetired takes a connection. runScopedOn opens a $transaction, which PINS a pooled
  // connection holding withEntityLock's advisory lock, so a read that opens its own asks a pinned
  // pool for a second one; on the supported `DB_POOL_MAX=1` it fails. jobRetired swallows a failed
  // read as NOT retired (an unknown must not drop a legitimate message), so there the fence inside
  // the claim would answer "keep going" every time.
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
          // NOTE: opening its own from in here fails: the read cannot run, and the swallow turns
          // that into "not retired", the fence silently off.
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

  // NOTE: the backoff through the worker, which is what hands `failJob` the kind: the tests above
  // call it directly and would stay green with the worker naming any kind at all.
  test("a recovery failed by its handler backs off in minutes, not seconds (#744)", async () => {
    registerJobHandler("HUMAN_REPLY_RECOVERY", async () => ({
      outcome: "fail",
      error: "recovery: the Chatwoot account could not be read",
    }));
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "HUMAN_REPLY_RECOVERY",
      dedupeKey: "dk-744-worker",
      runAt: past(),
      base: appDb,
    });
    const claimed = (
      await claimDueTrafficJobs(10, appDb, new Date(), tenantId)
    ).find((j) => j.id === id);
    const before = Date.now();
    await runClaimed(claimed as NonNullable<typeof claimed>, appDb);
    const row = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { status: true, runAt: true },
    });
    expect(row.status).toBe("PENDING");
    expect(row.runAt.getTime() - before).toBeGreaterThan(60_000);
  });
});
