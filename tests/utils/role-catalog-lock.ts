import { Client } from "pg";
import { PROBE_DEADLINE_MS } from "../db-gate";
import { withDbName } from "../db-name";

// Roles and database grants live in CLUSTER-WIDE catalogs (pg_authid, pg_database), which Postgres
// does not serialize for concurrent DDL: two suites writing them at once hit `XX000: tuple
// concurrently updated`. Advisory locks are scoped to the database they are taken in, and each
// checkout, and each `--parallel` worker, has its own, so the lock is taken in `postgres`, the one
// database every run on the server shares.
export const ROLE_CATALOG_LOCK = 729104553;

// Takes the lock on a session of its own and hands back its release, for a suite that holds it from
// `beforeAll` to `afterAll`. Ending the session releases it, also if the run dies holding it.
export async function holdRoleCatalogLock(
  suUrl: string,
): Promise<() => Promise<void>> {
  const c = new Client({
    connectionString: withDbName(suUrl, "postgres"),
    connectionTimeoutMillis: PROBE_DEADLINE_MS,
  });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [ROLE_CATALOG_LOCK]);
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
