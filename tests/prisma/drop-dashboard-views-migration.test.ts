import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { dbProbeFailed } from "@/tests/db-gate";

// The dashboard's warm-up pass is gone, and the table it recorded openings in goes with it: a database
// that applied the table's migration ends without it, and one migrated from scratch never keeps it.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATIONS = "prisma/migrations";
const read = (dir: string) =>
  readFileSync(`${MIGRATIONS}/${dir}/migration.sql`, "utf8");

let dbUp = false;
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as Client;

async function exists(table: string): Promise<boolean> {
  const r = await suDb.query<{ t: string | null }>(
    "SELECT to_regclass(current_schema() || '.' || $1)::text AS t",
    [table],
  );
  return r.rows[0]?.t != null;
}

describe.skipIf(!dbUp)("migration: the warm-up pass's table", () => {
  test("a migrated database has no dashboard_views, and still has the kept days", async () => {
    expect(await exists("dashboard_views")).toBe(false);
    expect(await exists("dashboard_days")).toBe(true);
  });

  test("the drop removes a table the earlier migration created, and runs again on nothing", async () => {
    const CREATE = read("20261106190000_dashboard_views");
    const DROP = read("20261107200000_drop_dashboard_views");
    await suDb.query("BEGIN");
    try {
      await suDb.query(CREATE);
      expect(await exists("dashboard_views")).toBe(true);
      await suDb.query(DROP);
      expect(await exists("dashboard_views")).toBe(false);
      await suDb.query(DROP);
      expect(await exists("dashboard_views")).toBe(false);
    } finally {
      await suDb.query("ROLLBACK");
    }
  });
});
