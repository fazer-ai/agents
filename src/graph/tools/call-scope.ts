import { AsyncLocalStorage } from "node:async_hooks";
import type { NoEffectReporter } from "./effect-free";

// One tool invocation, as the tools node runs it. A handler that refuses without doing what the call
// asked says so in two ways that both read, to the model, as an ordinary result: a report on the
// call's config (fence-report.ts) and the `onNoEffect` callback (effect-free.ts), which carries the
// tool's name and no call. The scope ties either one to the invocation it happened in, so the graph
// can keep the fact on that call's own result, whatever ids the batch carries.
const scope = new AsyncLocalStorage<{ didNothing: boolean }>();

// Runs one invocation and says whether, inside it, the call was reported as having done nothing.
export async function inCallScope<T>(
  run: () => Promise<T>,
): Promise<{ value: T; didNothing: boolean }> {
  const store = { didNothing: false };
  const value = await scope.run(store, run);
  return { value, didNothing: store.didNothing };
}

// Called where a handler reports that the call did nothing. Outside an invocation it is a no-op.
export function noteCallDidNothing(): void {
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
