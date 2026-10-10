/// <reference lib="dom" />

import { act } from "@testing-library/react";

// The answers a test's fake `fetch` has not delivered yet. A test that asserts something did NOT
// happen (a stale page that must not land) waits for the answers it released to be delivered and the
// component to finish with them, instead of sleeping for a guessed duration. An answer the test still
// holds never completes, so `settled` stops at the first turn of the loop in which nothing completed.
export function fetchTracker() {
  const inflight = new Set<Promise<unknown>>();
  let completed = 0;
  const turn = () => new Promise((r) => setTimeout(r, 0));
  return {
    // Takes what the fake answered, a promise or a plain value (a sync handler), as `fetch` would.
    track<T>(answer: T | Promise<T>): Promise<T> {
      const p = Promise.resolve(answer);
      inflight.add(p);
      void p
        .finally(() => {
          inflight.delete(p);
          completed += 1;
        })
        .catch(() => {});
      return p;
    },
    // Forgets what earlier tests left in flight.
    reset(): void {
      inflight.clear();
    },
    async settled(): Promise<void> {
      await act(async () => {
        for (;;) {
          const before = completed;
          // One turn so a released answer completes, and one so the component reads its body and
          // sets its state; a request that answer starts is tracked and waited on the next pass.
          await turn();
          await turn();
          if (completed === before) break;
        }
      });
    },
  };
}
