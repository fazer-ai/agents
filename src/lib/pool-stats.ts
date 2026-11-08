import { AsyncResource } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { currentDbScope, markedScope, scopeMarkIn } from "@/lib/db-scope";
import { noteStatementPool } from "@/lib/statement-budgets";
import { currentWorkLabel } from "@/lib/work-label";

// What each database pool is doing, for the instance health sampler (docs/logs.md, instance alerts):
// connections in use and idle, requests waiting for one and how long the oldest has waited, and the
// lock timeouts (SQLSTATE 55P03) its statements hit. `pg` keeps the counts but not when a waiter
// joined, so `connect` is wrapped to note it, for a request that joins the queue (every connection
// out and the pool at its size) and not one that is only opening a connection of its own; every statement reaches the server through a client
// that `connect` handed out (`pool.query` included), so wrapping those clients sees every 55P03.
// Per process, which is what the sampler is.

export const LOCK_TIMEOUT_SQLSTATE = "55P03";
export const STATEMENT_TIMEOUT_SQLSTATE = "57014";

const LOCK_WINDOW_MS = 60_000;
// Bounds the memory a lock storm can take; past it the per-minute count saturates, which still
// reads as far above any threshold.
const MAX_LOCK_EVENTS = 10_000;

interface Tracked {
  pool: Pool;
  // When each `connect` that joined the queue and is still waiting was asked, by ticket.
  waits: Map<number, number>;
  next: number;
}

// A statement that hit its `statement_timeout`, as this process sent it: the SQL text (parameters
// stay `$N`; the values are never kept), the work that ran it, and the scope its transaction was
// opened under (src/lib/db-scope.ts, entered by src/lib/tenancy/multi-tenant.ts): the tenant,
// whether it ran as the fleet role, and the budget. Read by the database screen (docs/logs.md,
// "Database"), which stores it and captures its plan under that same scope.
export interface StatementTimeoutEvent {
  at: number;
  sql: string;
  label: string | null;
  tenantId: string | null;
  fleet: boolean;
  budgetMs: number | null;
  // The instrumented pool it ran on ("main", "checkpointer", ...): the checkpointer can point at
  // another database, where the statement's relations do not exist.
  pool?: string;
}

interface Registry {
  pools: Map<string, Tracked>;
  lockTimeouts: number[];
  statementTimeouts: number[];
  // Waiting to be stored; bounded like the counts, oldest dropped first.
  pendingTimeouts: StatementTimeoutEvent[];
  lastTimeout: StatementTimeoutEvent | null;
}

const KEY = Symbol.for("fazerai.poolStats");
const WATCHED = Symbol.for("fazerai.poolStats.watched");
const MARKED = Symbol.for("fazerai.poolStats.marked");
const MAX_PENDING_TIMEOUTS = 500;

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  g[KEY] ??= {
    pools: new Map(),
    lockTimeouts: [],
    statementTimeouts: [],
    pendingTimeouts: [],
    lastTimeout: null,
  };
  // A registry built by an older copy of this module (a hot reload) lacks the newer fields.
  g[KEY].statementTimeouts ??= [];
  g[KEY].pendingTimeouts ??= [];
  g[KEY].lastTimeout ??= null;
  return g[KEY];
}

export function recordLockTimeout(now: number = Date.now()): void {
  const events = registry().lockTimeouts;
  events.push(now);
  if (events.length > MAX_LOCK_EVENTS) {
    events.splice(0, events.length - MAX_LOCK_EVENTS);
  }
}

// Lock timeouts in the last minute, across every pool.
export function lockTimeoutsPerMinute(now: number = Date.now()): number {
  const events = registry().lockTimeouts;
  const cutoff = now - LOCK_WINDOW_MS;
  let drop = 0;
  while (drop < events.length && (events[drop] as number) <= cutoff) drop++;
  if (drop > 0) events.splice(0, drop);
  return events.filter((t) => t <= now).length;
}

export function recordStatementTimeout(event: StatementTimeoutEvent): void {
  const r = registry();
  r.statementTimeouts.push(event.at);
  if (r.statementTimeouts.length > MAX_LOCK_EVENTS) {
    r.statementTimeouts.splice(0, r.statementTimeouts.length - MAX_LOCK_EVENTS);
  }
  r.pendingTimeouts.push(event);
  if (r.pendingTimeouts.length > MAX_PENDING_TIMEOUTS) {
    r.pendingTimeouts.splice(
      0,
      r.pendingTimeouts.length - MAX_PENDING_TIMEOUTS,
    );
  }
  r.lastTimeout = event;
}

// Statement timeouts in the last minute, across every pool.
export function statementTimeoutsPerMinute(now: number = Date.now()): number {
  const events = registry().statementTimeouts;
  const cutoff = now - LOCK_WINDOW_MS;
  let drop = 0;
  while (drop < events.length && (events[drop] as number) <= cutoff) drop++;
  if (drop > 0) events.splice(0, drop);
  return events.filter((t) => t <= now).length;
}

// The most recent one, for the alert's text; null once it is older than the signal's minute.
export function lastStatementTimeout(
  now: number = Date.now(),
): StatementTimeoutEvent | null {
  const last = registry().lastTimeout;
  return last && now - last.at <= LOCK_WINDOW_MS ? last : null;
}

// Hands over what is waiting to be stored, and forgets it.
// At most `max` of them, oldest first; the rest stay queued for the next call.
export function drainStatementTimeouts(
  max: number = Number.POSITIVE_INFINITY,
): StatementTimeoutEvent[] {
  const r = registry();
  return r.pendingTimeouts.splice(0, max);
}

// Puts back, ahead of what arrived since, the events a flush took and did not get to. Same cap as
// the queue: under a storm the oldest are the ones dropped.
export function requeueStatementTimeouts(
  events: StatementTimeoutEvent[],
): void {
  if (events.length === 0) return;
  const r = registry();
  r.pendingTimeouts = [...events, ...r.pendingTimeouts].slice(
    -MAX_PENDING_TIMEOUTS,
  );
}

// The text of a `client.query(...)` call, in either of pg's shapes: (text, values) or
// ({ text, values }).
function textOf(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const q = first as { text?: unknown };
    return typeof q.text === "string" ? q.text : null;
  }
  return null;
}

function noteError(
  err: unknown,
  statement: {
    text: string | null;
    label: string | null;
    scope: ReturnType<typeof currentDbScope>;
    pool: string;
  },
): void {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === LOCK_TIMEOUT_SQLSTATE) recordLockTimeout();
  else if (code === STATEMENT_TIMEOUT_SQLSTATE && statement.text) {
    recordStatementTimeout({
      at: Date.now(),
      sql: statement.text,
      label: statement.label,
      ...statement.scope,
      pool: statement.pool,
    });
  }
}

// The bound values of a `client.query(...)` call, in either of pg's shapes.
function valuesOf(args: unknown[]): unknown {
  const first = args[0];
  if (typeof first === "string") return args[1];
  return (first as { values?: unknown } | null)?.values;
}

// Watches a client's statements for 55P03 and 57014, once per client, without changing what the
// caller gets: the rejection still reaches it, and a callback still receives its error.
function watchClient(client: PoolClient, pool: string): void {
  const c = client as PoolClient & { [WATCHED]?: true; [MARKED]?: string };
  if (c[WATCHED]) return;
  c[WATCHED] = true;
  const query = c.query.bind(c) as (...args: unknown[]) => unknown;
  (c as unknown as { query: (...args: unknown[]) => unknown }).query = (
    ...args: unknown[]
  ) => {
    const text = textOf(args);
    if (text) noteStatementPool(pool, text);
    // A transaction's first statement carries the mark of the scope that opened it: from then on
    // this connection's statements are that transaction's, whatever async context Prisma sent them
    // from (src/lib/db-scope.ts, ScopeMark). Cleared when the connection goes back to the pool.
    const mark = scopeMarkIn(valuesOf(args));
    if (mark) c[MARKED] = mark;
    const bound = c[MARKED] ? markedScope(c[MARKED]) : null;
    // Otherwise read now, in the caller's context: the rejection settles on another continuation.
    const statement = {
      text,
      label: bound ? bound.label : currentWorkLabel(),
      scope: bound ? bound.scope : currentDbScope(),
      pool,
    };
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = (err: unknown, ...rest: unknown[]) => {
        if (err) noteError(err, statement);
        return (last as (...a: unknown[]) => unknown)(err, ...rest);
      };
      return query(...args);
    }
    const out = query(...args);
    if (out && typeof (out as Promise<unknown>).then === "function") {
      (out as Promise<unknown>).then(undefined, (err: unknown) =>
        noteError(err, statement),
      );
    }
    return out;
  };
}

// Registers a pool under `name` and returns it, so a construction site reads
// `instrumentPool("main", new Pool(...))`.
export function instrumentPool<P extends Pool>(name: string, pool: P): P {
  const tracked: Tracked = { pool, waits: new Map(), next: 0 };
  // A released connection belongs to no transaction any more: the next one marks it again.
  pool.on("release", (_err: unknown, client: PoolClient) => {
    delete (client as PoolClient & { [MARKED]?: string })[MARKED];
  });
  registry().pools.set(name, tracked);
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (
    ...args: unknown[]
  ) => {
    const ticket = tracked.next++;
    // The same test `pg` makes: a request joins its queue when a client is idle (checked out on the
    // next tick, so a burst can see the same idle client and queue behind it) or the pool is at its
    // size. Otherwise `pg` opens a new connection for it, which is setup and not a wait in the queue.
    const max =
      (pool as unknown as { options: { max?: number } }).options.max ?? 10;
    if (pool.idleCount > 0 || pool.totalCount >= max) {
      tracked.waits.set(ticket, Date.now());
    }
    const done = () => tracked.waits.delete(ticket);
    const cb = args[0];
    if (typeof cb === "function") {
      // Bound to the caller's async context: when the request waits in the queue, `pg` calls back
      // from whichever client released the connection, and `pool.query` (Prisma's path outside a
      // transaction) would read THAT work's label for its statement.
      return connect(
        AsyncResource.bind(
          (
            err: unknown,
            client: PoolClient | undefined,
            ...rest: unknown[]
          ) => {
            done();
            if (client) watchClient(client, name);
            return (cb as (...a: unknown[]) => unknown)(err, client, ...rest);
          },
        ),
      );
    }
    const out = connect() as Promise<PoolClient>;
    out.then((client) => {
      done();
      watchClient(client, name);
    }, done);
    return out;
  };
  return pool;
}

export interface PoolStat {
  name: string;
  inUse: number;
  idle: number;
  waiting: number;
  oldestWaitMs: number;
}

export function poolStats(now: number = Date.now()): PoolStat[] {
  return [...registry().pools.entries()].map(([name, t]) => {
    let oldest = Number.POSITIVE_INFINITY;
    for (const at of t.waits.values()) if (at < oldest) oldest = at;
    return {
      name,
      inUse: t.pool.totalCount - t.pool.idleCount,
      idle: t.pool.idleCount,
      waiting: t.pool.waitingCount,
      // A connect asked while a client was idle resolves at once; only one still out counts.
      oldestWaitMs:
        t.pool.waitingCount > 0 && Number.isFinite(oldest)
          ? Math.max(0, now - oldest)
          : 0,
    };
  });
}

// Test-only: drop one pool a test registered, and the lock timeouts counted so far. The app's own
// pools stay registered.
export function forgetPool(name: string): void {
  registry().pools.delete(name);
}

// Test-only: the pool registered under `name`, so a test can read what the app's own pools were
// built with.
export function registeredPool(name: string): Pool | undefined {
  return registry().pools.get(name)?.pool;
}

export function resetLockTimeouts(): void {
  registry().lockTimeouts = [];
}

// Test-only: forget the statement timeouts counted and waiting to be stored.
export function resetStatementTimeouts(): void {
  const r = registry();
  r.statementTimeouts = [];
  r.pendingTimeouts = [];
  r.lastTimeout = null;
}
