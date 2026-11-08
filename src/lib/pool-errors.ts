import type { Pool, PoolClient } from "pg";
import logger from "@/api/lib/logger";
import { connectionErrorCode, isConnectionLoss } from "@/lib/connection-loss";

// A connection the server drops while nobody is using it has no query to fail: `pg` reports it as an
// `error` event, on the client and, when the client sits idle in a pool, again on the pool. An `error`
// event with no listener is thrown, and thrown from a socket callback it ends the process. A Postgres
// restart sends 57P01 to every connection at once, so one unguarded pool is enough for a 20s restart
// to become a crash loop. Every pool the app opens passes through `absorbPoolErrors`, which logs the
// drop and leaves the pool to open a new connection on its next use (`pg-pool` has already discarded
// the dead one). `biome-plugins/require-pool-error-listener.grit` refuses a pool built without it.

// A crash of another backend reaches a connection as a WARNING carrying 57P02, then a socket that
// closes with no error message: the code is only in the notice.
function logDrop(pool: string, err: unknown, notice?: string): void {
  const sqlstate = connectionErrorCode(err) ?? notice ?? "none";
  const message = err instanceof Error ? err.message : String(err);
  if (isConnectionLoss(err)) {
    logger.warn(
      { pool, sqlstate, message },
      "A database connection of the %s pool was dropped (%s); the pool opens a new one on its next use",
      pool,
      sqlstate,
    );
  } else {
    logger.error(
      { pool, sqlstate, err },
      "A database connection of the %s pool failed outside a query (%s); the pool opens a new one on its next use",
      pool,
      sqlstate,
    );
  }
}

// Returns the pool, so a construction site reads `absorbPoolErrors("name", new Pool(...))`.
// The listener goes on each CLIENT, at connect, and not only on the pool: a client checked out and
// idle between two statements of a transaction is out of the pool's hands, and its `error` has no
// other listener. The pool's own listener is there because `pg-pool` re-emits an idle client's error
// on the pool, where an empty listener list throws just the same; the client's listener logs it.
export function absorbPoolErrors<P extends Pool>(name: string, pool: P): P {
  pool.on("error", () => {});
  pool.on("connect", (client: PoolClient) => {
    let notice: string | undefined;
    client.on("notice", (n: { code?: unknown }) => {
      if (typeof n.code === "string" && n.code.startsWith("57P")) {
        notice = n.code;
      }
    });
    client.on("error", (err: unknown) => logDrop(name, err, notice));
  });
  return pool;
}
