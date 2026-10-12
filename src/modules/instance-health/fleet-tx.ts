import type { PrismaClient } from "@/../generated/prisma/client";
import { asSuperAdminOn, type ScopedDb, type TxBudget } from "@/lib/tenancy";

// The sampler's, evaluator's and worker's transactions, on the sampler's one connection. Bounded on
// their own and not by the app-wide `DB_TX_TIMEOUT_MS`: the transaction's budget is also its
// `statement_timeout`, so a larger global one would let a slow aggregate hold the only connection the
// instance alerts have, well past the client's own 10 s. The same bounds as that client
// (src/api/lib/prisma-instance-health.ts).
export const INSTANCE_HEALTH_TX_BUDGET: TxBudget = {
  maxWait: 5_000,
  timeout: 10_000,
};

export function asFleetForInstanceHealth<T>(
  base: PrismaClient,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return asSuperAdminOn(base, fn, INSTANCE_HEALTH_TX_BUDGET);
}
