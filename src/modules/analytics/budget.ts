import type { PrismaClient } from "@/../generated/prisma/client";
import { requestStartedAt } from "@/api/lib/i18n";
import config from "@/config";
import { MetricsTooSlowError } from "@/lib/errors";
import { isPrismaTransactionError, postgresCodeOf } from "@/lib/pg-error";
import {
  DeadlinePassedError,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
  type TxBudget,
} from "@/lib/tenancy";

// Every metrics read runs here: on the client it is handed (the metrics pool, by default at each
// caller), and a request past its budget is refused as too slow instead of surfacing a 500. A long
// window is the usual cause, and the bound is what keeps one from holding a connection for half a
// minute (docs/dashboard.md).
//
// `METRICS_TIMEOUT_MS` is ONE budget per request, counted from the request's arrival: the session or
// key lookup in front of the route, the wait for a metrics connection and the run of every read share
// it. Outside a request (a test, a script) the budget starts when the read is called.
export function metricsDeadline(): number {
  return (requestStartedAt() ?? Date.now()) + config.metrics.timeoutMs;
}

export function metricsBudget(deadline: number = metricsDeadline()): TxBudget {
  const left = Math.max(1, Math.ceil(deadline - Date.now()));
  return { maxWait: left, timeout: left, deadline };
}

// The refusal for a request whose budget ran out at `deadline`, stating how long it actually ran.
export function metricsTooSlow(deadline: number): MetricsTooSlowError {
  return new MetricsTooSlowError(
    Date.now() - (deadline - config.metrics.timeoutMs),
  );
}

// 57014: a statement ran past what was left of the budget. 55P03: it waited on a lock past
// `DB_LOCK_TIMEOUT_MS`, which is the same answer for whoever is looking at the dashboard. P2028: no
// connection within the wait, or the transaction outlived its budget between statements.
// DeadlinePassedError: a statement asked for after the deadline, refused before it was sent.
export function isOverMetricsBudget(error: unknown): boolean {
  if (error instanceof DeadlinePassedError) return true;
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
  const deadline = metricsDeadline();
  // Spent before the read began: asking for a connection now could only hold one past the deadline.
  if (Date.now() >= deadline) throw metricsTooSlow(deadline);
  try {
    return await runScopedOn(base, ctx, fn, metricsBudget(deadline));
  } catch (error) {
    if (isOverMetricsBudget(error)) throw metricsTooSlow(deadline);
    throw error;
  }
}
