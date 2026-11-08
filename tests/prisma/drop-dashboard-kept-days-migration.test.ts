import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { dbProbeFailed } from "@/tests/db-gate";

// The dashboard computes its figures when asked (docs/dashboard.md, "How the console loads"): the
// kept days, their queue of late changes with every trigger that fed it, and the warm-up pass's table
// are gone. A database that applied their migrations ends without them, and the drops run again on
// nothing, in either order.

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

async function engineLeft(): Promise<number> {
  const r = await suDb.query<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE p.proname LIKE 'dashboard\\_dirty%')
          + (SELECT COUNT(*) FROM pg_proc WHERE proname LIKE 'dashboard\\_dirty%') AS n`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

describe.skipIf(!dbUp)(
  "migration: the kept days and the warm-up pass's table",
  () => {
    test("a migrated database has none of their tables, triggers or functions", async () => {
      expect(await exists("dashboard_views")).toBe(false);
      expect(await exists("dashboard_days")).toBe(false);
      expect(await exists("dashboard_dirty")).toBe(false);
      expect(await engineLeft()).toBe(0);
    });

    test("the kept-days drop runs on a database the views drop already reached, and again on nothing", async () => {
      const DROP = read("20261108010000_drop_dashboard_kept_days");
      await suDb.query("BEGIN");
      try {
        await suDb.query("CREATE TABLE dashboard_days (id int)");
        await suDb.query("CREATE TABLE dashboard_dirty (id int)");
        await suDb.query(
          "CREATE FUNCTION dashboard_dirty_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
        );
        await suDb.query(
          "CREATE TRIGGER dashboard_dirty_probe AFTER INSERT ON dashboard_days FOR EACH ROW EXECUTE FUNCTION dashboard_dirty_probe()",
        );
        // The migration file carries its own BEGIN and COMMIT, read here inside the test's transaction.
        const body = DROP.replace(/^\s*BEGIN;\s*$/m, "").replace(
          /^\s*COMMIT;\s*$/m,
          "",
        );
        await suDb.query(body);
        expect(await exists("dashboard_days")).toBe(false);
        expect(await exists("dashboard_dirty")).toBe(false);
        expect(await exists("dashboard_views")).toBe(false);
        expect(await engineLeft()).toBe(0);
        await suDb.query(body);
        expect(await engineLeft()).toBe(0);
      } finally {
        await suDb.query("ROLLBACK");
      }
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
  },
);
