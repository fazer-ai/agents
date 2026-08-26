import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// WHAT THE MIGRATION SHIPS, and the half a behavioural test cannot reach (issue #356).
//
// The column is DDL, invisible to every test in the suite that does not name it. The data statement
// beside it is not: it decides what happens to claims that are RUNNING while the migration executes,
// and `docs/deploy.md` supports a rolling deploy (`migrate deploy` as a pre-deploy step) over a
// scaled web tier — so the previous version is serving inbound webhooks at that moment and its
// claims carry no stamp. Read as stale, one of them could be taken by a duplicate delivery mid-turn,
// or have its last attempt marked terminally FAILED under the invocation still working on it.
//
// Both halves are read here: the FILE for what the statement says, the CATALOG for what a database
// built from it holds.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260826200000_inbound_delivery_claimed_at/migration.sql";

let dbUp = false;
let sql = "";
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    sql = await Bun.file(MIGRATION).text();
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;

describe.skipIf(!dbUp)("migration: the inbound claim clock", () => {
  // The connection is opened at module load, so it outlives a `describe` that never runs and it is
  // not the suite's to leak either way: an open TCP handle can keep `bun test` alive after the last
  // assertion.
  afterAll(async () => {
    await su?.end();
  });

  test("fences the claims that were running when it ran", async () => {
    const statements = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    // The whole point, held against the file: a stamp, on exactly the rows a claim could be live
    // on. `now()` and not a backfill from `received_at`, which cannot answer this — a fifth attempt
    // is claimed hours after receipt, so a row claimed one second ago carries an ancient receipt.
    expect(statements).toMatch(
      /UPDATE\s+"inbound_deliveries"\s+SET\s+"claimed_at"\s*=\s*now\(\)\s+WHERE\s+"status"\s*=\s*'PROCESSING'/i,
    );
    expect(statements).not.toMatch(/"claimed_at"\s*=\s*"?received_at"?/i);
  });

  test("the column lands nullable, so no existing row is refused", async () => {
    const { rows } = await suDb.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'inbound_deliveries' AND column_name = 'claimed_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("YES");
    // No default: a row is stamped by the claim that takes it, never by existing.
    expect(rows[0].column_default).toBeNull();
    expect(String(rows[0].data_type)).toContain("timestamp");
  });

  test("a PENDING row is left alone: it has no claim to fence", async () => {
    // The statement is scoped to PROCESSING, and the scope is the decision. Stamping a PENDING row
    // would give it a claim it never had, and the claim path reads that column.
    const statements = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/'PENDING'/);
  });
});
