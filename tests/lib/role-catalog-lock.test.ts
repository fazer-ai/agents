import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { dbProbeFailed } from "@/tests/db-gate";
import { withDbName } from "@/tests/db-name";
import { until } from "@/tests/utils/poll";
import {
  holdRoleCatalogLock,
  ROLE_CATALOG_APP,
  ROLE_CATALOG_HOOK_MS,
  ROLE_CATALOG_LOCK,
  ROLE_CATALOG_WAIT_MS,
  withRoleCatalogLock,
} from "@/tests/utils/role-catalog-lock";
import { TEST_TIMEOUT_MS } from "@/tests/utils/timeouts";

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
  test(
    "held from this run's database, a suite on another database waits for it",
    async () => {
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
      // NOTE: both acquisitions may wait legitimately behind another worker's suite, each up to the wait.
    },
    ROLE_CATALOG_HOOK_MS + ROLE_CATALOG_WAIT_MS,
  );
});

// A WAIT WITH A DEADLINE, AND NOTHING LEFT BEHIND WHEN IT LAPSES. A hook that times out keeps running
// in the background, so a wait with no bound of its own takes the lock after its suite's teardown,
// with nobody left to release it, and every other suite waits on that session. The lapsed wait has to
// end on the server, closed, and say which lock it was.
describe.skipIf(!dbUp)("waiting on the role catalog lock", () => {
  test(
    "gives up at its deadline, names the lock, and leaves no session behind",
    async () => {
      const holder = new Client({
        connectionString: withDbName(suUrl as string, "postgres"),
      });
      await holder.connect();
      try {
        await holder.query(`SET lock_timeout = ${ROLE_CATALOG_WAIT_MS}`);
        await holder.query("SELECT pg_advisory_lock($1)", [ROLE_CATALOG_LOCK]);
        const holderPid = (
          await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]?.pid;
        // A name of its own, since another worker's suite may be waiting under the shared one.
        const app = `${ROLE_CATALOG_APP}-probe-${process.pid}`;
        const err = await holdRoleCatalogLock(suUrl as string, 300, app).catch(
          (e) => e,
        );
        expect((err as Error).message).toContain("role catalog lock");
        expect((err as Error).message).toContain(`pid ${holderPid} `);
        const left = await holder.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
          [app],
        );
        expect(left.rowCount).toBe(0);
      } finally {
        await holder.end();
      }
    },
    ROLE_CATALOG_HOOK_MS,
  );
});

// The longest legitimate hold is one test of db-bootstrap.test.ts, which the test timeout bounds, so a
// wait shorter than that fails a waiter that only had to be patient; and a hook that waits must
// outlast the wait, or it times out first and its wait goes on in the background.
test("a wait outlasts the longest hold, and a waiting hook outlasts the wait", () => {
  expect(ROLE_CATALOG_WAIT_MS).toBeGreaterThan(TEST_TIMEOUT_MS);
  expect(ROLE_CATALOG_HOOK_MS).toBeGreaterThan(ROLE_CATALOG_WAIT_MS);
});
