import { AsyncLocalStorage } from "node:async_hooks";

// The scope a database transaction runs under, as the code that opened it declared it: the tenant
// (`app.tenant_id`), whether it is the fleet role, and its budget. Entered by the tenancy helpers
// (src/lib/tenancy/multi-tenant.ts) and the checkpointer's sweep around the whole transaction, and
// read by src/lib/pool-stats.ts when a statement times out, so the record (and the plan the database
// screen captures for it, docs/logs.md "Database") names the scope it ran under. Declared by the
// caller, never parsed back out of the SQL the transaction sends.

export interface DbScope {
  tenantId: string | null;
  fleet: boolean;
  // The transaction's `statement_timeout`, in ms; null when it set none.
  timeoutMs: number | null;
  // With a deadline every statement gets only what is left of it (src/lib/tenancy/deadline.ts).
  deadline: number | null;
}

const current = new AsyncLocalStorage<DbScope>();

export function runInDbScope<T>(scope: DbScope, fn: () => T): T {
  return current.run(scope, fn);
}

// The scope of the statement being sent now, with the budget it was given: what is left of the
// deadline at this instant, or the transaction's timeout.
export function currentDbScope(now: number = Date.now()): {
  tenantId: string | null;
  fleet: boolean;
  budgetMs: number | null;
} {
  const s = current.getStore();
  if (!s) return { tenantId: null, fleet: false, budgetMs: null };
  const left =
    s.deadline === null ? null : Math.max(1, Math.ceil(s.deadline - now));
  const budgetMs =
    left === null
      ? s.timeoutMs
      : s.timeoutMs === null
        ? left
        : Math.min(left, s.timeoutMs);
  return { tenantId: s.tenantId, fleet: s.fleet, budgetMs };
}
