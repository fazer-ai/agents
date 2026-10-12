import config from "@/config";

// A transaction's `statement_timeout` is its budget, and the pool's `lock_timeout` is
// DB_LOCK_TIMEOUT_MS. When the lock timeout is not shorter (both 5 s by default), a statement stuck
// behind a row lock is cancelled by the statement timeout first, as 57014, and the lock wait is
// never named: the instance health signal that counts 55P03 stays at zero through a lock pile-up.
// So the transaction's lock timeout is brought just under its statement timeout. The statement fails
// at the same moment as before, with the code that says why. A disabled lock timeout (0) stays off.
const LOCK_MARGIN_MS = 250;

export function lockTimeoutUnder(statementTimeoutMs: number): number | null {
  const lock = config.dbLockTimeoutMs;
  if (lock <= 0 || lock < statementTimeoutMs) return null;
  return Math.max(1, statementTimeoutMs - LOCK_MARGIN_MS);
}
