import type { PrismaClient } from "@/../generated/prisma/client";
import { currentPoolClass, type PoolClass } from "@/lib/pool-class";

// The client every module imports (./prisma.ts) is built with this. Each access resolves to the pool of the work running at that
// moment, so the about 130 modules that call `runScopedOn` with this client follow the class of the
// entry point that called them without being told. A transaction's own client (`tx`) is the one it
// was opened on, so a transaction never spans two pools. Its own module, not ./prisma.ts: a test
// that swaps ./prisma.ts for a stub (`mock.module`) would otherwise take this function with it for
// every later file of the same run.
export function routeByPoolClass(
  byClass: Record<PoolClass, PrismaClient>,
): PrismaClient {
  return new Proxy(byClass.main, {
    get(_target, prop) {
      const client = byClass[currentPoolClass()];
      const value = Reflect.get(client, prop, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}
