import type { ScopedDb } from "@/lib/tenancy";

// Serialize work on a single logical entity (a conversation thread, a payment id, ...)
// using a Postgres transaction-scoped advisory lock. MUST run inside a runScoped/
// asSuperAdmin transaction (the lock auto-releases on commit/rollback). Concurrent calls
// with the same key on different connections block until the holder's tx ends.
//
// NOTE: hashtext maps the key to int4, so distinct keys can collide on the same lock
// slot. That only over-serializes (a correctness-safe, throughput-only cost); it never
// lets two holders of the same key run concurrently.
export async function withEntityLock<T>(
  db: ScopedDb,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
  return fn();
}

// Serialize async work on a single logical entity WITHIN this process. Concurrent calls with the
// same key run one after another in arrival order; different keys never wait on each other.
//
// Use this rather than withEntityLock above when the work is a network round-trip: that lock is
// transaction-scoped, so serializing an HTTP call with it would hold a DB transaction open across
// the wire. The concurrency this has to cover is one turn's tool calls, which LangGraph's ToolNode
// runs with Promise.all in a SINGLE process (see setContactCustomAttributes in
// src/modules/chatwoot/client.ts). A write racing in from another process is not covered.
const keyedChains = new Map<string, Promise<unknown>>();

export function withKeyedQueue<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = keyedChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  // The QUEUED link swallows the failure, so one rejected call does not reject everything behind it
  // in the queue; `run` itself still rejects, for the caller that owns it.
  const link = run.then(
    () => {},
    () => {},
  );
  keyedChains.set(key, link);
  void link.then(() => {
    // Only the tail clears the entry, so the map does not accumulate one promise per entity for the
    // lifetime of the process.
    if (keyedChains.get(key) === link) keyedChains.delete(key);
  });
  return run;
}

// The number of keys with work still queued. Exported for the test that pins the cleanup above.
export function queuedKeyCount(): number {
  return keyedChains.size;
}
