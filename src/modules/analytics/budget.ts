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

// 57014: a statement ran past what was left of the budget. 55P03: it waited on a lock past
// `DB_LOCK_TIMEOUT_MS`, which is the same answer for whoever is looking at the dashboard. P2028: no
// connection within the wait, or the transaction outlived its budget between statements.
export function isOverMetricsBudget(error: unknown): boolean {
  const code = postgresCodeOf(error);
  return (
    code === "57014" || code === "55P03" || isPrismaTransactionError(error)
  );
}

// A metrics read is several aggregates in one transaction, and `statement_timeout` restarts with each
// of them: a first query of 14 s and a second of 14 s under a 15 s budget held the connection 28 s.
// So each raw query first sets the time left until the transaction's deadline, which costs one round
// trip per aggregate and bounds the whole read at the budget. Only the raw queries: the reads here
// are aggregates, and a model call (the Langfuse link's vault read) keeps the per-statement bound.
function untilDeadline(db: ScopedDb, deadline: number): ScopedDb {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "$queryRaw" && prop !== "$queryRawUnsafe") return value;
      return async (...args: unknown[]) => {
        const left = Math.max(1, Math.ceil(deadline - Date.now()));
        await target.$executeRaw`SELECT set_config('statement_timeout', ${String(left)}, true)`;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export async function runMetricsScoped<T>(
  base: PrismaClient,
  ctx: TenantContext,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  const budget = metricsBudget();
  try {
    return await runScopedOn(
      base,
      ctx,
      (db) => fn(untilDeadline(db, Date.now() + budget.timeout)),
      budget,
    );
  } catch (error) {
    if (isOverMetricsBudget(error))
      throw new MetricsTooSlowError(budget.timeout);
    throw error;
  }
}
