import { AsyncLocalStorage } from "node:async_hooks";

// Which connection pool the work running now draws from (docs/deploy.md "Connection budget"). The
// main pool is the default and serves customer turns, the Chatwoot delivery path and the console;
// work that nobody is waiting on this second runs as "background", on a pool of its own
// (src/api/lib/prisma.ts), so a burst of it, or background transactions stuck behind a lock, cannot
// take the connections a customer reply needs. The class is decided where the work enters (a
// scheduler kind, a worker), never by the statement, and everything that work awaits inherits it.
export type PoolClass = "main" | "background";

const current = new AsyncLocalStorage<PoolClass>();

// Always run(), never enterWith(), so a class cannot leak to a sibling continuation.
export function runInPoolClass<T>(poolClass: PoolClass, fn: () => T): T {
  return current.run(poolClass, fn);
}

export function currentPoolClass(): PoolClass {
  return current.getStore() ?? "main";
}
