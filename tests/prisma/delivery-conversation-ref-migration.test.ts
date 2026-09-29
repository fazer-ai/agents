import { describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";

// WHAT THE MIGRATION SHIPS, asked of the file and of the catalog. It carries no data statement, and
// that is under test too: `classifyStrandedDelivery` reads a legacy row by its EVENT NAME, sees
// `claimed_at` (a redelivered row versus an abandoned one) and writes the conversation-level line,
// none of which an UPDATE here could (proved in tests/modules/delivery-sweep.test.ts). What is left
// is DDL, invisible to every behavioural test: the FILE says what the statement says, the CATALOG
// what a database built from it holds.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260825140100_delivery_conversation_ref/migration.sql";

let dbUp = false;
let sql = "";
let su: Client | undefined;
let prisma: PrismaClient | undefined;
if (suUrl) {
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

describe.skipIf(!dbUp)("migration: the stranded-delivery columns", () => {
  test("writes no data statement: the sweep classifies what it finds", async () => {
    // NOTE: a statement here cannot read `claimed_at`, so a legacy `PENDING` row with an old receipt
    // but REDELIVERED a second ago (one instant from its `PENDING -> PROCESSING` CAS) would be closed,
    // the CAS would match nothing, and the upgrade would discard a live message Chatwoot never resends.
    // An age fence does not save that row: its receipt is old and only the claim says otherwise.
    expect(sql).not.toMatch(/^\s*UPDATE\s/im);
    expect(sql).not.toMatch(/^\s*DELETE\s/im);
    // And with no write, nothing here needs the RLS bypass. The repo-wide rule that every migration
    // writing to a FORCE-RLS table carries one is in ./migration-rls-bypass.test.ts; this asserts
    // the other direction, so re-adding a write without the bypass cannot pass quietly.
    expect(sql).not.toContain("app.is_super_admin");
  });

  test("builds both indexes CONCURRENTLY, and can be run again after one fails", async () => {
    // A plain CREATE INDEX holds SHARE for the whole build and blocks INSERT, while the previous
    // release is still writing this table after acking webhooks. Nothing prunes the ledger, so the
    // build time grows with the install's history. `migrate deploy` does not wrap a migration in a
    // transaction, so Postgres accepts CONCURRENTLY here.
    const creates = [
      ...sql.matchAll(/CREATE INDEX(\s+CONCURRENTLY)?\s+"([^"]+)"/g),
    ];
    expect(creates.length).toBeGreaterThan(0);
    for (const m of creates) {
      expect(m[1]?.trim()).toBe("CONCURRENTLY");
      // A concurrent build that fails leaves an INVALID index: never used for a query, still
      // maintained on every write, and a bare re-run collides with the name. The DROP is what makes
      // the file re-runnable, and it has to name the same index.
      expect(sql).toContain(`DROP INDEX IF EXISTS "${m[2]}";`);
    }
    // And the sweep's is PARTIAL, asked of the FILE for the same reason the name is: the catalog
    // below answers about the index an earlier `migrate deploy` built, not about this statement.
    // Nothing prunes this ledger, so a full index over `status` would carry every delivery the
    // install has ever handled, forever, and pay for it on every insert.
    expect(sql).toMatch(
      /CREATE INDEX CONCURRENTLY "chatwoot_webhook_deliveries_sweep_idx"[\s\S]*?WHERE status IN \('PENDING', 'PROCESSING'\);/,
    );
  });

  test("adds its columns idempotently, so a failed concurrent build can be re-run", async () => {
    // `migrate deploy` runs this file outside a transaction, so a failed concurrent build leaves
    // the columns already added. On the re-run, a bare ADD COLUMN would abort before the index DROPs,
    // blocking the recovery with the half of the file that had already succeeded.
    const adds = [
      ...sql.matchAll(/ADD COLUMN(\s+IF NOT EXISTS)?\s+"([^"]+)"/g),
    ];
    expect(adds.length).toBe(3);
    for (const m of adds) expect(m[1]?.trim()).toBe("IF NOT EXISTS");
  });

  test("names every index it creates short enough for Postgres to keep the name", async () => {
    // Read from the FILE: the database was built by an earlier `migrate deploy`, so it answers
    // about the index that exists, not the statement that would create one now. Postgres keeps the
    // FIRST 63 bytes of an identifier; Prisma truncates its implicit `@@index` name keeping `_idx`. Above
    // 63 they disagree, and every later `migrate dev` reports drift against a correct database.
    const names = [
      ...sql.matchAll(/CREATE INDEX(?:\s+CONCURRENTLY)?\s+"([^"]+)"/g),
    ].map((m) => m[1]);
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

  // NOTE: the two indexes, asked of the CATALOG; their shape changes no result, so no behavioural test holds:
  //   * the sweep's is PARTIAL (nothing prunes this ledger, so a full index grows forever and every
  //     insert pays for it) and TENANT-LEADING (the sweep is one job per tenant; a `status`-led index
  //     walks the whole fleet's range and lets RLS discard the rest).
  //   * the retirement's leads with the ACCOUNT: display and message ids are numbered per account.
  // Prisma cannot express a partial index, so the first is raw SQL, absent from schema.prisma.
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
    // And every one of them is VALID: a concurrent build that failed would leave one behind that no
    // query uses and every write maintains.
    const valid = await suDb.query<{ n: string; v: boolean }>(
      "SELECT i.relname AS n, x.indisvalid AS v FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid WHERE t.relname = $1",
      ["chatwoot_webhook_deliveries"],
    );
    expect(valid.rows.filter((r) => !r.v).map((r) => r.n)).toEqual([]);
  });

  test("adds the three columns the sweep reads, and no column for the payload", async () => {
    // The other half of the file. The sweep needs the delivery's identity and nothing about what the
    // customer wrote: no ciphertext column, no retention window, no second copy at rest.
    const cols = await suDb.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'chatwoot_webhook_deliveries'",
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain("conversation_id");
    expect(names).toContain("inbound_message_id");
    expect(names).toContain("claimed_at");
    for (const forbidden of ["payload", "body", "content", "message_text"]) {
      expect(names).not.toContain(forbidden);
    }
    await db.$disconnect();
    await suDb.end();
  });
});
