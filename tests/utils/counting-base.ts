import type { PrismaClient } from "@/../generated/prisma/client";

// Counts Prisma transactions currently open. Survives `$extends`, which `runScopedOn` calls before
// `$transaction`, so the count follows the client the scoped helper actually uses.
export function countingBase(client: PrismaClient): {
  base: PrismaClient;
  open: () => number;
} {
  let open = 0;
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
  return { base: wrap(client) as PrismaClient, open: () => open };
}
