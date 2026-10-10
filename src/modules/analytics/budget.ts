import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { MetricsTooSlowError } from "@/lib/errors";
import { isPrismaTransactionError, postgresCodeOf } from "@/lib/pg-error";
import {
  runScopedOn,
  type ScopedDb,
  type TenantContext,
  type TxBudget,
} from "@/lib/tenancy";

// Every metrics read runs here: on the client it is handed (the metrics pool, by default at each
// caller), under `METRICS_TIMEOUT_MS` for the wait and for the run, and a request past that budget is
// refused as too slow instead of surfacing a 500. A long window is the usual cause, and the bound is
// what keeps one from holding a connection for half a minute (docs/dashboard.md).
export function metricsBudget(): TxBudget {
  return {
    maxWait: config.metrics.timeoutMs,
    timeout: config.metrics.timeoutMs,
  };
}

// 57014: the statement ran past the budget. 55P03: it waited on a lock past `DB_LOCK_TIMEOUT_MS`,
// which is the same answer for whoever is looking at the dashboard. P2028: no connection within the
// wait, or the transaction outlived its budget between statements.
export function isOverMetricsBudget(error: unknown): boolean {
  const code = postgresCodeOf(error);
  return (
    code === "57014" || code === "55P03" || isPrismaTransactionError(error)
  );
}

export async function runMetricsScoped<T>(
  base: PrismaClient,
  ctx: TenantContext,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  const budget = metricsBudget();
  try {
    return await runScopedOn(base, ctx, fn, budget);
  } catch (error) {
    if (isOverMetricsBudget(error))
      throw new MetricsTooSlowError(budget.timeout);
    throw error;
  }
}
