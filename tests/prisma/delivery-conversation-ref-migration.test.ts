import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { seedChatwootInstance } from "../utils/chatwoot";

// Runs the ACTUAL migration file against the test database (issue #228).
//
// The promise this backfill carries is narrow and load-bearing: every delivery still non-terminal at
// upgrade time is abandoned by definition, and it must land in the DEAD list. Left behind, those
// rows keep both new id columns null — which is exactly what the sweep reads as "carried no
// message" — so each one would be closed as PROCESSED and never reported, on the population most
// likely to contain real losses.
//
// `chatwoot_webhook_deliveries` carries FORCE ROW LEVEL SECURITY, so `tenant_isolation` binds the
// table OWNER as well. A managed-Postgres admin role (RDS/Neon/Supabase) is typically owner WITHOUT
// rolsuper, and there the backfill matches zero rows and reports success. The negative twin below
// runs the file as the APP role with and without the `SET`, so the guard cannot be dropped without a
// red test. The repo-wide version of the same question is in ./migration-rls-bypass.test.ts.
//
// The file is executed from DISK on purpose: a copy pasted in here would drift, and Prisma's
// $executeRawUnsafe rejects multiple statements anyway, which would silently swallow the `SET`.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260825140100_delivery_conversation_ref/migration.sql";

let dbUp = false;
let sql = "";
let su: Client | undefined;
let prisma: PrismaClient | undefined;
if (suUrl && appUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await prisma.$queryRaw`SELECT 1`;
    sql = await Bun.file(MIGRATION).text();
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;
const db = prisma as PrismaClient;

// The columns already exist (the test DB was built by running every migration), so only the data
// half of the file is replayed. Splitting on the `SET` keeps the SET/UPDATE/RESET trio intact —
// that trio is what is under test.
function dataHalf(file: string): string {
  const i = file.indexOf("SET app.is_super_admin");
  if (i < 0) throw new Error("the migration no longer sets the RLS bypass");
  return file.slice(i);
}

const STATES = ["PENDING", "PROCESSING", "PROCESSED", "DEAD"] as const;
let tenantId = 0n;
let instanceId = 0n;
const ids: Record<string, bigint> = {};

async function statusOf(name: string): Promise<string> {
  const r = await suDb.query(
    'SELECT status FROM "chatwoot_webhook_deliveries" WHERE id = $1',
    [String(ids[name])],
  );
  return r.rows[0]?.status ?? "";
}

async function resetStates(): Promise<void> {
  for (const s of STATES) {
    await suDb.query(
      'UPDATE "chatwoot_webhook_deliveries" SET status = $1, processed_at = NULL WHERE id = $2',
      [s, String(ids[s])],
    );
  }
  await suDb.query(
    `UPDATE "chatwoot_webhook_deliveries" SET status = 'PENDING', processed_at = NULL, received_at = now() WHERE id = $1`,
    [String(ids.LIVE)],
  );
}

describe.skipIf(!dbUp)("migration: the stranded-delivery backfill", () => {
  beforeAll(async () => {
    const t = await db.tenant.create({
      data: { name: "DELBF", slug: `delbf-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(db, {
      tenantId,
      accountId: 93,
      baseUrl: "https://cw.example",
      adminToken: "enc",
    });
    instanceId = inst.id;
    for (const status of STATES) {
      const row = await db.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `bf-${process.pid}-${status}`,
          event: "message_created",
          status,
          // Old enough to be abandoned by the backfill's own definition. A row received seconds ago
          // is deliberately out of its reach — see the fence's own case below.
          receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
        select: { id: true },
      });
      ids[status] = row.id;
    }
    // And one the PREVIOUS release inserted while this migration ran: about to be claimed by it.
    const live = await db.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `bf-${process.pid}-LIVE`,
        event: "message_created",
        status: "PENDING",
      },
      select: { id: true },
    });
    ids.LIVE = live.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await suDb.end();
    await db.$disconnect();
  });

  test("closes every non-terminal row and touches nothing else", async () => {
    await resetStates();
    await suDb.query(dataHalf(sql));
    expect(await statusOf("PENDING")).toBe("DEAD");
    expect(await statusOf("PROCESSING")).toBe("DEAD");
    // A row that already finished is not a loss, and a row already reported as one stays reported.
    expect(await statusOf("PROCESSED")).toBe("PROCESSED");
    expect(await statusOf("DEAD")).toBe("DEAD");
    // And the fence that keeps the upgrade from eating a live message: this migration runs while the
    // PREVIOUS release is still serving, so a row it inserted seconds ago is about to be claimed by
    // it. Closed here, that `PENDING -> PROCESSING` CAS matches nothing, the delivery returns
    // "skipped", and a customer message is discarded by the upgrade itself.
    expect(await statusOf("LIVE")).toBe("PENDING");
  });

  // The two indexes, asked of the CATALOG. Their shape changes no result, so no behavioural test can
  // hold them — and both shapes are load-bearing for reasons a passing suite will never show:
  //
  //   * the sweep's is PARTIAL and TENANT-LEADING. Nothing prunes this ledger, so a full index over
  //     `status` would carry every delivery the install has ever handled, forever, and pay for it on
  //     every insert; and the sweep is one job per tenant, so a `status`-led index makes each pass
  //     walk the whole fleet's non-terminal range and let RLS discard the rest afterwards.
  //   * the retirement's leads with the ACCOUNT, because that is how the write is keyed: display ids
  //     and message ids are numbered per Chatwoot account.
  //
  // Prisma cannot express a partial index, so the first one is declared in raw SQL and deliberately
  // absent from schema.prisma — which is exactly why it needs a test of its own.
  test("ships the index shapes the sweep and the retirement are keyed for", async () => {
    const rows = await suDb.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'chatwoot_webhook_deliveries'",
    );
    const byName = new Map(rows.rows.map((r) => [r.indexname, r.indexdef]));

    const sweep = byName.get("chatwoot_webhook_deliveries_sweep_idx");
    expect(sweep).toBeDefined();
    expect(sweep).toContain("(tenant_id, received_at)");
    expect(sweep).toContain("WHERE");
    expect(sweep).toContain("PENDING");
    expect(sweep).toContain("PROCESSING");

    const retire = [...byName.values()].find((d) =>
      d.includes("(chatwoot_instance_id, conversation_id, inbound_message_id)"),
    );
    expect(retire).toBeDefined();
  });

  // The negative twin, run through the FILE rather than a copy of the UPDATE, so deleting the
  // `SET app.is_super_admin` line turns this red. FORCE RLS binds a non-superuser owner exactly like
  // any other role, which is what a managed-Postgres migration role usually is.
  describe("run by a NON-superuser role (managed Postgres)", () => {
    async function runAsApp(statements: string): Promise<void> {
      const app = new Client({ connectionString: appUrl });
      await app.connect();
      try {
        await app.query(statements);
      } finally {
        await app.end();
      }
    }

    test("without the bypass the backfill silently matches nothing", async () => {
      await resetStates();
      const withoutSet = dataHalf(sql)
        .split("\n")
        .filter((line) => !line.trim().startsWith("SET app.is_super_admin"))
        .join("\n");
      // No error, no warning: that is the whole problem.
      await runAsApp(withoutSet);
      expect(await statusOf("PENDING")).toBe("PENDING");
      expect(await statusOf("PROCESSING")).toBe("PROCESSING");
    });

    test("with the bypass, as shipped, it reaches the stranded rows", async () => {
      await resetStates();
      await runAsApp(dataHalf(sql));
      expect(await statusOf("PENDING")).toBe("DEAD");
      expect(await statusOf("PROCESSING")).toBe("DEAD");
      expect(await statusOf("PROCESSED")).toBe("PROCESSED");
    });
  });
});
