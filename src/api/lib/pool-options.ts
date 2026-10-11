import config from "@/config";

// `lock_timeout` for a pool's connections, sent by `pg` as a startup parameter so it holds for
// every statement, inside a transaction or not. Absent when `DB_LOCK_TIMEOUT_MS=0`, which leaves the
// server's own setting (0, no limit). Without it a statement queued behind a lock keeps its
// connection for as long as the holder keeps the lock: Prisma's transaction `timeout` is only
// checked once the statement returns.
export function lockTimeoutOption(): { lock_timeout?: number } {
  return config.dbLockTimeoutMs > 0
    ? { lock_timeout: config.dbLockTimeoutMs }
    : {};
}

// The metrics reads are a few large aggregates, and the JIT compiles each of them again on every
// request: on a month of a busy instance that compilation is most of a second per read, more than it
// saves. Off for this pool only, whatever the server's `jit`. `pg` lets an `options` in the URL
// replace this field, even an empty one, so one already there is kept and extended instead.
export function withJitOff(connectionString: string | undefined): {
  connectionString: string | undefined;
  options: string;
} {
  const url = connectionString
    ? // biome-ignore lint/plugin/require-parse-input: not caller input, the deploy's DATABASE_URL
      URL.parse(connectionString)
    : null;
  const own = url?.searchParams.get("options");
  const options = own ? `${own} -c jit=off` : "-c jit=off";
  if (!url || own === null || own === undefined)
    return { connectionString, options };
  url.searchParams.set("options", options);
  return { connectionString: url.toString(), options };
}

// The options of the metrics reads' own pool (./prisma-metrics.ts), used by src/modules/analytics,
// the console's metrics routes and the MCP metrics tools, and the authentication of those routes:
// one dashboard load fires about a dozen aggregates, and on the main pool (./prisma.ts) they took the
// connections turns and ingest need. Small on purpose, so a load queues here instead of running every
// aggregate at once. A query on it that does not open a transaction (the session or key lookup in
// front of a metrics route) waits for a connection, and then runs, no longer than a metrics request
// may. Kept apart from the client so a test that mocks ./prisma-metrics still reads these.
export function metricsPoolOptions(connectionString = config.databaseUrl) {
  return {
    ...withJitOff(connectionString),
    max: config.metrics.poolMax,
    connectionTimeoutMillis: config.metrics.timeoutMs,
    statement_timeout: config.metrics.timeoutMs,
    ...lockTimeoutOption(),
  };
}
