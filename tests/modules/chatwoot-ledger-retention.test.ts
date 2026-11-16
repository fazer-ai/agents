import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { asSuperAdminOn, runScopedOn } from "@/lib/tenancy";
import {
  LEDGER_RETENTION_MS,
  ledgerRetentionBatch,
  ledgerRetentionCutoffs,
} from "@/modules/chatwoot/ledger-retention";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { armHumanReplyRecovery } from "@/modules/chatwoot/recover-human-reply";
import { armTakeoverRecovery } from "@/modules/chatwoot/recover-takeover";
import { recordAndProcessChatwootDelivery } from "@/modules/chatwoot/webhook";
import {
  forgetSweepBatchSizesForTest,
  registerFlowlogRetentionHandler,
  SWEEP_CATCHUP_MS,
  setSweepOptionsForTest,
  sweepFlowlog,
} from "@/modules/flowlog/retention";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler, type JobResult } from "@/modules/scheduler/worker";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog } from "../utils/flowlog";
import { burnSchedulerJobId } from "../utils/scheduler";

// The flow-log sweep's ledger pass: a settled delivery row goes once it is past the ledger's window
// (a DEAD one once it is past the flow log's too), a row still owed an attempt never does, and a
// backlog drains a batch per transaction over short passes.

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

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);

let tenantId = 0n;
let instanceId = 0n;
let otherTenantId = 0n;
let otherInstanceId = 0n;
let jobId = 0n;
const trig = `ledger_slow_${process.pid}`;

async function insertRow(p: {
  tenant: bigint;
  instance: bigint;
  deliveryId: string;
  status: "PENDING" | "PROCESSING" | "PROCESSED" | "DEAD";
  receivedAt: Date;
  processedAt: Date | null;
  event?: string;
}): Promise<bigint> {
  const [row] = await suDb.$queryRaw<{ id: bigint }[]>`
    INSERT INTO chatwoot_webhook_deliveries
      (tenant_id, chatwoot_instance_id, delivery_id, event, status, received_at, processed_at)
    VALUES (${p.tenant}, ${p.instance}, ${p.deliveryId}, ${p.event ?? "message_created"},
            ${p.status}::"InboundDeliveryStatus", ${p.receivedAt}, ${p.processedAt})
    RETURNING id`;
  return (row as { id: bigint }).id;
}

async function idsOf(tenant: bigint): Promise<string[]> {
  const rows = await suDb.chatwootWebhookDelivery.findMany({
    where: { tenantId: tenant },
    select: { deliveryId: true },
    orderBy: { deliveryId: "asc" },
  });
  return rows.map((r) => r.deliveryId);
}

async function sweepUntilDone(tenant: bigint, max = 200): Promise<number> {
  for (let i = 1; i <= max; i++) {
    const r = await sweepFlowlog(appDb, tenant, { pauseMs: 0 });
    if (r.done) return i;
  }
  throw new Error("sweep never finished");
}

describe.skipIf(!dbUp)("chatwoot delivery ledger retention", () => {
  beforeAll(async () => {
    jobId = await burnSchedulerJobId(suDb);
    tenantId = (
      await suDb.tenant.create({
        data: { name: "LedgerR", slug: `ledger-r-${process.pid}` },
      })
    ).id;
    instanceId = (await seedChatwootInstance(suDb, { tenantId, accountId: 71 }))
      .id;
    otherTenantId = (
      await suDb.tenant.create({
        data: { name: "LedgerR2", slug: `ledger-r2-${process.pid}` },
      })
    ).id;
    otherInstanceId = (
      await seedChatwootInstance(suDb, {
        tenantId: otherTenantId,
        accountId: 72,
      })
    ).id;
    registerFlowlogRetentionHandler();
  });

  // The scenarios below place a DEAD row between the ledger's window and the flow log's, so the flow
  // log's is pinned past the ledger's instead of read from whatever the environment sets.
  const configuredFlowlogDays = config.flowlog.retentionDays;

  beforeEach(async () => {
    config.flowlog.retentionDays = 30;
    forgetSweepBatchSizesForTest();
    setSweepOptionsForTest({});
    await suDb.chatwootWebhookDelivery.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await suDb.schedulerJob.deleteMany({
      where: {
        tenantId,
        kind: { in: ["TAKEOVER_RECOVERY", "HUMAN_REPLY_RECOVERY"] },
      },
    });
  });

  afterAll(async () => {
    config.flowlog.retentionDays = configuredFlowlogDays;
    setSweepOptionsForTest({});
    await suDb.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${trig} ON chatwoot_webhook_deliveries`,
    );
    await suDb.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${trig}()`);
    for (const t of [tenantId, otherTenantId]) {
      if (!t) continue;
      await suDb.schedulerJob.deleteMany({ where: { tenantId: t } });
      await clearFlowLog(suDb, { tenantId: t });
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("settled rows past the window go, rows inside it and rows still owed an attempt stay", async () => {
    // A DEAD row is kept as long as the flow log keeps the line that reports it, which here is longer
    // than the ledger's own window, so a DEAD row between the two is the one that tells them apart.
    const deadAge = config.flowlog.retentionDays * DAY;
    expect(deadAge).toBeGreaterThan(LEDGER_RETENTION_MS + 2 * DAY);
    const past = LEDGER_RETENTION_MS + DAY;
    const inside = LEDGER_RETENTION_MS - DAY;
    const rows = {
      processedPast: { status: "PROCESSED", r: past, p: past },
      processedInside: { status: "PROCESSED", r: inside, p: inside },
      processedNow: { status: "PROCESSED", r: 60_000, p: 30_000 },
      deadPastLedgerOnly: {
        status: "DEAD",
        r: deadAge - DAY,
        p: deadAge - DAY,
      },
      deadPastFlowLog: { status: "DEAD", r: deadAge + DAY, p: deadAge + DAY },
      // Settled just now after a long outage, by the sweep that also arms the row's recovery.
      processedSettledToday: { status: "PROCESSED", r: past, p: 60_000 },
      deadSettledToday: { status: "DEAD", r: deadAge + DAY, p: 60_000 },
      pendingAncient: { status: "PENDING", r: deadAge + DAY, p: null },
      processingAncient: { status: "PROCESSING", r: deadAge + DAY, p: null },
    } as const;
    for (const [name, v] of Object.entries(rows))
      await insertRow({
        tenant: tenantId,
        instance: instanceId,
        deliveryId: name,
        status: v.status,
        receivedAt: ago(v.r),
        processedAt: v.p === null ? null : ago(v.p),
      });
    await insertRow({
      tenant: otherTenantId,
      instance: otherInstanceId,
      deliveryId: "otherTenantPast",
      status: "PROCESSED",
      receivedAt: ago(past),
      processedAt: ago(past),
    });

    const r = await sweepFlowlog(appDb, tenantId, { pauseMs: 0 });
    expect(r.done).toBe(true);
    expect(await idsOf(tenantId)).toEqual(
      [
        "deadPastLedgerOnly",
        "deadSettledToday",
        "processedSettledToday",
        "pendingAncient",
        "processedInside",
        "processedNow",
        "processingAncient",
      ].sort(),
    );
    // The pass is the tenant's: another tenant's expired row waits for that tenant's own pass.
    expect(await idsOf(otherTenantId)).toEqual(["otherTenantPast"]);
    const kept = await suDb.chatwootWebhookDelivery.findMany({
      where: {
        tenantId,
        deliveryId: { in: ["pendingAncient", "processingAncient"] },
      },
      select: { status: true },
      orderBy: { deliveryId: "asc" },
    });
    expect(kept.map((k) => k.status)).toEqual(["PENDING", "PROCESSING"]);
  });

  test("a settled row whose takeover or reply recovery is still pending or claimed stays past every window", async () => {
    const old = config.flowlog.retentionDays * DAY + DAY;
    const ids: Record<string, bigint> = {};
    for (const [name, status] of [
      ["takeoverPending", "PROCESSED"],
      ["replyClaimed", "PROCESSED"],
      ["deadReplyPending", "DEAD"],
      ["takeoverDone", "PROCESSED"],
      ["replyFailed", "PROCESSED"],
      ["noJob", "PROCESSED"],
    ] as const)
      ids[name] = await insertRow({
        tenant: tenantId,
        instance: instanceId,
        deliveryId: name,
        status,
        receivedAt: ago(old),
        processedAt: ago(old),
      });
    const id = (name: string) => ids[name] as bigint;
    await armTakeoverRecovery(tenantId, id("takeoverPending"), appDb);
    await armHumanReplyRecovery(tenantId, id("replyClaimed"), appDb);
    await armHumanReplyRecovery(tenantId, id("deadReplyPending"), appDb);
    await armTakeoverRecovery(tenantId, id("takeoverDone"), appDb);
    await armHumanReplyRecovery(tenantId, id("replyFailed"), appDb);
    const settle = async (kind: string, name: string, status: string) =>
      suDb.$executeRawUnsafe(
        `UPDATE scheduler_jobs SET status = '${status}' WHERE tenant_id = ${tenantId} AND kind = '${kind}' AND payload->>'deliveryRowId' = '${id(name)}'`,
      );
    expect(
      await settle("HUMAN_REPLY_RECOVERY", "replyClaimed", "CLAIMED"),
    ).toBe(1);
    expect(await settle("TAKEOVER_RECOVERY", "takeoverDone", "DONE")).toBe(1);
    expect(await settle("HUMAN_REPLY_RECOVERY", "replyFailed", "FAILED")).toBe(
      1,
    );

    await sweepUntilDone(tenantId);
    expect(await idsOf(tenantId)).toEqual(
      ["deadReplyPending", "replyClaimed", "takeoverPending"].sort(),
    );

    // Once the recovery has run, the row is an ordinary settled one again.
    await settle("TAKEOVER_RECOVERY", "takeoverPending", "DONE");
    await sweepUntilDone(tenantId);
    expect(await idsOf(tenantId)).toEqual(
      ["deadReplyPending", "replyClaimed"].sort(),
    );
  });

  test("a Chatwoot retry of a delivery inside the window is still recognised after the pass", async () => {
    const deliveryId = `ledger-dedup-${process.pid}`;
    const rowId = await insertRow({
      tenant: tenantId,
      instance: instanceId,
      deliveryId,
      status: "PROCESSED",
      receivedAt: ago(LEDGER_RETENTION_MS - DAY),
      processedAt: ago(LEDGER_RETENTION_MS - DAY),
    });
    await insertRow({
      tenant: tenantId,
      instance: instanceId,
      deliveryId: "expired",
      status: "PROCESSED",
      receivedAt: ago(LEDGER_RETENTION_MS + DAY),
      processedAt: ago(LEDGER_RETENTION_MS + DAY),
    });
    await sweepFlowlog(appDb, tenantId, { pauseMs: 0 });
    expect(await idsOf(tenantId)).toEqual([deliveryId]);

    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 4401,
      private: false,
      content: "oi",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: {
        id: 4400,
        inbox_id: 9901,
        status: "open",
        contact_inbox: { id: 61_401 },
        meta: { sender: { id: 77, name: "Cliente" } },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("payload did not normalize");
    const outcome = await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId,
      deliveryId,
      agentBotId: 1,
      normalized: n,
      base: appDb,
    });
    expect(outcome).toBe("skipped");
    const after = await suDb.chatwootWebhookDelivery.findMany({
      where: { chatwootInstanceId: instanceId, deliveryId },
      select: { id: true, status: true },
    });
    expect(after).toEqual([{ id: rowId, status: "PROCESSED" }]);
  });

  test("a backlog drains over short passes, each batch committed on its own, and the sweep goes back to its daily rhythm", async () => {
    const total = 3_000;
    const batchRows = 500;
    await suDb.$executeRaw`
      INSERT INTO chatwoot_webhook_deliveries
        (tenant_id, chatwoot_instance_id, delivery_id, event, status, received_at, processed_at)
      SELECT ${tenantId}, ${instanceId}, 'old-' || g, 'message_created', 'PROCESSED',
             ${ago(LEDGER_RETENTION_MS + 3 * DAY)}, ${ago(LEDGER_RETENTION_MS + 3 * DAY)}
        FROM generate_series(1, ${total}) g`;
    await insertRow({
      tenant: tenantId,
      instance: instanceId,
      deliveryId: "inside",
      status: "PROCESSED",
      receivedAt: ago(DAY),
      processedAt: ago(DAY),
    });
    // Each delete statement of this tenant sleeps, so a pass fits two batches of the six.
    const sleepMs = 300;
    await suDb.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${trig}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF current_setting('app.tenant_id', true) = '${tenantId}' THEN
           PERFORM pg_sleep(${sleepMs / 1000});
         END IF;
         RETURN NULL;
       END $$`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER ${trig} AFTER DELETE ON chatwoot_webhook_deliveries
       FOR EACH STATEMENT EXECUTE FUNCTION ${trig}()`,
    );
    try {
      setSweepOptionsForTest({
        batchRows,
        targetBatchMs: 0,
        pauseMs: 0,
        passMs: Math.ceil(sleepMs * 1.5),
      });
      const handler = getJobHandler("FLOWLOG_SWEEP") as NonNullable<
        ReturnType<typeof getJobHandler>
      >;
      const job: ClaimedJob = {
        id: jobId,
        tenantId,
        kind: "FLOWLOG_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      };
      const left = async () =>
        (await idsOf(tenantId)).filter((d) => d.startsWith("old-")).length;
      const before = Date.now();
      const first = (await handler(job, appDb)) as JobResult;
      const afterFirst = await left();
      expect(afterFirst).toBeGreaterThan(0);
      expect(afterFirst).toBeLessThan(total);
      expect((total - afterFirst) % batchRows).toBe(0);
      expect(first.outcome).toBe("reschedule");
      if (first.outcome === "reschedule")
        expect(first.runAt.getTime()).toBeLessThan(
          before + SWEEP_CATCHUP_MS + 5_000,
        );
      let last = first;
      for (let i = 0; i < 20 && (await left()) > 0; i++)
        last = (await handler(job, appDb)) as JobResult;
      // The pass that finds nothing left is the one that goes back to the daily rhythm.
      last = (await handler(job, appDb)) as JobResult;
      expect(await left()).toBe(0);
      expect(await idsOf(tenantId)).toEqual(["inside"]);
      expect(last.outcome).toBe("reschedule");
      if (last.outcome === "reschedule")
        expect(last.runAt.getTime()).toBeGreaterThan(
          Date.now() + 23 * 3_600_000,
        );
    } finally {
      await suDb.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${trig} ON chatwoot_webhook_deliveries`,
      );
    }
  }, 60_000);

  test("a sweep over a tenant whose ledger is already within the window deletes nothing", async () => {
    await insertRow({
      tenant: tenantId,
      instance: instanceId,
      deliveryId: "recent",
      status: "PROCESSED",
      receivedAt: ago(DAY),
      processedAt: ago(DAY),
    });
    expect(await sweepUntilDone(tenantId)).toBe(1);
    expect(await sweepUntilDone(tenantId)).toBe(1);
    expect(await idsOf(tenantId)).toEqual(["recent"]);
  });

  test("a batch is a range over (tenant_id, received_at) under the tenant scope and under the fleet role", async () => {
    const sql = ledgerRetentionBatch(tenantId, 1000, ledgerRetentionCutoffs());
    const explain = Prisma.sql`EXPLAIN ${sql}`;
    const plans: string[] = [];
    // With sequential scans priced out, the plan shows whether the range CAN reach the index:
    // a predicate the RLS barrier holds back would leave the index usable only as a filter.
    const read = async (db: {
      $executeRaw: PrismaClient["$executeRaw"];
      $queryRaw: PrismaClient["$queryRaw"];
    }) => {
      await db.$executeRaw`SELECT set_config('enable_seqscan', 'off', true)`;
      const rows = await db.$queryRaw<{ "QUERY PLAN": string }[]>(explain);
      plans.push(rows.map((r) => r["QUERY PLAN"]).join("\n"));
    };
    await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      read,
    );
    await asSuperAdminOn(appDb, read);
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan).toContain(
        "chatwoot_webhook_deliveries_tenant_id_received_at_idx",
      );
      expect(plan).toMatch(/Index Cond: \(\(tenant_id = .*received_at </);
    }
  });
});
