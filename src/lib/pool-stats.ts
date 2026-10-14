import type { Pool, PoolClient } from "pg";

// What each database pool is doing, for the instance health sampler (docs/logs.md, instance alerts):
// connections in use and idle, requests waiting for one and how long the oldest has waited, and the
// lock timeouts (SQLSTATE 55P03) its statements hit. `pg` keeps the counts but not when a waiter
// joined, so `connect` is wrapped to note it, for a request that joins the queue (every connection
// out and the pool at its size) and not one that is only opening a connection of its own; every statement reaches the server through a client
// that `connect` handed out (`pool.query` included), so wrapping those clients sees every 55P03.
// Per process, which is what the sampler is.

export const LOCK_TIMEOUT_SQLSTATE = "55P03";

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

interface Registry {
  pools: Map<string, Tracked>;
  lockTimeouts: number[];
}

const KEY = Symbol.for("fazerai.poolStats");
const WATCHED = Symbol.for("fazerai.poolStats.watched");

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  g[KEY] ??= { pools: new Map(), lockTimeouts: [] };
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

function noteError(err: unknown): void {
  if ((err as { code?: unknown } | null)?.code === LOCK_TIMEOUT_SQLSTATE) {
    recordLockTimeout();
  }
}

// Watches a client's statements for 55P03, once per client, without changing what the caller gets:
// the rejection still reaches it, and a callback still receives its error.
function watchClient(client: PoolClient): void {
  const c = client as PoolClient & { [WATCHED]?: true };
  if (c[WATCHED]) return;
  c[WATCHED] = true;
  const query = c.query.bind(c) as (...args: unknown[]) => unknown;
  (c as unknown as { query: (...args: unknown[]) => unknown }).query = (
    ...args: unknown[]
  ) => {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = (err: unknown, ...rest: unknown[]) => {
        if (err) noteError(err);
        return (last as (...a: unknown[]) => unknown)(err, ...rest);
      };
      return query(...args);
    }
    const out = query(...args);
    if (out && typeof (out as Promise<unknown>).then === "function") {
      (out as Promise<unknown>).then(undefined, noteError);
    }
    return out;
  };
}

// Registers a pool under `name` and returns it, so a construction site reads
// `instrumentPool("main", new Pool(...))`.
export function instrumentPool<P extends Pool>(name: string, pool: P): P {
  const tracked: Tracked = { pool, waits: new Map(), next: 0 };
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
      return connect(
        (err: unknown, client: PoolClient | undefined, ...rest: unknown[]) => {
          done();
          if (client) watchClient(client);
          return (cb as (...a: unknown[]) => unknown)(err, client, ...rest);
        },
      );
    }
    const out = connect() as Promise<PoolClient>;
    out.then((client) => {
      done();
      watchClient(client);
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
