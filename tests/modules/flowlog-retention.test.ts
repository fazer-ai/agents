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
import config from "@/config";
import {
  emptyKeptDays,
  ensureFlowlogSweep,
  forgetSweepBatchSizesForTest,
  nextBatchSize,
  registerFlowlogRetentionHandler,
  SWEEP_BATCH_ROWS,
  SWEEP_BOOT_DELAY_MS,
  SWEEP_CATCHUP_MS,
  SWEEP_PASS_MS,
  setSweepOptionsForTest,
  sweepBatchSizeForTest,
  sweepFlowlog,
} from "@/modules/flowlog/retention";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler, type JobResult } from "@/modules/scheduler/worker";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";
import { burnSchedulerJobId } from "../utils/scheduler";

// FLOWLOG_SWEEP retention handler: deletes execution_logs (+ terminal alert_deliveries) older than
// the retention window, RLS-scoped to the job's tenant, and reschedules +24h (no attempt consumed).

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

// Burned from `scheduler_jobs_id_seq`, never a literal: tests/utils/scheduler.ts says why.
let phantomJobId = 0n;

let tenantId = 0n;

describe.skipIf(!dbUp)("flowlog retention", () => {
  beforeAll(async () => {
    phantomJobId = await burnSchedulerJobId(suDb);
    tenantId = (
      await suDb.tenant.create({
        data: { name: "FlowR", slug: `flow-r-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("deletes rows past the retention window, keeps recent ones, reschedules +24h", async () => {
    const days = config.flowlog.retentionDays;
    const old = new Date(Date.now() - (days + 5) * 86_400_000);
    const recent = new Date(Date.now() - 1 * 86_400_000);
    // Two old rows (deletable) + one recent (kept). created_at is set explicitly via raw insert.
    await suDb.$executeRawUnsafe(
      `INSERT INTO execution_logs (tenant_id, turn_id, stage, level, source, created_at)
       VALUES (${tenantId}, 'old1', 'generate', 'info', 'inbox', '${old.toISOString()}'),
              (${tenantId}, 'old2', 'tts', 'error', 'inbox', '${old.toISOString()}'),
              (${tenantId}, 'new1', 'generate', 'info', 'inbox', '${recent.toISOString()}')`,
    );

    registerFlowlogRetentionHandler();
    const handler = getJobHandler("FLOWLOG_SWEEP");
    expect(handler).toBeDefined();
    const job: ClaimedJob = {
      id: phantomJobId,
      tenantId,
      kind: "FLOWLOG_SWEEP",
      payload: {},
      attempts: 0,
      claimSeq: 0,
    };
    const result = (await (handler as NonNullable<typeof handler>)(
      job,
      appDb,
    )) as JobResult;

    // Reschedules ~24h out without failing.
    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule") {
      expect(result.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    }
    // flowlog-scope: tenant-wide — the assertion is WHICH rows survived the sweep, so it has to
    // read the tenant exhaustively; a scoped read could not say that old1/old2 are gone.
    const remaining = await flowLogRows(suDb, {
      orderBy: { id: "asc" },
      where: { tenantId },
      select: { turnId: true },
    });
    const turns = remaining.map((r) => r.turnId).sort();
    expect(turns).toEqual(["new1"]);
  });

  // The kept days and their queue have no reader any more: their tables stay one release for a
  // rollback, and the sweep empties both for the tenant, so a rollback never reads a kept day whose
  // invalidation was dropped.
  test("empties the tenant's kept days and their queue, and no other tenant's", async () => {
    const other = (
      await suDb.tenant.create({
        data: { name: "FlowR2", slug: `flow-r2-${process.pid}` },
      })
    ).id;
    try {
      for (const t of [tenantId, other])
        await suDb.$executeRawUnsafe(
          `INSERT INTO dashboard_days (tenant_id, version, filter_key, tz, day, section, data)
           VALUES (${t}, 'v', 'k', 'UTC', '2026-09-01', 'conv', '{}');
           INSERT INTO dashboard_dirty (tenant_id, section) VALUES (${t}, 'probe')`,
        );
      registerFlowlogRetentionHandler();
      const handler = getJobHandler("FLOWLOG_SWEEP") as NonNullable<
        ReturnType<typeof getJobHandler>
      >;
      await handler(
        {
          id: phantomJobId,
          tenantId,
          kind: "FLOWLOG_SWEEP",
          payload: {},
          attempts: 0,
          claimSeq: 0,
        },
        appDb,
      );
      const count = async (table: string, t: bigint) =>
        Number(
          (
            await suDb.$queryRawUnsafe<{ n: number }[]>(
              `SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = ${t}`,
            )
          )[0]?.n,
        );
      expect(await count("dashboard_days", tenantId)).toBe(0);
      expect(await count("dashboard_dirty", tenantId)).toBe(0);
      expect(await count("dashboard_days", other)).toBe(1);
      expect(await count("dashboard_dirty", other)).toBe(1);
    } finally {
      for (const table of ["dashboard_days", "dashboard_dirty"])
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id IN (${tenantId}, ${other})`,
        );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${other}`);
    }
  });

  // Each batch of the kept days commits on its own, after the log is pruned: a tenant whose kept days
  // outlast one transaction's budget keeps the log's pruning, and the queue of a day still kept.
  test("a failure emptying the kept days takes back neither the log's pruning nor a kept day's queue", async () => {
    const old = new Date(
      Date.now() - (config.flowlog.retentionDays + 5) * 86_400_000,
    );
    await suDb.$executeRawUnsafe(
      `INSERT INTO execution_logs (tenant_id, turn_id, stage, level, source, created_at)
       VALUES (${tenantId}, 'stale', 'generate', 'info', 'inbox', '${old.toISOString()}');
       INSERT INTO dashboard_days (tenant_id, version, filter_key, tz, day, section, data)
       VALUES (${tenantId}, 'v', 'k', 'UTC', '2026-09-01', 'conv', '{}');
       INSERT INTO dashboard_dirty (tenant_id, section) VALUES (${tenantId}, 'probe')`,
    );
    // Stands in for a delete that ran out of time: only this tenant's kept days refuse it.
    await suDb.$executeRawUnsafe(
      `CREATE FUNCTION retention_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.tenant_id = ${tenantId} THEN RAISE EXCEPTION 'out of time' USING ERRCODE = '57014'; END IF;
         RETURN OLD;
       END $$`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER retention_test_refuse BEFORE DELETE ON dashboard_days
       FOR EACH ROW EXECUTE FUNCTION retention_test_refuse()`,
    );
    try {
      registerFlowlogRetentionHandler();
      const handler = getJobHandler("FLOWLOG_SWEEP") as NonNullable<
        ReturnType<typeof getJobHandler>
      >;
      const outcome = await handler(
        {
          id: phantomJobId,
          tenantId,
          kind: "FLOWLOG_SWEEP",
          payload: {},
          attempts: 0,
          claimSeq: 0,
        },
        appDb,
      ).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(Error);
      // flowlog-scope: tenant-wide, the assertion is that the stale line is gone.
      const stale = await flowLogRows(suDb, {
        orderBy: { id: "asc" },
        where: { tenantId, turnId: "stale" },
        select: { turnId: true },
      });
      expect(stale).toEqual([]);
      const count = async (table: string) =>
        Number(
          (
            await suDb.$queryRawUnsafe<{ n: number }[]>(
              `SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = ${tenantId}`,
            )
          )[0]?.n,
        );
      expect(await count("dashboard_days")).toBe(1);
      // The probe, and whatever the log's own triggers queued for the inserted line.
      expect(await count("dashboard_dirty")).toBeGreaterThan(0);
    } finally {
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER retention_test_refuse ON dashboard_days",
      );
      await suDb.$executeRawUnsafe("DROP FUNCTION retention_test_refuse()");
      for (const table of ["dashboard_days", "dashboard_dirty"])
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
    }
  });
});

// A backlog on a database where each DELETE statement is slow, which is what a large production
// table with its triggers and indexes is: a statement-level trigger on this tenant's deletes sleeps a
// fraction of the transaction timeout, so three batches in one transaction outlive it and three
// batches in three transactions do not.
describe.skipIf(!dbUp)("flowlog retention under a backlog", () => {
  let backlogTenant = 0n;
  let jobId = 0n;
  const trig = `flowlog_slow_${process.pid}`;
  const sleepSec = (config.dbTx.timeoutMs * 0.4) / 1000;

  const expiredAt = () =>
    new Date(Date.now() - (config.flowlog.retentionDays + 3) * 86_400_000);
  async function seedExpired(rows: number) {
    await suDb.$executeRawUnsafe(
      `INSERT INTO execution_logs (tenant_id, turn_id, stage, level, source, created_at)
       SELECT ${backlogTenant}, 'old' || g, 'generate', 'info', 'inbox', '${expiredAt().toISOString()}'
         FROM generate_series(1, ${rows}) g`,
    );
  }
  async function expiredLeft(): Promise<number> {
    const r = await suDb.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM execution_logs
        WHERE tenant_id = ${backlogTenant} AND created_at < now() - interval '${config.flowlog.retentionDays} days'`,
    );
    return r[0]?.n ?? -1;
  }
  function job(): ClaimedJob {
    return {
      id: jobId,
      tenantId: backlogTenant,
      kind: "FLOWLOG_SWEEP",
      payload: {},
      attempts: 0,
      claimSeq: 0,
    };
  }

  beforeAll(async () => {
    jobId = await burnSchedulerJobId(suDb);
    backlogTenant = (
      await suDb.tenant.create({
        data: { name: "FlowBacklog", slug: `flow-backlog-${process.pid}` },
      })
    ).id;
    await suDb.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${trig}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF current_setting('app.tenant_id', true) = '${backlogTenant}' THEN
           PERFORM pg_sleep(${sleepSec});
         END IF;
         RETURN NULL;
       END $$`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER ${trig} AFTER DELETE ON execution_logs
       FOR EACH STATEMENT EXECUTE FUNCTION ${trig}()`,
    );
    registerFlowlogRetentionHandler();
  });

  afterAll(async () => {
    setSweepOptionsForTest({});
    await suDb.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${trig} ON execution_logs`,
    );
    await suDb.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${trig}()`);
    if (backlogTenant) {
      await clearFlowLog(suDb, { tenantId: backlogTenant });
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${backlogTenant}`,
      );
    }
  });

  beforeEach(() => forgetSweepBatchSizesForTest());

  test("a backlog of three batches drains in one pass and the sweep goes back to its daily rhythm", async () => {
    await clearFlowLog(suDb, { tenantId: backlogTenant });
    await seedExpired(2 * SWEEP_BATCH_ROWS + 500);
    setSweepOptionsForTest({
      batchRows: SWEEP_BATCH_ROWS,
      targetBatchMs: 0,
      pauseMs: 0,
      passMs: 60_000,
    });
    const handler = getJobHandler("FLOWLOG_SWEEP") as NonNullable<
      ReturnType<typeof getJobHandler>
    >;
    const result = (await handler(job(), appDb)) as JobResult;
    expect(await expiredLeft()).toBe(0);
    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule")
      expect(result.runAt.getTime()).toBeGreaterThan(
        Date.now() + 23 * 3_600_000,
      );
  }, 60_000);

  test("a pass cut by its deadline keeps every batch it committed and runs again shortly", async () => {
    await clearFlowLog(suDb, { tenantId: backlogTenant });
    const total = 6_000;
    await seedExpired(total);
    const batchRows = 1_000;
    // Two slow statements fit the pass, six do not.
    setSweepOptionsForTest({
      batchRows,
      targetBatchMs: 0,
      pauseMs: 0,
      passMs: Math.ceil(sleepSec * 1000 * 1.5),
    });
    const handler = getJobHandler("FLOWLOG_SWEEP") as NonNullable<
      ReturnType<typeof getJobHandler>
    >;
    const before = Date.now();
    const result = (await handler(job(), appDb)) as JobResult;
    const left = await expiredLeft();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(total);
    expect((total - left) % batchRows).toBe(0);
    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule") {
      expect(result.runAt.getTime()).toBeGreaterThanOrEqual(
        before + SWEEP_CATCHUP_MS,
      );
      expect(result.runAt.getTime()).toBeLessThan(
        Date.now() + SWEEP_CATCHUP_MS + 5_000,
      );
    }
  }, 60_000);

  test("with the default budget the handler hands the scheduler back within one pass and one batch", async () => {
    await clearFlowLog(suDb, { tenantId: backlogTenant });
    await seedExpired(6 * 1_000);
    setSweepOptionsForTest({ batchRows: 1_000, pauseMs: 0 });
    const handler = getJobHandler("FLOWLOG_SWEEP") as NonNullable<
      ReturnType<typeof getJobHandler>
    >;
    const started = Date.now();
    const result = (await handler(job(), appDb)) as JobResult;
    expect(Date.now() - started).toBeLessThan(
      SWEEP_PASS_MS + sleepSec * 1000 + 1_500,
    );
    expect(await expiredLeft()).toBeGreaterThan(0);
    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule")
      expect(result.runAt.getTime()).toBeLessThan(
        Date.now() + SWEEP_CATCHUP_MS + 5_000,
      );
  }, 60_000);

  test("a batch that outlives the transaction is taken again at half the size, in the next pass when this one is spent", async () => {
    await clearFlowLog(suDb, { tenantId: backlogTenant });
    const batchRows = 400;
    await seedExpired(batchRows);
    // Per row, so a full batch outlives the transaction and half of one does not.
    const perRow = `${trig}_row`;
    const rowSec = (config.dbTx.timeoutMs * 1.4) / 1000 / batchRows;
    await suDb.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${perRow}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF current_setting('app.tenant_id', true) = '${backlogTenant}' THEN
             PERFORM pg_sleep(${rowSec});
           END IF;
           RETURN NULL;
         END $$`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER ${perRow} AFTER DELETE ON execution_logs
         FOR EACH ROW EXECUTE FUNCTION ${perRow}()`,
    );
    // The per-statement delay of the other cases off, so only the batch's size decides its time.
    await suDb.$executeRawUnsafe(
      `ALTER TABLE execution_logs DISABLE TRIGGER ${trig}`,
    );
    forgetSweepBatchSizesForTest();
    try {
      // The default pass budget: the batch that times out spends the pass, as it does in production.
      const passes: { deleted: number; done: boolean }[] = [];
      while (passes.length < 4 && !passes.at(-1)?.done)
        passes.push(
          await sweepFlowlog(appDb, backlogTenant, { batchRows, pauseMs: 0 }),
        );
      expect(passes.at(-1)?.done).toBe(true);
      expect(passes.reduce((t, p) => t + p.deleted, 0)).toBe(batchRows);
      expect(await expiredLeft()).toBe(0);
    } finally {
      forgetSweepBatchSizesForTest();
      await suDb.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${perRow} ON execution_logs`,
      );
      await suDb.$executeRawUnsafe(
        `ALTER TABLE execution_logs ENABLE TRIGGER ${trig}`,
      );
      await suDb.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${perRow}()`);
    }
  }, 90_000);

  test("a batch is sized by its own time, so a slow table never runs a batch out of time", async () => {
    await clearFlowLog(suDb, { tenantId: backlogTenant });
    const total = 3_000;
    await seedExpired(total);
    // Per row: a first batch of 1,000 takes half the transaction's budget, and a batch of 5,000 (the
    // old fixed size) would take two and a half budgets.
    const perRow = `${trig}_cost`;
    const rowSec = (config.dbTx.timeoutMs * 0.5) / 1000 / 1_000;
    await suDb.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${perRow}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF current_setting('app.tenant_id', true) = '${backlogTenant}' THEN
             PERFORM pg_sleep(${rowSec});
           END IF;
           RETURN NULL;
         END $$`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER ${perRow} AFTER DELETE ON execution_logs
         FOR EACH ROW EXECUTE FUNCTION ${perRow}()`,
    );
    await suDb.$executeRawUnsafe(
      `ALTER TABLE execution_logs DISABLE TRIGGER ${trig}`,
    );
    try {
      const passes: { deleted: number; done: boolean; timeouts: number }[] = [];
      passes.push(await sweepFlowlog(appDb, backlogTenant, { pauseMs: 0 }));
      // The next pass starts from what the table settled on, not from the first size again.
      expect(sweepBatchSizeForTest(`${backlogTenant}:0`)).toBeLessThan(1_000);
      while (passes.length < 6 && !passes.at(-1)?.done)
        passes.push(await sweepFlowlog(appDb, backlogTenant, { pauseMs: 0 }));
      expect(passes.at(-1)?.done).toBe(true);
      expect(passes.reduce((t, p) => t + p.timeouts, 0)).toBe(0);
      expect(await expiredLeft()).toBe(0);
    } finally {
      await suDb.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${perRow} ON execution_logs`,
      );
      await suDb.$executeRawUnsafe(
        `ALTER TABLE execution_logs ENABLE TRIGGER ${trig}`,
      );
      await suDb.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${perRow}()`);
    }
  }, 90_000);

  test("the next batch grows when one ran fast and shrinks when one ran slow, within its bounds", () => {
    expect(nextBatchSize(1_000, 250)).toBe(2_000);
    expect(nextBatchSize(1_000, 4_000)).toBe(500);
    expect(nextBatchSize(1_000, 1_250)).toBe(800);
    expect(nextBatchSize(4_000, 100)).toBe(SWEEP_BATCH_ROWS);
    expect(nextBatchSize(150, 4_000)).toBe(100);
    expect(nextBatchSize(1_000, 4_000, 0)).toBe(1_000);
  });

  test("a catch-up pass takes up the tables the sweep has left, so slow checks neither starve a table nor keep the sweep from finishing", async () => {
    await clearFlowLog(suDb, { tenantId: backlogTenant });
    const channel = await suDb.alertChannel.create({
      data: {
        tenantId: backlogTenant,
        name: "starve",
        type: "generic",
        url: "https://alerts.example.invalid/hook",
      },
    });
    await suDb.alertDelivery.create({
      data: {
        tenantId: backlogTenant,
        channelId: channel.id,
        level: "error",
        summary: "expired",
        status: "DELIVERED",
        createdAt: expiredAt(),
      },
    });
    // The per-statement delay on the two delivery tables too: no table has a backlog, but every
    // table's check takes the same slow statement, so a pass finishes two tables at most.
    const others = ["alert_deliveries", "agent_turn_deliveries"];
    for (const table of others)
      await suDb.$executeRawUnsafe(
        `CREATE TRIGGER ${trig} AFTER DELETE ON ${table}
           FOR EACH STATEMENT EXECUTE FUNCTION ${trig}()`,
      );
    try {
      const passMs = Math.ceil(sleepSec * 1000 * 1.5);
      const passes: { done: boolean }[] = [];
      while (passes.length < 3 && !passes.at(-1)?.done)
        passes.push(
          await sweepFlowlog(appDb, backlogTenant, { pauseMs: 0, passMs }),
        );
      expect(passes.at(-1)?.done).toBe(true);
      expect(
        await suDb.alertDelivery.count({ where: { tenantId: backlogTenant } }),
      ).toBe(0);
    } finally {
      for (const table of others)
        await suDb.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS ${trig} ON ${table}`,
        );
      await suDb.alertChannel.delete({ where: { id: channel.id } });
    }
  }, 60_000);

  test("an expired alert delivery goes only once it is delivered or dead", async () => {
    const old = expiredAt();
    const channel = await suDb.alertChannel.create({
      data: {
        tenantId: backlogTenant,
        name: "sweep",
        type: "generic",
        url: "https://alerts.example.invalid/hook",
      },
    });
    for (const status of ["DELIVERED", "DEAD", "PENDING"] as const)
      await suDb.alertDelivery.create({
        data: {
          tenantId: backlogTenant,
          channelId: channel.id,
          level: "error",
          summary: status,
          status,
          createdAt: old,
        },
      });
    await sweepFlowlog(appDb, backlogTenant, { pauseMs: 0 });
    const left = await suDb.alertDelivery.findMany({
      where: { tenantId: backlogTenant },
      select: { status: true },
    });
    expect(left.map((d) => d.status)).toEqual(["PENDING"]);
    await suDb.alertChannel.delete({ where: { id: channel.id } });
  }, 30_000);

  test("each batch costs its own rows, not a rescan of the tenant's backlog", async () => {
    await clearFlowLog(suDb, { tenantId: backlogTenant });
    const total = 20_000;
    await seedExpired(total);
    await suDb.$executeRawUnsafe(
      `ALTER TABLE execution_logs DISABLE TRIGGER ${trig}`,
    );
    try {
      // Two hundred batches of 100: picking a batch's rows once each fits; rescanning the
      // tenant's 20k rows for every row picked does not.
      const r = await sweepFlowlog(appDb, backlogTenant, {
        batchRows: 100,
        targetBatchMs: 0,
        pauseMs: 0,
        passMs: 20_000,
      });
      expect(r).toEqual({ deleted: total, done: true, timeouts: 0 });
    } finally {
      await suDb.$executeRawUnsafe(
        `ALTER TABLE execution_logs ENABLE TRIGGER ${trig}`,
      );
    }
  }, 60_000);

  test("a boot re-arm runs the sweep minutes after the restart, not a day later", async () => {
    // The row a drain leaves: pending, run_at one catch-up away.
    await ensureFlowlogSweep(backlogTenant, suDb);
    await suDb.$executeRawUnsafe(
      `UPDATE scheduler_jobs SET run_at = now() + interval '60 seconds'
        WHERE tenant_id = ${backlogTenant} AND kind = 'FLOWLOG_SWEEP'`,
    );
    const before = Date.now();
    await ensureFlowlogSweep(backlogTenant, suDb);
    const row = await suDb.schedulerJob.findFirst({
      where: { tenantId: backlogTenant, kind: "FLOWLOG_SWEEP" },
      select: { runAt: true, status: true },
    });
    expect(row?.status).toBe("PENDING");
    expect(row?.runAt.getTime()).toBeLessThanOrEqual(
      Date.now() + SWEEP_BOOT_DELAY_MS,
    );
    expect(row?.runAt.getTime()).toBeLessThan(before + 3_600_000);
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${backlogTenant} AND kind = 'FLOWLOG_SWEEP'`,
    );
  });

  test("sweepFlowlog reports done only when every table is within the window", async () => {
    await clearFlowLog(suDb, { tenantId: backlogTenant });
    await seedExpired(10);
    const r = await sweepFlowlog(appDb, backlogTenant, { pauseMs: 0 });
    expect(r).toEqual({ deleted: 10, done: true, timeouts: 0 });
    expect(await expiredLeft()).toBe(0);
  }, 30_000);

  // The kept days share the sweep's pass budget: past the pass's end no further batch starts, but a
  // pass always takes one, so a pass the log's sweep spent still makes progress on them.
  test("the kept days take one batch past the pass's end, and the rest in the next pass", async () => {
    const tenantId = (
      await suDb.tenant.create({
        data: { name: "FlowKept", slug: `flow-kept-${process.pid}` },
      })
    ).id;
    await suDb.$executeRawUnsafe(
      `INSERT INTO dashboard_days (tenant_id, version, filter_key, tz, day, section, data)
       SELECT ${tenantId}, 'v', 'k' || g, 'UTC', '2026-09-01', 'conv', '{}'
         FROM generate_series(1, ${SWEEP_BATCH_ROWS + 3}) g`,
    );
    const count = async () =>
      Number(
        (
          await suDb.$queryRawUnsafe<{ n: number }[]>(
            `SELECT COUNT(*)::int AS n FROM dashboard_days WHERE tenant_id = ${tenantId}`,
          )
        )[0]?.n,
      );
    try {
      expect(await emptyKeptDays(appDb, tenantId, Date.now() - 1)).toBe(false);
      expect(await count()).toBe(3);
      expect(await emptyKeptDays(appDb, tenantId, Date.now() + 60_000)).toBe(
        true,
      );
      expect(await count()).toBe(0);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
  });
});
