import { AsyncLocalStorage } from "node:async_hooks";
import type { NoEffectReporter } from "./effect-free";

// One tool invocation, as the tools node runs it. A handler that refuses without doing what the call
// asked says so in two ways that both read, to the model, as an ordinary result: a report on the
// call's config (fence-report.ts) and the `onNoEffect` callback (effect-free.ts), which carries the
// tool's name and no call. The scope ties either one to the invocation it happened in, so the graph
// can keep the fact on that call's own result, whatever ids the batch carries.
const scope = new AsyncLocalStorage<{ didNothing: boolean }>();

// Runs one invocation and says whether the call was reported as having done nothing. `run` gets
// the invocation's own marker, for a report that names its call (the reporter on the call's config):
// that one is true wherever it fires, also from another call's context.
export async function inCallScope<T>(
  run: (didNothing: () => void) => Promise<T>,
): Promise<{ value: T; didNothing: boolean }> {
  const store = { didNothing: false };
  const value = await scope.run(store, () =>
    run(() => {
      store.didNothing = true;
    }),
  );
  return { value, didNothing: store.didNothing };
}

// Runs something as the invocation that asked for it. Taken inside a call and used later by
// whoever settles that call from elsewhere: calls written together are settled by the one that
// opened the write, in its context, and a report made there would land on the wrong result. Taken
// outside any invocation, what runs in it is heard by nobody.
export type AsCall = <T>(fn: () => T) => T;
export function asThisCall(): AsCall {
  const store = scope.getStore() ?? { didNothing: false };
  return (fn) => scope.run(store, fn);
}

// Called where a handler reports that the call did nothing. Outside an invocation it is a no-op.
function noteCallDidNothing(): void {
  const store = scope.getStore();
  if (store) store.didNothing = true;
}

// The `onNoEffect` callback handed to the tool sources, noted on the invocation before the caller's
// own counter hears it. Always a function: the reactive turn passes no callback, and its handlers
// still have to be heard.
export function scopedNoEffect(inner?: NoEffectReporter): NoEffectReporter {
  return (toolName) => {
    noteCallDidNothing();
    inner?.(toolName);
  };
}
