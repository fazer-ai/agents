import { spyOn } from "bun:test";
import * as modelLimit from "@/graph/model-limit";

// `runModelCall` rewrites every adapter failure into a word of its own ("provider error",
// "timeout"), so no adapter double can hand a guardrail an empty failure message through it. This
// lets the adapter's own rejection through untouched, for the tests that ask what a guardrail does
// with a failure whose message is empty. Restore it in the same test.
export function passRawModelFailures(): { mockRestore(): void } {
  return spyOn(modelLimit, "runModelCall").mockImplementation(((
    fn: (signal: AbortSignal) => Promise<unknown>,
  ) => fn(new AbortController().signal)) as never);
}

// The failures a provider adapter can raise with nothing to say: an Error with no message, and a
// rejection with an empty string.
export const EMPTY_FAILURES: readonly unknown[] = [new Error(), ""];
