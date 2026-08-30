import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@/../generated/prisma/client";

// Watches Prisma transactions opened through one client. Survives `$extends`, which `runScopedOn`
// calls before `$transaction`, so the watch follows the client the scoped helper actually uses.
//
// Three answers, and picking the wrong one is a flake rather than a wrong result:
//
// `heldHere` is for "is the CALLER inside a transaction right now" — a section that must not hold a
// connection across an await. It is answered from the caller's own async context, which is the only
// thing that makes it about the caller: the client is shared with work this run did not start and
// does not await. `emitFlowEvent` is exactly that (`src/modules/flowlog/service.ts`) — fire-and-
// forget by design, because a customer must not wait on a log line — and its transaction runs
// through this same client. Counting it made this assertion fail whenever that INSERT happened to
// still be in flight: measured on CI, and reproducible here with `PROBE_FLOWLOG_DELAY_MS=12`, which
// lands the write on top of the ask.
//
// `open` is the raw count of transactions in flight ANYWHERE through this client, which is a leak
// check ("it left nothing open behind it") and answers nothing about who is asking.
//
// `total` catches work that was SPLIT across transactions which should have shared one — a mutation
// and the audit row recording it, say, where two means the record can be lost without the change
// being lost.
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
