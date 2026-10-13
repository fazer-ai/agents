import type { Client as PgClient } from "pg";
import { Client } from "pg";
import { PROBE_DEADLINE_MS } from "../db-gate";
import { withDbName } from "../db-name";
import { TEST_TIMEOUT_MS } from "./timeouts";

// Roles and database grants live in CLUSTER-WIDE catalogs (pg_authid, pg_database), which Postgres
// does not serialize for concurrent DDL: two suites writing them at once hit `XX000: tuple
// concurrently updated`. Advisory locks are scoped to the database they are taken in, and each
// checkout, and each `--parallel` worker, has its own, so the lock is taken in `postgres`, the one
// database every run on the server shares.
export const ROLE_CATALOG_LOCK = 729104553;
export const ROLE_CATALOG_APP = "fazerai-role-catalog-lock";

// THE LONGEST ANY HOLDER KEEPS IT IS ONE TEST: db-bootstrap.test.ts takes it per test, bounded by the
// 30 s test timeout tests/setup.ts sets; everyone else holds it around a few statements. A wait is
// bounded above that, and a hook or test that waits gets a timeout above the wait, so a legitimate
// wait never outlasts its own hook. Without the bound, a hook that timed out keeps waiting in the
// background, takes the lock after its suite's teardown, and nobody releases it.
export const ROLE_CATALOG_WAIT_MS = TEST_TIMEOUT_MS + 15_000;
export const ROLE_CATALOG_HOOK_MS = ROLE_CATALOG_WAIT_MS + 15_000;

const LOCK_NOT_AVAILABLE = "55P03";

// Takes the lock on `client`, waiting at most `waitMs`. A lapsed wait names the lock and whoever holds
// it, and leaves the session's `lock_timeout` as it found it either way.
export async function acquireRoleCatalogLock(
  client: PgClient,
  waitMs: number = ROLE_CATALOG_WAIT_MS,
): Promise<void> {
  await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(waitMs))}`);
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ROLE_CATALOG_LOCK]);
  } catch (err) {
    if ((err as { code?: string }).code !== LOCK_NOT_AVAILABLE) throw err;
    const { rows } = await client
      .query<{ who: string }>(
        `SELECT format('pid %s (%s on %s: %s)', a.pid, a.usename, a.datname, left(a.query, 80)) AS who
           FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.objid = $1 AND l.granted`,
        [ROLE_CATALOG_LOCK],
      )
      .catch(() => ({ rows: [] as { who: string }[] }));
    throw new Error(
      `the role catalog lock (pg_advisory_lock(${ROLE_CATALOG_LOCK}) in "postgres") was not free within ${waitMs / 1000}s; held by ${rows.map((r) => r.who).join("; ") || "nobody listed"}`,
    );
  } finally {
    await client.query("RESET lock_timeout").catch(() => {});
  }
}

// Takes the lock on a session of its own and hands back its release. Ending the session releases it,
// also if the run dies holding it; a wait that lapses ends its session too, so it can never be
// granted after its caller has given up.
export async function holdRoleCatalogLock(
  suUrl: string,
  waitMs: number = ROLE_CATALOG_WAIT_MS,
  applicationName: string = ROLE_CATALOG_APP,
): Promise<() => Promise<void>> {
  const c = new Client({
    connectionString: withDbName(suUrl, "postgres"),
    connectionTimeoutMillis: PROBE_DEADLINE_MS,
    application_name: applicationName,
  });
  c.on("error", () => {});
  await c.connect();
  try {
    await acquireRoleCatalogLock(c, waitMs);
  } catch (err) {
    await c.end().catch(() => {});
    throw err;
  }
  return () => c.end().catch(() => {});
}

export async function withRoleCatalogLock<T>(
  suUrl: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await holdRoleCatalogLock(suUrl);
  try {
    return await fn();
  } finally {
    await release();
  }
}
