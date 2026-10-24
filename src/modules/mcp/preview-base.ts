import type { PrismaClient } from "@/../generated/prisma/client";

// A write previews by running the SAME service call inside a transaction that is rolled back at the
// end, so the preview refuses exactly what the apply would and shows what the apply would leave. Used
// by the dashboard tools and the occurrence monitor tools.

class PreviewRollback {
  constructor(readonly result: unknown) {}
}

// A client whose transactions never commit: the work runs to the end, its result is captured, and the
// transaction is rolled back by the throw. Only `$extends(...).$transaction` is wrapped, which is the
// one path `runScopedOn` takes.
export function previewBase(base: PrismaClient): PrismaClient {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== "$extends") return Reflect.get(target, prop, receiver);
      return (...ext: unknown[]) => {
        const extended = (
          target.$extends as unknown as (...a: unknown[]) => PrismaClient
        )(...ext);
        return new Proxy(extended, {
          get(t, p, r) {
            if (p !== "$transaction") return Reflect.get(t, p, r);
            return async (
              fn: (tx: unknown) => Promise<unknown>,
              opts?: unknown,
            ) => {
              try {
                await (
                  t.$transaction as unknown as (
                    f: (tx: unknown) => Promise<unknown>,
                    o?: unknown,
                  ) => Promise<unknown>
                )(async (tx) => {
                  throw new PreviewRollback(await fn(tx));
                }, opts);
              } catch (e) {
                if (e instanceof PreviewRollback) return e.result;
                throw e;
              }
              throw new Error("preview transaction committed");
            };
          },
        });
      };
    },
  });
}
