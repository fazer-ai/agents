import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { asSuperAdminOn } from "@/lib/tenancy";
import { drainStrandsSql } from "@/modules/chatwoot/delivery-queue";
import { strandedSelectionSql } from "@/modules/chatwoot/delivery-sweep";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// The drain and the stranded-delivery sweep read the open rows of one tenant as the fleet, through the
// partial index of PENDING and PROCESSING rows. The planner uses that index only when it can prove the
// index's predicate from the query, which a status sent as a parameter cast to the enum never allows,
// so the read walked the primary key over every processed row. Catches a status that stopped being a
// literal, or a read that moved back under the tenant policy.
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

const PARTIAL = "chatwoot_webhook_deliveries_sweep_idx";
// Enough processed rows that walking them is the expensive plan, as it is in production, with about a
// third of them conversation events (the share measured in production), so the read-back half of the
// sweep's read is not planned against an empty population.
const PROCESSED_ROWS = 30_000;
const MINUTE = 60_000;
let tenantId = 0n;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function nodesOn(node: PlanNode, relation: string): PlanNode[] {
  const own = node["Relation Name"] === relation ? [node] : [];
  return [...own, ...(node.Plans ?? []).flatMap((p) => nodesOn(p, relation))];
}

async function readsOf(sql: Prisma.Sql): Promise<PlanNode[]> {
  const rows = await asSuperAdminOn(appDb, (db) =>
    db.$queryRaw<{ "QUERY PLAN": [{ Plan: PlanNode }] }[]>(
      Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`,
    ),
  );
  const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
  if (!plan) throw new Error("no plan");
  return nodesOn(plan, "chatwoot_webhook_deliveries");
}

describe.skipIf(!dbUp)(
  "the stranded-delivery reads reach the partial index of open rows",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Strands", slug: `strandsplan-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 17_300,
      });
      await suDb.$executeRaw`
        INSERT INTO chatwoot_webhook_deliveries
          (tenant_id, chatwoot_instance_id, delivery_id, event, status, payload,
           conversation_id, inbound_message_id, received_at)
        SELECT ${tenantId}, ${inst.id}, 'processed-' || g,
               CASE g % 3 WHEN 0 THEN 'conversation_updated' WHEN 1 THEN 'message_updated'
                          ELSE 'message_created' END,
               'PROCESSED', NULL,
               g, g, (now() - interval '2 hours') AT TIME ZONE 'UTC'
          FROM generate_series(1, ${PROCESSED_ROWS}) AS g`;
      await suDb.$executeRaw`
        INSERT INTO chatwoot_webhook_deliveries
          (tenant_id, chatwoot_instance_id, delivery_id, event, status, payload,
           conversation_id, inbound_message_id, received_at)
        SELECT ${tenantId}, ${inst.id}, 'strand-' || g, 'message_created', 'PENDING', NULL,
               g, g, (now() - interval '10 minutes') AT TIME ZONE 'UTC'
          FROM generate_series(1, 5) AS g`;
      await suDb.$executeRawUnsafe(
        "VACUUM ANALYZE chatwoot_webhook_deliveries",
      );
    });

    afterAll(async () => {
      await suDb.chatwootWebhookDelivery.deleteMany({ where: { tenantId } });
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_deployments WHERE tenant_id = ${tenantId}`,
      );
      await suDb.tenant.delete({ where: { id: tenantId } });
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("the drain's strands read", async () => {
      const now = Date.now();
      const reads = await readsOf(
        drainStrandsSql({
          tenantId,
          youngest: new Date(now - MINUTE),
          ceiling: new Date(now - 6 * 60 * MINUTE),
          held: [],
          batch: 500,
        }),
      );
      expect(reads.map((n) => n["Index Name"])).toEqual([PARTIAL]);
    });

    test("the stranded sweep's read, both halves", async () => {
      for (const readBack of [false, true]) {
        const reads = await readsOf(
          strandedSelectionSql({
            tenantId,
            cutoff: new Date(Date.now() - 5 * MINUTE),
            held: [],
            stateEvents: [
              "conversation_updated",
              "conversation_status_changed",
            ],
            readBack,
            batch: 500,
          }),
        );
        expect(reads.map((n) => n["Index Name"])).toEqual([PARTIAL]);
      }
    });
  },
);
