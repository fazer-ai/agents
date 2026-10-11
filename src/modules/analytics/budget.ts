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
// So every statement the read issues, raw or through a model, first sets the time left until the
// transaction's deadline: one round trip per aggregate, and the whole read bounded at the budget.
function untilDeadline(db: ScopedDb, deadline: number): ScopedDb {
  const bounded =
    (call: (...a: unknown[]) => unknown, self: unknown) =>
    async (...args: unknown[]) => {
      const left = Math.max(1, Math.ceil(deadline - Date.now()));
      await db.$executeRaw`SELECT set_config('statement_timeout', ${String(left)}, true)`;
      return call.apply(self, args);
    };
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return value;
      if (prop === "$queryRaw" || prop === "$queryRawUnsafe") {
        return bounded(value as (...a: unknown[]) => unknown, target);
      }
      // A model delegate (`db.llmUsage`): each of its operations is a statement.
      if (!prop.startsWith("$") && value && typeof value === "object") {
        return new Proxy(value, {
          get(delegate, op, r) {
            const fn = Reflect.get(delegate, op, r);
            return typeof fn === "function" ? bounded(fn, delegate) : fn;
          },
        });
      }
      return value;
    },
  });
}

export async function runMetricsScoped<T>(
  base: PrismaClient,
  ctx: TenantContext,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  const budget = metricsBudget();
  const started = Date.now();
  try {
    // The deadline starts with the transaction, so the scope's own statements (a SUPER_ADMIN's
    // tenant check) spend the same budget the aggregates do.
    let deadline = Number.POSITIVE_INFINITY;
    return await runScopedOn(
      base,
      ctx,
      (db) => fn(untilDeadline(db, deadline)),
      budget,
      () => {
        deadline = Date.now() + budget.timeout;
      },
    );
  } catch (error) {
    if (isOverMetricsBudget(error))
      throw new MetricsTooSlowError(Date.now() - started);
    throw error;
  }
}
