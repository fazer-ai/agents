import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { pendingFallbacksSql, waitingFallbacksSql } from "@/graph/ingest-job";
import { asSuperAdminOn, runScopedOn } from "@/lib/tenancy";
import { threadRemindersSql } from "@/modules/appointments/reminder-keys";
import {
  claimSql,
  laneFilter,
  reapSql,
  trafficOrder,
} from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";

// The scheduler's hot reads, planned under the role each one runs as, on a table that holds what a
// busy install's does: a few hundred open rows beside tens of thousands of finished ones. As the fleet,
// the policy hides the statistics of `status` from the planner, which then takes PENDING for a third of
// the table and scans it; under the tenant policy no enum and no LIKE reaches an index at all. Catches
// a claim, the reaper or a prefix read drifting back to a plan that walks the finished rows.
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

const PENDING = "scheduler_jobs_pending_idx";
const CLAIMED = "scheduler_jobs_claimed_idx";
const BY_KEY = "scheduler_jobs_tenant_id_dedupe_key_pattern_idx";
const FINISHED_ROWS = 60_000;
let tenantId = 0n;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

function bitmapIndexes(node: PlanNode): PlanNode[] {
  return (node.Plans ?? []).flatMap((p) =>
    p["Index Name"] !== undefined ? [p] : bitmapIndexes(p),
  );
}

// Every read of the table, a bitmap scan standing for the index scans under it.
function nodesOn(node: PlanNode): PlanNode[] {
  if (node["Relation Name"] === "scheduler_jobs") {
    if (node["Node Type"] === "Bitmap Heap Scan") return bitmapIndexes(node);
    return [node, ...(node.Plans ?? []).flatMap((p) => nodesOn(p))];
  }
  return (node.Plans ?? []).flatMap((p) => nodesOn(p));
}

type Explain = { "QUERY PLAN": [{ Plan: PlanNode }] }[];

function planOf(rows: Explain): PlanNode[] {
  const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
  if (!plan) throw new Error("no plan");
  return nodesOn(plan);
}

const asFleet = async (sql: Prisma.Sql) =>
  planOf(
    await asSuperAdminOn(appDb, (db) =>
      db.$queryRaw<Explain>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`),
    ),
  );
const asTenant = async (sql: Prisma.Sql) =>
  planOf(
    await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) => db.$queryRaw<Explain>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`),
    ),
  );

describe.skipIf(!dbUp)(
  "the scheduler's hot reads reach an index under the role that runs them",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Sched plans", slug: `schedplan-${process.pid}` },
      });
      tenantId = t.id;
      await suDb.$executeRaw`
        INSERT INTO scheduler_jobs
          (tenant_id, kind, dedupe_key, payload, status, run_at, created_at, updated_at)
        SELECT ${tenantId},
               (ARRAY['OBSERVE','DEBOUNCE','MEMORY_COMPACT','FOLLOWUP'])[1 + g % 4]::"SchedulerJobKind",
               'done:' || g, '{}'::jsonb, 'DONE',
               (now() AT TIME ZONE 'UTC') - g * interval '1 minute',
               now(), now()
          FROM generate_series(1, ${FINISHED_ROWS}) AS g`;
      await suDb.$executeRaw`
        INSERT INTO scheduler_jobs
          (tenant_id, kind, dedupe_key, payload, status, run_at, claimed_at, created_at, updated_at)
        SELECT ${tenantId},
               (ARRAY['FOLLOWUP','DEBOUNCE','INGEST_FALLBACK','APPOINTMENT_REMINDER'])[1 + g % 4]::"SchedulerJobKind",
               (ARRAY['followup:','debounce:','ingest-fallback:t:','reminder:e:'])[1 + g % 4] || g,
               jsonb_build_object('threadId', 't'),
               (CASE WHEN g % 10 = 0 THEN 'CLAIMED' ELSE 'PENDING' END)::"SchedulerJobStatus",
               (now() AT TIME ZONE 'UTC') + g * interval '1 minute',
               CASE WHEN g % 10 = 0 THEN now() AT TIME ZONE 'UTC' END,
               now(), now()
          FROM generate_series(1, 300) AS g`;
      await suDb.$executeRawUnsafe("VACUUM ANALYZE scheduler_jobs");
    });

    afterAll(async () => {
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.tenant.delete({ where: { id: tenantId } });
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("every lane's claim, as the fleet", async () => {
      const now = new Date();
      const claims = [
        claimSql(20, now, laneFilter("shared", false)),
        claimSql(
          20,
          now,
          laneFilter("shared", true),
          undefined,
          undefined,
          undefined,
          undefined,
          trafficOrder(4),
        ),
        claimSql(
          20,
          now,
          laneFilter("debounce"),
          undefined,
          [],
          undefined,
          true,
        ),
        claimSql(20, now, laneFilter("compaction")),
        claimSql(20, now, laneFilter("observe")),
      ];
      for (const sql of claims) {
        const reads = await asFleet(sql);
        const scans = reads.filter((n) => n["Node Type"] !== "ModifyTable");
        expect(scans.length).toBeGreaterThan(0);
        // NOTE: the UPDATE reaches each claimed row by its primary key; every read of the due rows
        // is the partial index of PENDING rows.
        expect(
          scans
            .map((n) => n["Index Name"])
            .filter((name) => name !== "scheduler_jobs_pkey"),
        ).toEqual(
          scans
            .filter((n) => n["Index Name"] !== "scheduler_jobs_pkey")
            .map(() => PENDING),
        );
      }
    });

    test("the reaper, as the fleet", async () => {
      const reads = await asFleet(reapSql(new Date(Date.now() - 60_000)));
      expect(
        reads
          .filter((n) => n["Node Type"] !== "ModifyTable")
          .map((n) => n["Index Name"]),
      ).toEqual([CLAIMED]);
    });

    test("the prefix reads, under the tenant policy", async () => {
      for (const sql of [
        pendingFallbacksSql(tenantId, "t"),
        waitingFallbacksSql(tenantId, "t", new Date()),
        threadRemindersSql(tenantId, "t"),
      ]) {
        const reads = await asTenant(sql);
        expect(reads.length).toBeGreaterThan(0);
        // NOTE: the reminders' read may AND the key range with the PENDING rows' index; either way
        // nothing walks the finished rows.
        for (const n of reads)
          expect([BY_KEY, PENDING]).toContain(n["Index Name"] as string);
        expect(reads.map((n) => n["Index Name"])).toContain(BY_KEY);
      }
    });

    test("the prefix reads answer what the Prisma reads they replace answered", async () => {
      const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
      const now = new Date();
      await suDb.$executeRaw`
        INSERT INTO scheduler_jobs
          (tenant_id, kind, dedupe_key, payload, status, run_at, created_at, updated_at)
        VALUES
          (${tenantId}, 'INGEST_FALLBACK', 'ingest-fallback:t:9', '{}', 'DONE', now(), now(), now()),
          (${tenantId}, 'INGEST_FALLBACK', 'ingest-fallback:t;1', '{}', 'PENDING', now(), now(), now()),
          (${tenantId}, 'INGEST_FALLBACK', 'ingest-fallback:tt:1', '{}', 'PENDING', now(), now(), now()),
          (${tenantId}, 'APPOINTMENT_REMINDER', 'reminder:other', '{"threadId":"u"}', 'PENDING', now(), now(), now()),
          (${tenantId}, 'APPOINTMENT_REMINDER', 'reminder:done', '{"threadId":"t"}', 'DONE', now(), now(), now())`;
      const [pending, waiting, reminders] = await runScopedOn(
        appDb,
        ctx,
        async (db) => [
          await db.$queryRaw<{ id: bigint }[]>(
            pendingFallbacksSql(tenantId, "t"),
          ),
          await db.$queryRaw<{ id: bigint }[]>(
            waitingFallbacksSql(tenantId, "t", now),
          ),
          await db.$queryRaw<{ runAt: Date }[]>(
            threadRemindersSql(tenantId, "t"),
          ),
        ],
      );
      const [pendingWas, waitingWas, remindersWas] = await runScopedOn(
        appDb,
        ctx,
        async (db) => [
          await db.schedulerJob.findMany({
            where: {
              tenantId,
              kind: "INGEST_FALLBACK",
              status: "PENDING",
              dedupeKey: { startsWith: "ingest-fallback:t:" },
            },
            select: { id: true },
          }),
          await db.schedulerJob.findMany({
            where: {
              tenantId,
              kind: "INGEST_FALLBACK",
              status: "PENDING",
              dedupeKey: { startsWith: "ingest-fallback:t:" },
              runAt: { gt: now },
              attempts: 0,
            },
            select: { id: true },
          }),
          await db.schedulerJob.findMany({
            where: {
              kind: "APPOINTMENT_REMINDER",
              status: "PENDING",
              payload: { path: ["threadId"], equals: "t" },
            },
            orderBy: { runAt: "asc" },
            take: 20,
            select: { runAt: true },
          }),
        ],
      );
      const ids = (rows: { id: bigint }[]) => rows.map((r) => r.id).sort();
      expect(pending.length).toBeGreaterThan(0);
      expect(ids(pending)).toEqual(ids(pendingWas as { id: bigint }[]));
      expect(waiting.length).toBeGreaterThan(0);
      expect(ids(waiting)).toEqual(ids(waitingWas as { id: bigint }[]));
      expect(reminders.length).toBeGreaterThan(0);
      expect(reminders.map((r) => r.runAt)).toEqual(
        (remindersWas as { runAt: Date }[]).map((r) => r.runAt),
      );
    });
  },
);
