import type { PrismaClient } from "@/../generated/prisma/client";

// Counts Prisma transactions: `open` is how many are in flight right now, `total` how many were
// ever opened through this client. Survives `$extends`, which `runScopedOn` calls before
// `$transaction`, so the count follows the client the scoped helper actually uses.
//
// The two answer different questions. `open` catches a transaction held across an await that should
// not be; `total` catches work that was SPLIT across transactions which should have shared one — a
// mutation and the audit row recording it, say, where two means the record can be lost without the
// change being lost.
export function countingBase(client: PrismaClient): {
  base: PrismaClient;
  open: () => number;
  total: () => number;
} {
  let open = 0;
  let total = 0;
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
              return await t.$transaction(fn, ...rest);
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
    open: () => open,
    total: () => total,
  };
}
