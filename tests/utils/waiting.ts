import { spyOn } from "bun:test";
import * as inflight from "@/graph/inflight";
import { until } from "./poll";

// WHETHER A PROMISE IS STILL WAITING, SEEN THROUGH THE WAIT'S OWN POLLS. A wait in src polls on a
// fixed interval and asks the same question on every pass, so counting those asks is the wait's own
// clock: `polls` more of them with the promise still pending is the wait itself, on any machine and
// under any load, where a race against a guessed duration only says the work had not finished yet.

/** Counts the calls to `ns[name]` that `matches` accepts, passing every call through unchanged. */
export function countCalls<
  NS extends object,
  K extends keyof NS & string,
  F extends NS[K] & ((...args: never[]) => unknown),
>(
  ns: NS,
  name: K,
  matches: (...args: Parameters<F>) => boolean = () => true,
): { count: () => number; restore: () => void } {
  const real = ns[name] as F;
  let calls = 0;
  const spy = spyOn(ns, name as never).mockImplementation(((
    ...args: Parameters<F>
  ) => {
    if (matches(...args)) calls += 1;
    return real(...args);
  }) as never);
  return { count: () => calls, restore: () => spy.mockRestore() };
}

/**
 * True when `pending` has not settled after `polls` more calls counted by `count`; false when it
 * settled first, which is a wait that did not happen.
 */
export async function pendingAcross(
  pending: Promise<unknown>,
  count: () => number,
  polls = 3,
): Promise<boolean> {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const from = count();
  await until(
    `${polls} polls of the wait, or the wait ending`,
    () => settled || count() >= from + polls,
  );
  return !settled;
}

/**
 * Whether `turn` is waiting for `graphThreadId` to clear. The wait asks `isTurnRunning` once per poll,
 * and a turn that does not wait asks at most twice (once in the wait, once taking the thread).
 */
export async function waitsForTheThread(
  turn: Promise<unknown>,
  graphThreadId: string,
): Promise<boolean> {
  const asks = countCalls(
    inflight,
    "isTurnRunning",
    (id: string) => id === graphThreadId,
  );
  try {
    return await pendingAcross(turn, asks.count);
  } finally {
    asks.restore();
  }
}
