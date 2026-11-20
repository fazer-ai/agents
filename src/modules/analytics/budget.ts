import type { PrismaClient } from "@/../generated/prisma/client";
import { requestSignal, requestStartedAt } from "@/api/lib/i18n";
import { noteMetricsRead } from "@/api/lib/metrics-reads";
import config from "@/config";
import { MetricsTooSlowError, ServiceUnavailableError } from "@/lib/errors";
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

// Nobody reads the answer: a 503 with no translation, since no one is there to see it.
function callerGone(): ServiceUnavailableError {
  return new ServiceUnavailableError(
    "The caller went away before the read began",
  );
}

export async function runMetricsScoped<T>(
  base: PrismaClient,
  ctx: TenantContext,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  const deadline = metricsDeadline();
  const signal = requestSignal();
  // What the read spent, for the request's log line: per attempt, the wait for a connection (until
  // the transaction is ready for the read's own statements) and the run of those statements. A retry
  // is a second attempt with its own wait.
  let waitMs = 0;
  let runMs = 0;
  // Spent before the read began: asking for a connection now could only hold one past the deadline.
  if (Date.now() >= deadline) {
    noteMetricsRead(0, 0);
    throw metricsTooSlow(deadline);
  }
  // A caller that went away (a console view left or replaced) while its request waited for a
  // connection gets nothing run for it: the connection goes straight back to the views still open.
  if (signal?.aborted) throw callerGone();
  const run = async (serial: boolean) => {
    const asked = Date.now();
    let began: number | null = null;
    try {
      return await runScopedOn(
        base,
        ctx,
        async (db) => {
          began = Date.now();
          waitMs += began - asked;
          if (signal?.aborted) throw callerGone();
          if (serial)
            await db.$executeRaw`SELECT set_config('max_parallel_workers_per_gather', '0', true)`;
          try {
            return await fn(db);
          } finally {
            runMs += Date.now() - began;
          }
        },
        metricsBudget(deadline),
      );
    } finally {
      if (began === null) waitMs += Date.now() - asked;
    }
  };
  try {
    try {
      return await run(false);
    } catch (error) {
      if (!isOutOfSharedMemory(error) || Date.now() >= deadline) throw error;
      // The reads are pure, so the same read runs again without parallel workers, which take no
      // shared memory segment (docs/dashboard.md, "How the console loads").
      return await run(true);
    }
  } catch (error) {
    if (isOverMetricsBudget(error)) throw metricsTooSlow(deadline);
    throw error;
  } finally {
    noteMetricsRead(waitMs, runMs);
  }
}

// 53100, "could not resize shared memory segment": parallel workers exchange rows through dynamic
// shared memory, which lives in /dev/shm, and Docker gives a container 64 MB of it unless its compose
// says otherwise. Three metrics reads with parallel hash joins at once can fill it.
export function isOutOfSharedMemory(error: unknown): boolean {
  return postgresCodeOf(error) === "53100";
}
