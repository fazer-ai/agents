import logger from "@/api/lib/logger";

// A transaction that NEVER STARTED: no free connection within `maxWait` (SCOPED_TX_OPTIONS), so
// Prisma gave up before running a statement. With the `pg` adapter that is code P2028, "Unable to
// start a transaction in the given time"; P2024 is the engine pool's version. Only this error is safe
// to run again: P2028 also covers a transaction that started and then expired, whose statements ran.
// The `cause` chain is followed, since a layer that wraps the error has not changed what happened.
export function isTransactionNeverStarted(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  const message = String((err as { message?: unknown }).message ?? "");
  if (code === "P2024") return true;
  if (code === "P2028" && message.includes("Unable to start a transaction"))
    return true;
  return isTransactionNeverStarted(
    (err as { cause?: unknown }).cause,
    depth + 1,
  );
}

export interface PoolRetryOptions {
  // Names the caller in the line each retry writes.
  label: string;
  // Total runs, the first included.
  attempts?: number;
  // The first backoff's ceiling; each later one doubles it. Full jitter: the wait is uniform in
  // [0, ceiling], so the callers a saturated pool refused together do not come back together.
  baseMs?: number;
  // No retry starts past this, measured from the first run. Each run can itself wait `maxWait` (2s)
  // for a connection, so the attempts alone do not bound the time.
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export const POOL_RETRY_ATTEMPTS = 4;
export const POOL_RETRY_BASE_MS = 250;
export const POOL_RETRY_DEADLINE_MS = 10_000;

// Runs `fn` again while it fails with a transaction that never started, bounded by attempts and a
// deadline. Every other error, and the last of these, is thrown as it came: the caller's own failure
// path still owns what happens next.
export async function retryWhileTransactionNeverStarted<T>(
  fn: () => Promise<T>,
  opts: PoolRetryOptions,
): Promise<T> {
  const attempts = opts.attempts ?? POOL_RETRY_ATTEMPTS;
  const baseMs = opts.baseMs ?? POOL_RETRY_BASE_MS;
  const deadlineMs = opts.deadlineMs ?? POOL_RETRY_DEADLINE_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransactionNeverStarted(err) || attempt >= attempts) throw err;
      const wait = Math.floor(random() * baseMs * 2 ** (attempt - 1));
      if (now() - startedAt + wait > deadlineMs) throw err;
      logger.warn(
        "%s: the database pool had no free connection (attempt %d of %d); retrying in %dms",
        opts.label,
        attempt,
        attempts,
        wait,
      );
      await sleep(wait);
    }
  }
}
