import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { UsageSource } from "@/graph/usage-sources";
import { createAlertChannel } from "@/modules/flowlog/channels";
import { type FlowContext, writeFlowEvent } from "@/modules/flowlog/service";
import type { FlowStage } from "@/modules/flowlog/stages";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";

// Which sources page: the ones with real users on the other end. A client channel turn serves the
// host application's users as an inbox turn serves a customer, so its warning pages; the playground
// is the operator at the screen, so its warning is written and pages nobody. Each source writes a
// different stage, because deliveries coalesce on (channel, stage, level) and one shared stage would
// count every source as the same delivery.

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

const STAGE_OF: Record<UsageSource, FlowStage> = {
  inbox: "generate",
  playground: "tool",
  client: "split",
};

describe.skipIf(!dbUp)("which sources page an alert channel", () => {
  let tenantId = 0n;

  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "AlertSrc", slug: `alert-src-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const tbl of ["audit_logs", "alert_deliveries", "alert_channels"]) {
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

  test("inbox and client page, the playground is logged and pages nobody", async () => {
    await createAlertChannel(
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      {
        name: "ops",
        type: "discord",
        url: outboundUrl("/api/webhooks/1/alert-src"),
        minLevel: "warn",
      },
      appDb,
    );
    for (const source of ["inbox", "playground", "client"] as const) {
      const flow: FlowContext = {
        tenantId,
        turnId: `alert-src-${source}`,
        source,
        agentId: null,
        base: appDb,
      };
      await writeFlowEvent(flow, {
        stage: STAGE_OF[source],
        level: "warn",
        status: "ok",
      });
    }

    const paged = await suDb.alertDelivery.findMany({
      where: { tenantId },
      select: { stage: true },
    });
    expect(paged.map((d) => d.stage).sort()).toEqual(
      [STAGE_OF.inbox, STAGE_OF.client].sort(),
    );
    const logged = await flowLogRows(suDb, {
      where: {
        tenantId,
        turnId: {
          in: ["inbox", "playground", "client"].map(
            (src) => `alert-src-${src}`,
          ),
        },
      },
      select: { source: true },
    });
    expect(logged.map((r) => r.source).sort()).toEqual([
      "client",
      "inbox",
      "playground",
    ]);
  });
});
