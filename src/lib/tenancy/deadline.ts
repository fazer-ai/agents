// A transaction whose budget is a deadline (TxBudget.deadline): `statement_timeout` restarts with each
// statement, so a first statement of 14 s and a second of 14 s under a 15 s budget hold the connection
// 28 s. Every statement issued through the returned client, raw or through a model, first sets the
// time left until the deadline: one round trip per statement, and the whole transaction bounded at it.
export function untilDeadline<D extends object>(db: D, deadline: number): D {
  const setLeft = (
    db as unknown as {
      $executeRaw: (
        s: TemplateStringsArray,
        ...v: unknown[]
      ) => Promise<number>;
    }
  ).$executeRaw.bind(db);
  const bounded =
    (call: (...a: unknown[]) => unknown, self: unknown) =>
    async (...args: unknown[]) => {
      const left = Math.max(1, Math.ceil(deadline - Date.now()));
      await setLeft`SELECT set_config('statement_timeout', ${String(left)}, true)`;
      return call.apply(self, args);
    };
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return value;
      if (prop === "$queryRaw" || prop === "$queryRawUnsafe") {
        return bounded(value as (...a: unknown[]) => unknown, target);
      }
      // A model delegate (`db.llmUsage`): each of its operations is a statement.
      if (!prop.startsWith("$") && value && typeof value === "object") {
        return new Proxy(value, {
          get(delegate, op, r) {
            const fn = Reflect.get(delegate, op, r);
            return typeof fn === "function"
              ? bounded(fn as (...a: unknown[]) => unknown, delegate)
              : fn;
          },
        });
      }
      return value;
    },
  });
}
