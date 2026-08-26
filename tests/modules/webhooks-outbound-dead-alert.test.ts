import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { createAlertChannel } from "@/modules/flowlog/channels";
import { processOutboundBatch } from "@/modules/webhooks/outbound/worker";
import { clearFlowLog } from "@/tests/utils/flowlog";

// ── A DEAD DELIVERY HAS TO SAY SO WHERE THE OPERATOR READS (issue #325) ──
// Integration, real DB, real RLS: the claim runs cross-tenant under asSuperAdmin and the outcome
// under the tenant scope, exactly as the worker does in production. Only the network and the SSRF
// guard are injectable, and the SSRF test uses the REAL guard because the URL it refuses is the
// second road to DEAD — the one that needs no retries at all.
//
// The effect asserted is the row an operator can see (`ExecutionLog`) and the alert it feeds
// (`AlertDelivery`), never the worker's own return value: the tick summary already counted these
// deaths before this issue, and counting is exactly what did not reach anybody.

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

const passthroughSafe = async (u: string) => new URL(u);
const never = (async () => {
  throw new Error("fetch must not be reached");
}) as unknown as typeof fetch;
const responds = (status: number) =>
  (async () => ({ status }) as Response) as unknown as typeof fetch;

// A secret-looking string in the payload, so a leak of the body into the log line is detectable
// rather than argued about.
const PAYLOAD_MARKER = "sk-live-PAYLOAD-MUST-NOT-LEAK-325";

let tenantId = 0n;
let liveSub = 0n;
let blockedSub = 0n;
let allStagesChannel = 0n;
let webhookOnlyChannel = 0n;
let otherStageChannel = 0n;

async function seedDelivery(
  subscriptionId: bigint,
  attempts: number,
): Promise<bigint> {
  const row = await suDb.outboundWebhookDelivery.create({
    data: {
      tenantId,
      subscriptionId,
      event: "conversion",
      payload: { value: 42, token: PAYLOAD_MARKER },
      status: "PENDING",
      attempts,
    },
  });
  return row.id;
}

// The emit is fire-and-forget, so the row lands after the worker returned. Poll for the expected
// count instead of sleeping a fixed amount: a fixed sleep is either flaky or slow, and this says
// which of the two it is when it fails.
async function webhookRows(expected: number, waitMs = 3000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // flowlog-scope: tenant-wide — the subject is HOW MANY lines the tick wrote, so scoping the
    // read to a turn would answer a different question and pass while a second row existed. The
    // tenant is this file's own and `clearRows` empties it before each case — through `clearFlowLog`,
    // which settles the scheduled writes first, or the emptying would not include the line the
    // previous case had scheduled and not yet written (issue #375).
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, stage: "webhook" },
      orderBy: { id: "asc" },
    });
    if (rows.length >= expected) return rows;
    if (Date.now() > deadline) return rows;
    await Bun.sleep(50);
  }
}

async function alertRows(expected: number, waitMs = 3000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const rows = await suDb.alertDelivery.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    });
    if (rows.length >= expected) return rows;
    if (Date.now() > deadline) return rows;
    await Bun.sleep(50);
  }
}

async function clearRows() {
  await clearFlowLog(suDb, { tenantId });
  await suDb.$executeRawUnsafe(
    `DELETE FROM alert_deliveries WHERE tenant_id = ${tenantId}`,
  );
}

describe.skipIf(!dbUp)("a dead outbound delivery reaches the operator", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "WHD", slug: `whd-${process.pid}` },
    });
    tenantId = t.id;
    liveSub = (
      await suDb.webhookSubscription.create({
        data: {
          tenantId,
          url: "https://example.com/receiver",
          events: ["conversion"],
          enabled: true,
        },
      })
    ).id;
    blockedSub = (
      await suDb.webhookSubscription.create({
        data: {
          tenantId,
          // Refused by the real SSRF guard (plain http), so it dies without a single attempt.
          url: "http://example.com/insecure",
          events: ["conversion"],
          enabled: true,
        },
      })
    ).id;
    allStagesChannel = (
      await suDb.alertChannel.create({
        data: {
          tenantId,
          name: "all",
          type: "webhook",
          url: "enc",
          enabled: true,
          minLevel: "error",
          stages: [],
        },
      })
    ).id;
    webhookOnlyChannel = (
      await suDb.alertChannel.create({
        data: {
          tenantId,
          name: "webhook-only",
          type: "webhook",
          url: "enc",
          enabled: true,
          minLevel: "error",
          stages: ["webhook"],
        },
      })
    ).id;
    otherStageChannel = (
      await suDb.alertChannel.create({
        data: {
          tenantId,
          name: "generate-only",
          type: "webhook",
          url: "enc",
          enabled: true,
          minLevel: "error",
          stages: ["generate"],
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const tbl of [
        "alert_deliveries",
        "alert_channels",
        "execution_logs",
        "outbound_webhook_deliveries",
        "webhook_subscriptions",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("attempts exhausted: the row names the subscription, the event and the last error", async () => {
    await clearRows();
    const id = await seedDelivery(liveSub, 7);
    const summary = await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl: responds(500),
      assertSafe: passthroughSafe,
    });
    expect(summary.dead).toBe(1);
    const rows = await webhookRows(1);
    expect(rows).toHaveLength(1);
    const row = rows[0] as (typeof rows)[number];
    expect(row.level).toBe("error");
    expect(row.status).toBe("error");
    expect(row.source).toBe("inbox");
    expect(row.conversationId).toBeNull();
    const detail = row.detail as Record<string, unknown>;
    expect(detail.deliveryId).toBe(String(id));
    expect(detail.subscriptionId).toBe(String(liveSub));
    expect(detail.event).toBe("conversion");
    expect(detail.attempts).toBe(8);
    expect(row.errorMessage).toContain("non-2xx response: 500");
  });

  test("a blocked URL dies on the first attempt, and says so too", async () => {
    await clearRows();
    const id = await seedDelivery(blockedSub, 0);
    const summary = await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl: never,
      assertSafe: assertSafeOutboundUrl,
    });
    expect(summary.dead).toBe(1);
    const rows = await webhookRows(1);
    expect(rows).toHaveLength(1);
    const row = rows[0] as (typeof rows)[number];
    expect(row.level).toBe("error");
    const detail = row.detail as Record<string, unknown>;
    expect(detail.deliveryId).toBe(String(id));
    // The whole point of this second road: no retry budget was spent, so an operator reading
    // `attempts` must not conclude the receiver was tried eight times.
    expect(detail.attempts).toBe(1);
    expect(row.errorMessage).toContain("Blocked outbound URL");
  });

  test("the delivery payload never reaches the log line", async () => {
    await clearRows();
    await seedDelivery(liveSub, 7);
    await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl: responds(500),
      assertSafe: passthroughSafe,
    });
    const rows = await webhookRows(1);
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0], (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(serialized).not.toContain(PAYLOAD_MARKER);
  });

  test("the alert reaches an all-stages channel and a channel that asked for this stage, and not one narrowed to another", async () => {
    await clearRows();
    await seedDelivery(liveSub, 7);
    await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl: responds(500),
      assertSafe: passthroughSafe,
    });
    const alerts = await alertRows(2);
    const byChannel = new Map(alerts.map((a) => [String(a.channelId), a]));
    expect(byChannel.has(String(allStagesChannel))).toBe(true);
    expect(byChannel.has(String(webhookOnlyChannel))).toBe(true);
    expect(byChannel.has(String(otherStageChannel))).toBe(false);
    const one = byChannel.get(String(allStagesChannel)) as NonNullable<
      ReturnType<typeof byChannel.get>
    >;
    expect(one.stage).toBe("webhook");
    expect(one.level).toBe("error");
    expect(one.summary).not.toContain(PAYLOAD_MARKER);
  });

  test("an operator can subscribe a channel to this stage by name", async () => {
    // The point of putting this in `FLOW_STAGES` rather than giving the worker its own path: the
    // vocabulary is what the channel picker offers and what `assertStages` accepts, so the operator
    // can ask for dead deliveries WITHOUT taking every other error with them. A stage the worker
    // owned privately could only ever reach a channel that had asked for everything.
    const ch = await createAlertChannel(
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      {
        name: `subscribable-${process.pid}`,
        type: "webhook",
        url: "https://example.com/alerts",
        minLevel: "error",
        stages: ["webhook"],
      },
      suDb,
    );
    expect(ch.stages).toEqual(["webhook"]);
    await suDb.alertChannel.delete({ where: { id: BigInt(ch.id) } });
  });

  test("negative control: a delivered delivery writes no line", async () => {
    await clearRows();
    await seedDelivery(liveSub, 0);
    const summary = await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl: responds(200),
      assertSafe: passthroughSafe,
    });
    expect(summary.delivered).toBe(1);
    expect(await webhookRows(0, 700)).toHaveLength(0);
  });

  test("negative control: a retried delivery writes no line — the budget is not spent yet", async () => {
    await clearRows();
    await seedDelivery(liveSub, 0);
    const summary = await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl: responds(503),
      assertSafe: passthroughSafe,
    });
    expect(summary.retried).toBe(1);
    expect(summary.dead).toBe(0);
    expect(await webhookRows(0, 700)).toHaveLength(0);
  });
});
