import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@/../generated/prisma/client";

// Watches Prisma transactions opened through one client. Survives `$extends`, which `runScopedOn`
// calls before `$transaction`. Three answers, and picking the wrong one is a flake:
// `heldHere`: is the CALLER inside a transaction now. Answered from the caller's own async context,
// because the client is shared with work this run did not start: `emitFlowEvent`'s fire-and-forget
// INSERT (`src/modules/flowlog/service.ts`) would be counted whenever it is still in flight.
// `open`: transactions in flight ANYWHERE through this client, a leak check, not about who asks.
// `total`: work SPLIT across transactions that should share one (a mutation and its audit row, where
// two means the record can be lost without the change).
export function countingBase(client: PrismaClient): {
  base: PrismaClient;
  heldHere: () => boolean;
  open: () => number;
  total: () => number;
} {
  let open = 0;
  let total = 0;
  // Entered for the length of the transaction, so only code running INSIDE it sees the mark. A
  // detached write started elsewhere has its own context and never sets this one.
  const inside = new AsyncLocalStorage<true>();
  // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
  const wrap = (target: any): any =>
    new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === "$extends") {
          return (...args: unknown[]) => wrap(t.$extends(...args));
        }
        if (prop === "$transaction") {
          return async (fn: unknown, ...rest: unknown[]) => {
            open += 1;
            total += 1;
            try {
              return await inside.run(true, () => t.$transaction(fn, ...rest));
            } finally {
              open -= 1;
            }
          };
        }
        return Reflect.get(t, prop, receiver);
      },
    });
  return {
    base: wrap(client) as PrismaClient,
    heldHere: () => inside.getStore() === true,
    open: () => open,
    total: () => total,
  };
}
