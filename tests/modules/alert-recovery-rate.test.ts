import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import { alertLinks } from "@/modules/flowlog/alert-send";
import { recoverySubjectOf } from "@/modules/flowlog/alerts";
import {
  type FlowContext,
  type FlowEvent,
  writeFlowEvent,
} from "@/modules/flowlog/service";
import { outboundUrl } from "../utils/outbound";

// A RECOVERY THAT ENDED WELL IS A RATE, NOT A PAGE. On a healthy day a stranded delivery is rare, and
// when it shows up it means deliveries are being stranded; after an incident the backlog drains for
// hours and every recovery paging on its own buries the alert that means a customer is waiting. So a
// quiet recovery (`recovered`, `consumed_late`, an `answered_late` that was not late enough to look
// at) pages nobody alone and counts toward one aggregated alert per window.

const THRESHOLD = config.alertWorker.recoveryThreshold;
const WINDOW_MS = config.alertWorker.recoveryWindowMs;
const LATE_MS = config.alertWorker.lateReplyAgeMs;

const line = (
  outcome: string,
  over: { level?: FlowEvent["level"]; detail?: Record<string, unknown> } = {},
): FlowEvent => ({
  stage: "delivery",
  level: over.level ?? "warn",
  status: "ok",
  detail: { outcome, deliveryEvent: "message_created", ...over.detail },
});

describe("recoverySubjectOf", () => {
  test("the quiet recoveries count", () => {
    expect(recoverySubjectOf(line("recovered"))).toBe(true);
    expect(recoverySubjectOf(line("consumed_late"))).toBe(true);
    expect(
      recoverySubjectOf(line("answered_late", { detail: { ageMs: LATE_MS } })),
    ).toBe(true);
  });

  test("a late answer past the age, the losses and other stages do not", () => {
    expect(
      recoverySubjectOf(
        line("answered_late", { detail: { ageMs: LATE_MS + 1 } }),
      ),
    ).toBe(false);
    expect(recoverySubjectOf({ ...line("unanswered"), level: "error" })).toBe(
      false,
    );
    expect(recoverySubjectOf(line("memory_unrecovered"))).toBe(false);
    // The stranded line the sweep and a live turn write is the loss itself, not a recovery.
    expect(
      recoverySubjectOf({
        stage: "delivery",
        level: "info",
        status: "error",
        detail: { strandedOn: "PROCESSING" },
      }),
    ).toBe(false);
    expect(recoverySubjectOf({ ...line("recovered"), stage: "tool" })).toBe(
      false,
    );
  });
});

test("the recovery alert links to its list as recoveries, not failures", () => {
  const [link] = alertLinks({
    type: "discord",
    stage: "delivery",
    level: "warn",
    summary: "x",
    count: 1,
    tenantId: 1n,
    turnId: "t",
    conversationId: 9n,
    causeKey: "rate:delivery:recovered",
  });
  expect(link?.label).toBe("View recoveries");
  expect(link?.url).toContain("/logs?stage=delivery");
});

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

const tenants: bigint[] = [];
let seq = 0;

async function freshTenant(): Promise<bigint> {
  const t = await suDb.tenant.create({
    data: { name: "Recovery1134", slug: `rec-1134-${process.pid}-${seq++}` },
  });
  tenants.push(t.id);
  return t.id;
}

// A channel that takes warnings, so a per-delivery alert would land on it if one were raised.
async function channel(
  tenantId: bigint,
  minLevel: "warn" | "error" = "warn",
): Promise<bigint> {
  const ch = await suDb.alertChannel.create({
    data: {
      tenantId,
      name: `ch-${seq++}`,
      type: "discord",
      url: encryptJson(outboundUrl(`/api/webhooks/rec-${seq}`)),
      minLevel,
      stages: [],
      excludeAgentIds: [],
    },
  });
  return ch.id;
}

const flow = (tenantId: bigint, over: Partial<FlowContext> = {}) => ({
  tenantId,
  turnId: crypto.randomUUID(),
  source: "inbox" as const,
  base: appDb,
  ...over,
});

async function recover(tenantId: bigint, outcomes: string[]) {
  for (const o of outcomes) await writeFlowEvent(flow(tenantId), line(o));
}

// Recoveries already in the log, written minutes ago, as the count reads them.
async function pastRecoveries(tenantId: bigint, minutesAgo: number[]) {
  for (const m of minutesAgo) {
    await suDb.executionLog.create({
      data: {
        tenantId,
        turnId: crypto.randomUUID(),
        stage: "delivery",
        level: "warn",
        status: "ok",
        source: "inbox",
        detail: { outcome: "recovered" },
        createdAt: new Date(Date.now() - m * 60_000),
      },
    });
  }
}

async function deliveries(channelId: bigint) {
  return suDb.alertDelivery.findMany({
    where: { channelId },
    orderBy: { id: "asc" },
    select: { causeKey: true, level: true, summary: true, count: true },
  });
}

const minutes = Math.max(1, Math.round(WINDOW_MS / 60_000));
const aggregated = (n: number) =>
  `[delivery] ${n} stranded deliveries were recovered in ${minutes} min`;

const quiet = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? "recovered" : "consumed_late",
  );

describe.skipIf(!dbUp)("recovery rate alerts", () => {
  afterAll(async () => {
    for (const id of tenants) {
      for (const tbl of [
        "alert_deliveries",
        "alert_channels",
        "execution_logs",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${id}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("below the threshold, recoveries page nobody", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await recover(tenantId, quiet(THRESHOLD - 1));
    expect(await deliveries(ch)).toEqual([]);
  });

  test("at the threshold, one aggregated alert, and no per-delivery one", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await recover(tenantId, quiet(THRESHOLD));
    const rows = await deliveries(ch);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.causeKey).toBe("rate:delivery:recovered");
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.summary).toBe(aggregated(THRESHOLD));
  });

  test("more in the same window are counted on it, not sent again", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await recover(tenantId, quiet(THRESHOLD + 4));
    const rows = await deliveries(ch);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(5);
  });

  test("recoveries older than the window do not add up", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    const outside = minutes + 1;
    await pastRecoveries(
      tenantId,
      Array.from({ length: THRESHOLD }, () => outside),
    );
    await recover(tenantId, quiet(THRESHOLD - 1));
    expect(await deliveries(ch)).toEqual([]);
    await recover(tenantId, quiet(1));
    expect((await deliveries(ch)).map((r) => r.summary)).toEqual([
      aggregated(THRESHOLD),
    ]);
  });

  test("only delivery lines count toward it", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    // A line of another stage that happens to carry the same outcome word, inside the window.
    await suDb.executionLog.create({
      data: {
        tenantId,
        turnId: crypto.randomUUID(),
        stage: "tool",
        level: "warn",
        status: "ok",
        source: "inbox",
        detail: { outcome: "recovered" },
      },
    });
    await recover(tenantId, quiet(THRESHOLD - 1));
    expect(await deliveries(ch)).toEqual([]);
  });

  test("a loss still pages on its own, below the threshold", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await writeFlowEvent(flow(tenantId), {
      ...line("unanswered"),
      level: "error",
      status: "error",
    });
    await writeFlowEvent(flow(tenantId), line("memory_unrecovered"));
    const rows = await deliveries(ch);
    expect(rows.map((r) => r.summary)).toEqual([
      "[delivery] error: unanswered",
      "[delivery] ok: memory_unrecovered",
    ]);
  });

  test("an answer later than the age pages on its own; one at the age does not", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await writeFlowEvent(
      flow(tenantId),
      line("answered_late", { detail: { ageMs: LATE_MS } }),
    );
    expect(await deliveries(ch)).toEqual([]);
    await writeFlowEvent(
      flow(tenantId),
      line("answered_late", { detail: { ageMs: LATE_MS + 60_000 } }),
    );
    expect((await deliveries(ch)).map((r) => r.summary)).toEqual([
      "[delivery] ok: answered_late",
    ]);
  });

  test("a late answer reaches an error-only channel, and a run of them is one alert", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId, "error");
    for (let i = 0; i < 2; i++) {
      await writeFlowEvent(
        flow(tenantId),
        line("answered_late", { detail: { ageMs: LATE_MS + 60_000 } }),
      );
    }
    const rows = await deliveries(ch);
    expect(rows.map((r) => [r.causeKey, r.summary, r.count])).toEqual([
      ["delivery:late_answer", "[delivery] ok: answered_late", 2],
    ]);
  });

  test("late answers are not counted toward the recovery rate", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    for (let i = 0; i < THRESHOLD; i++) {
      await writeFlowEvent(
        flow(tenantId),
        line("answered_late", { detail: { ageMs: LATE_MS + 60_000 } }),
      );
    }
    await recover(tenantId, quiet(THRESHOLD - 1));
    expect(
      (await deliveries(ch)).filter(
        (r) => r.causeKey === "rate:delivery:recovered",
      ),
    ).toEqual([]);
  });

  test("a late answer written without an age counts toward the recovery rate", async () => {
    // Lines written before the sweep stated the age carry none, and they are quiet recoveries.
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await recover(tenantId, Array(THRESHOLD).fill("answered_late"));
    expect((await deliveries(ch)).map((r) => [r.causeKey, r.summary])).toEqual([
      ["rate:delivery:recovered", aggregated(THRESHOLD)],
    ]);
  });

  test("the playground does not count", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    for (let i = 0; i < THRESHOLD; i++) {
      await writeFlowEvent(
        flow(tenantId, { source: "playground" }),
        line("recovered"),
      );
    }
    // One real recovery after them: the playground's lines are not counted toward it either.
    await recover(tenantId, quiet(1));
    expect(await deliveries(ch)).toEqual([]);
  });
});
