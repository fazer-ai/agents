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
