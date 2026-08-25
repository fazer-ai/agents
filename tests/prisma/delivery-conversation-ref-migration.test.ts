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

async function processedAtOf(name: string): Promise<string | null> {
  const r = await suDb.query(
    'SELECT processed_at FROM "chatwoot_webhook_deliveries" WHERE id = $1',
    [String(ids[name])],
  );
  return r.rows[0]?.processed_at ?? null;
}

// What the two already-terminal rows carried before the file ran, so a statement that widens its
// status list is caught restamping them.
const stamps: Record<string, string | null> = {};

async function resetStates(): Promise<void> {
  for (const s of STATES) {
    await suDb.query(
      'UPDATE "chatwoot_webhook_deliveries" SET status = $1, processed_at = NULL WHERE id = $2',
      [s, String(ids[s])],
    );
  }
  await suDb.query(
    `UPDATE "chatwoot_webhook_deliveries" SET status = 'PROCESSING', processed_at = NULL WHERE id = $1`,
    [String(ids.BENIGN)],
  );
  await suDb.query(
    `UPDATE "chatwoot_webhook_deliveries" SET status = 'PENDING', processed_at = NULL WHERE id = $1`,
    [String(ids.WRITEBACK)],
  );
  await suDb.query(
    `UPDATE "chatwoot_webhook_deliveries" SET status = 'PENDING', processed_at = NULL, received_at = now() WHERE id = $1`,
    [String(ids.LIVE)],
  );
  await suDb.query(
    `UPDATE "chatwoot_webhook_deliveries" SET status = 'PENDING', processed_at = NULL, received_at = now() WHERE id = $1`,
    [String(ids.LIVEBENIGN)],
  );
  await suDb.query(
    `UPDATE "chatwoot_webhook_deliveries" SET status = 'PROCESSED' WHERE id = $1`,
    [String(ids.DONEBENIGN)],
  );
  for (const s of ["PROCESSED", "DEAD", "DONEBENIGN"] as const) {
    await suDb.query(
      `UPDATE "chatwoot_webhook_deliveries" SET processed_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), String(ids[s])],
    );
    stamps[s] = await processedAtOf(s);
  }
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
    // A stranded event that could never have owed a customer a turn. `event` is not one of the
    // columns this migration adds — every build has always written it — so the backfill can read it,
    // and blanket-DEAD would put a conversation update in the list of unanswered customers.
    const benign = await db.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `bf-${process.pid}-BENIGN`,
        event: "conversation_updated",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    ids.BENIGN = benign.id;
    // Our own media write-back coming around: a message event, and still one no turn was ever owed
    // for. The rule is the event NAME, which is why this is separate from the one above.
    const writeback = await db.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `bf-${process.pid}-WRITEBACK`,
        event: "message_updated",
        status: "PENDING",
        receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    ids.WRITEBACK = writeback.id;
    // The live twin of the two above: a non-turn event the PREVIOUS release inserted seconds ago.
    // The age fence has to hold on BOTH statements — closed here, its own CAS matches nothing and
    // the mirror write that event carried never runs.
    const liveBenign = await db.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `bf-${process.pid}-LIVEBENIGN`,
        event: "conversation_updated",
        status: "PENDING",
      },
      select: { id: true },
    });
    ids.LIVEBENIGN = liveBenign.id;
    // A benign event that already FINISHED. Both statements carry the same status list, and each
    // one only ever sees its own half of the events — so a list widened on the benign statement is
    // invisible until a benign row is sitting in a terminal state to be restamped.
    const doneBenign = await db.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `bf-${process.pid}-DONEBENIGN`,
        event: "conversation_updated",
        status: "PROCESSED",
        receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    ids.DONEBENIGN = doneBenign.id;
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
    // And the terminal state is chosen, not blanket. Only a legacy `message_created` is ambiguous
    // enough to report: the id columns arrive with this migration and neither is backfilled, so a
    // `message_created` may or may not have carried an incoming message and DEAD is the conservative
    // reading. Everything else is closed — reported, they would arrive as a deploy-day pile of
    // "customer went unanswered" rows no customer was ever waiting on, in the one list whose value
    // is that every row in it is real.
    expect(await statusOf("BENIGN")).toBe("PROCESSED");
    expect(await statusOf("WRITEBACK")).toBe("PROCESSED");
    expect(await statusOf("LIVEBENIGN")).toBe("PENDING");
    // A row already terminal keeps the timestamp that recorded when it FINISHED. Two statements now
    // carry the same status list, and widening either to include a terminal state reads as a no-op
    // on `status` while quietly restamping when the work actually ended.
    expect(await processedAtOf("PROCESSED")).toEqual(stamps.PROCESSED ?? null);
    expect(await processedAtOf("DEAD")).toEqual(stamps.DEAD ?? null);
    expect(await statusOf("DONEBENIGN")).toBe("PROCESSED");
    expect(await processedAtOf("DONEBENIGN")).toEqual(
      stamps.DONEBENIGN ?? null,
    );
  });

  test("names every index it creates short enough for Postgres to keep the name", async () => {
    // Read from the FILE, not the catalog. The test below asks the database what it has, and the
    // database was built by an earlier `migrate deploy` — so it answers about the index that exists,
    // not about the statement that would create one now. This is the half that pins the statement.
    //
    // Postgres truncates an identifier to 63 bytes and keeps the FIRST 63; Prisma truncates its
    // implicit `@@index` name so the `_idx` suffix survives. The two disagree above 63, so an
    // implicit name creates an index whose name does not match schema.prisma and every later
    // `migrate dev` reports drift against a database that is actually correct.
    const names = [...sql.matchAll(/CREATE INDEX\s+"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(new TextEncoder().encode(name ?? "").length).toBeLessThanOrEqual(
        63,
      );
    }
    // And the one that needed the name says the same thing on both sides of the wall.
    const schema = await Bun.file("prisma/schema.prisma").text();
    expect(names).toContain("chatwoot_webhook_deliveries_retire_idx");
    expect(schema).toContain('map: "chatwoot_webhook_deliveries_retire_idx"');
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

    // Asked by NAME, because the name is the half that drifts. Prisma's implicit name for these
    // three columns is 87 bytes: Postgres keeps the first 63 and Prisma truncates so `_idx`
    // survives, so left implicit the created index and schema.prisma disagree and every later
    // `migrate dev` reports drift against a database that is actually correct.
    const retire = byName.get("chatwoot_webhook_deliveries_retire_idx");
    expect(retire).toBeDefined();
    expect(retire).toContain(
      "(chatwoot_instance_id, conversation_id, inbound_message_id)",
    );
    // The rule under that, rather than the one name: no index on this table may be long enough for
    // Postgres to rename it on the way in.
    for (const name of byName.keys()) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63);
    }
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
