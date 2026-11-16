import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import {
  forgetSweepBatchSizesForTest,
  sweepFlowlog,
} from "@/modules/flowlog/retention";
import { JOB_DONE_RETENTION_MS } from "@/modules/scheduler/lanes";
import { upsertJobRow } from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";

// The retention pass over the scheduler's finished jobs, end to end through the flow-log sweep that
// runs it: what leaves, what stays, a `once` key that keeps blocking its re-arm, and a backlog that
// drains over several short passes.
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

const DAY = 86_400_000;
const WINDOW = JOB_DONE_RETENTION_MS.DEBOUNCE as number;
let tenantId = 0n;

async function seed(
  key: string,
  row: {
    kind?: string;
    status?: string;
    attempts?: number;
    ageMs: number;
  },
): Promise<void> {
  const at = new Date(Date.now() - row.ageMs);
  await suDb.$executeRaw`
    INSERT INTO scheduler_jobs
      (tenant_id, kind, dedupe_key, payload, status, run_at, attempts, created_at, updated_at)
    VALUES (${tenantId}, ${row.kind ?? "DEBOUNCE"}::"SchedulerJobKind", ${key}, '{}'::jsonb,
            ${row.status ?? "DONE"}::"SchedulerJobStatus", ${at}, ${row.attempts ?? 0}, ${at}, ${at})`;
}

async function keys(): Promise<string[]> {
  const rows = await suDb.$queryRaw<{ dedupe_key: string }[]>`
    SELECT dedupe_key FROM scheduler_jobs WHERE tenant_id = ${tenantId} ORDER BY dedupe_key`;
  return rows.map((r) => r.dedupe_key);
}

describe.skipIf(!dbUp)("scheduler DONE retention", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "SchedRet", slug: `sched-ret-${process.pid}` },
      })
    ).id;
  });

  beforeEach(async () => {
    forgetSweepBatchSizesForTest();
    await suDb.$executeRaw`DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`;
  });

  afterAll(async () => {
    await suDb.$executeRaw`DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`;
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("an expired DONE row leaves; what is in its window, open, failed, dead or still counting attempts stays", async () => {
    await seed("expired", { ageMs: WINDOW + DAY });
    await seed("in-window", { ageMs: WINDOW - DAY });
    await seed("pending-old", { status: "PENDING", ageMs: 400 * DAY });
    await seed("claimed-old", { status: "CLAIMED", ageMs: 400 * DAY });
    await seed("failed-old", { status: "FAILED", ageMs: 400 * DAY });
    await seed("dead-old", { status: "DEAD", ageMs: 400 * DAY });
    await seed("retired-with-attempts", { attempts: 2, ageMs: 400 * DAY });
    const r = await sweepFlowlog(appDb, tenantId);
    expect(r.done).toBe(true);
    expect(await keys()).toEqual([
      "claimed-old",
      "dead-old",
      "failed-old",
      "in-window",
      "pending-old",
      "retired-with-attempts",
    ]);
  });

  test("a `once` key keeps its DONE row, and the row keeps blocking a re-arm", async () => {
    await seed("fallback:once", {
      kind: "MEDIA_TEXT_FALLBACK",
      ageMs: 400 * DAY,
    });
    await sweepFlowlog(appDb, tenantId);
    await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        upsertJobRow(db, {
          tenantId,
          kind: "MEDIA_TEXT_FALLBACK",
          dedupeKey: "fallback:once",
          runAt: new Date(),
          payload: {},
          rearm: "once",
        }),
    );
    const rows = await suDb.$queryRaw<{ status: string }[]>`
      SELECT status::text FROM scheduler_jobs
       WHERE tenant_id = ${tenantId} AND dedupe_key = 'fallback:once'`;
    expect(rows).toEqual([{ status: "DONE" }]);
  });

  test("a backlog drains over several bounded passes", async () => {
    await suDb.$executeRaw`
      INSERT INTO scheduler_jobs
        (tenant_id, kind, dedupe_key, payload, status, run_at, attempts, created_at, updated_at)
      SELECT ${tenantId}, 'OBSERVE', 'backlog:' || g, '{}'::jsonb, 'DONE',
             ${new Date(Date.now() - WINDOW - DAY)}, 0, now(), ${new Date(Date.now() - WINDOW - DAY)}
        FROM generate_series(1, 3000) AS g`;
    await seed("kept", { ageMs: DAY });
    const opts = { batchRows: 100, passMs: 1, pauseMs: 0 };
    const first = await sweepFlowlog(appDb, tenantId, opts);
    expect(first.done).toBe(false);
    expect(first.deleted).toBeLessThan(3000);
    let passes = 1;
    let done = false;
    while (!done && passes < 200) {
      done = (await sweepFlowlog(appDb, tenantId, { ...opts, passMs: 50 }))
        .done;
      passes++;
    }
    expect(done).toBe(true);
    expect(passes).toBeGreaterThan(1);
    expect(await keys()).toEqual(["kept"]);
  });

  test("a row re-armed while the delete waits on it is kept, and the expired rows past it still leave", async () => {
    for (const k of ["race-a", "race-b", "race-c"])
      await seed(k, { ageMs: WINDOW + DAY });
    let blocked = false;
    let sweep: Promise<unknown> | undefined;
    await suDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE scheduler_jobs SET status = 'PENDING', run_at = now(), updated_at = now()
           WHERE tenant_id = ${tenantId} AND dedupe_key = 'race-a'`;
        sweep = sweepFlowlog(appDb, tenantId, { batchRows: 2, pauseMs: 0 });
        for (let i = 0; i < 200 && !blocked; i++) {
          const rows = await suDb.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE '%DELETE FROM scheduler_jobs%'`;
          blocked = (rows[0]?.n ?? 0) > 0;
          if (!blocked) await new Promise((r) => setTimeout(r, 25));
        }
      },
      { timeout: 20_000 },
    );
    expect(blocked).toBe(true);
    expect(await sweep).toMatchObject({ done: true });
    const rows = await suDb.$queryRaw<{ dedupe_key: string; status: string }[]>`
      SELECT dedupe_key, status::text FROM scheduler_jobs WHERE tenant_id = ${tenantId}`;
    expect(rows).toEqual([{ dedupe_key: "race-a", status: "PENDING" }]);
  });
});
