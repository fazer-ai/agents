import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { dbProbeFailed } from "@/tests/db-gate";
import { withDbName } from "@/tests/db-name";
import { until } from "@/tests/utils/poll";
import {
  ROLE_CATALOG_LOCK,
  withRoleCatalogLock,
} from "@/tests/utils/role-catalog-lock";

// Suites that write roles run on different databases (one per checkout, one per `--parallel`
// worker), and an advisory lock only excludes holders in the same database. Taken from any of them,
// the lock has to exclude a session on any other.
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
if (suUrl) {
  try {
    const c = new Client({ connectionString: suUrl });
    await c.connect();
    await c.end();
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

describe.skipIf(!dbUp)("the role catalog lock", () => {
  test("held from this run's database, a suite on another database waits for it", async () => {
    const elsewhere = withDbName(suUrl as string, "template1");
    const watcher = new Client({ connectionString: suUrl });
    await watcher.connect();
    let secondEntered = false;
    let second: Promise<void> | undefined;
    try {
      await withRoleCatalogLock(suUrl as string, async () => {
        second = withRoleCatalogLock(elsewhere, async () => {
          secondEntered = true;
        });
        await until("the second holder to wait on the lock", async () => {
          const { rows } = await watcher.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks
              WHERE locktype = 'advisory' AND objid = $1 AND NOT granted`,
            [ROLE_CATALOG_LOCK],
          );
          return (rows[0]?.n ?? 0) > 0;
        });
        expect(secondEntered).toBe(false);
      });
      await second;
      expect(secondEntered).toBe(true);
    } finally {
      await watcher.end();
    }
  });
});
