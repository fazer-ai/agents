import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { registerFlowlogRetentionHandler } from "@/modules/flowlog/retention";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler, type JobResult } from "@/modules/scheduler/worker";

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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;

describe.skipIf(!dbUp)("flowlog retention", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "FlowR", slug: `flow-r-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`,
      );
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
      id: 1n,
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
    const remaining = await suDb.executionLog.findMany({
      where: { tenantId },
      select: { turnId: true },
    });
    const turns = remaining.map((r) => r.turnId).sort();
    expect(turns).toEqual(["new1"]);
  });
});
