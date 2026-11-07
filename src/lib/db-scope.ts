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
  return scopeFields(current.getStore(), now);
}

function scopeFields(
  s: DbScope | undefined,
  now: number,
): { tenantId: string | null; fleet: boolean; budgetMs: number | null } {
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

// The scope and work label bound to one transaction's connection. Read at the driver, the async
// context is not the caller's: Prisma dispatches requests issued in the same tick together, from the
// first one's context, so two transactions sending at once would both read the first's. A helper
// that opens a transaction registers a mark, sends it as a bound value of its first statement, and
// the instrumented pool (src/lib/pool-stats.ts) binds that connection to it until it is released.
export interface ScopeMark {
  scope: DbScope;
  label: string | null;
}

const MARK_PREFIX = `dbscope:${process.pid}:`;
const KEY = Symbol.for("fazerai.dbScope.marks");

function marks(): { open: Map<string, ScopeMark>; next: number } {
  const g = globalThis as unknown as Record<
    symbol,
    { open: Map<string, ScopeMark>; next: number }
  >;
  g[KEY] ??= { open: new Map(), next: 0 };
  return g[KEY];
}

export function openScopeMark(mark: ScopeMark): string {
  const m = marks();
  const id = `${MARK_PREFIX}${m.next++}`;
  m.open.set(id, mark);
  return id;
}

export function closeScopeMark(id: string): void {
  marks().open.delete(id);
}

// How many marks are open: none once every transaction that opened one has ended.
export function openScopeMarkCount(): number {
  return marks().open.size;
}

// The mark a statement's bound values carry, if one of them is an open mark of this process.
export function scopeMarkIn(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  for (const v of values) {
    if (
      typeof v === "string" &&
      v.startsWith(MARK_PREFIX) &&
      marks().open.has(v)
    ) {
      return v;
    }
  }
  return null;
}

// What a statement on a connection bound to `id` is recorded under; null once the mark is closed.
export function markedScope(
  id: string,
  now: number = Date.now(),
): {
  label: string | null;
  scope: { tenantId: string | null; fleet: boolean; budgetMs: number | null };
} | null {
  const m = marks().open.get(id);
  return m ? { label: m.label, scope: scopeFields(m.scope, now) } : null;
}
