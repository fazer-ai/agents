import { describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";

// WHAT THE MIGRATION SHIPS, asked of the file and of the catalog (issue #228).
//
// It carries no data statement at all, and that is the decision under test as much as the shapes
// below are. An earlier version closed every pre-existing non-terminal row here, because those rows
// predate both id columns and the sweep could not read them. `classifyStrandedDelivery` asks the
// EVENT NAME first now, and `event` is a column every build has always written — so the sweep reads
// a legacy row as well as any UPDATE here could, and better in two ways: it can see `claimed_at`,
// which tells a redelivered row from an abandoned one, and it writes the conversation-level line
// that a blanket UPDATE could never fill in. tests/modules/delivery-sweep.test.ts is where that is
// proved, on rows carrying exactly the legacy shape.
//
// What is left is DDL, and DDL is invisible to every behavioural test in the suite: an index changes
// no result, and a name only matters the day Postgres shortens it. Both halves are read here — the
// FILE for what the statement says, the CATALOG for what a database built from it holds.

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
    // The rule, held against the FILE. A statement here cannot read `claimed_at`, so a legacy
    // `PENDING` row whose receipt is hours old but which was REDELIVERED a second ago — sitting one
    // instant from its `PENDING -> PROCESSING` CAS — would be closed by it, that CAS would match
    // nothing, and the upgrade itself would discard a live customer message Chatwoot never resends.
    // An age fence does not save that row: its receipt is old and only the claim says otherwise.
    expect(sql).not.toMatch(/^\s*UPDATE\s/im);
    expect(sql).not.toMatch(/^\s*DELETE\s/im);
    // And with no write, nothing here needs the RLS bypass. The repo-wide rule that every migration
    // writing to a FORCE-RLS table carries one is in ./migration-rls-bypass.test.ts; this asserts
    // the other direction, so re-adding a write without the bypass cannot pass quietly.
    expect(sql).not.toContain("app.is_super_admin");
  });

  test("builds both indexes CONCURRENTLY, and can be run again after one fails", async () => {
    // The lock, which is the only thing in this file about the UPGRADE rather than about the sweep.
    // A plain CREATE INDEX holds a SHARE lock for the whole build and blocks INSERT on the table it
    // indexes; this migration runs while the previous release is still acking webhooks and writing
    // this very table AFTER the 200 has gone out, on a bounded retry. Nothing prunes the ledger, so
    // the build time is bounded by the install's whole history.
    //
    // Measured: `prisma migrate deploy` in this repo does not wrap a migration in a transaction, so
    // Postgres accepts CONCURRENTLY — applied to a scratch database through the real command, both
    // indexes came out `indisvalid`.
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
    // The same property that lets the indexes be concurrent forces this one: `prisma migrate deploy`
    // does not wrap this migration in a transaction, so a concurrent build that is cancelled or
    // fails leaves the columns already added. Marked rolled back and run again, a bare ADD COLUMN
    // aborts on the first one and the index DROPs below it are never reached — the recovery path
    // blocked by the half of the file that had already succeeded.
    const adds = [
      ...sql.matchAll(/ADD COLUMN(\s+IF NOT EXISTS)?\s+"([^"]+)"/g),
    ];
    expect(adds.length).toBe(3);
    for (const m of adds) expect(m[1]?.trim()).toBe("IF NOT EXISTS");
  });

  test("names every index it creates short enough for Postgres to keep the name", async () => {
    // Read from the FILE, not the catalog. The test below asks the database what it has, and the
    // database was built by an earlier `migrate deploy` — so it answers about the index that exists,
    // not about the statement that would create one now.
    //
    // Postgres truncates an identifier to 63 bytes and keeps the FIRST 63; Prisma truncates its
    // implicit `@@index` name so the `_idx` suffix survives. The two disagree above 63, so an
    // implicit name creates an index whose name does not match schema.prisma and every later
    // `migrate dev` reports drift against a database that is actually correct.
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
    // customer wrote — no ciphertext column, no retention window, no second copy at rest.
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
