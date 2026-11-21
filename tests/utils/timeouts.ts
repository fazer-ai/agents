import { jest } from "bun:test";

// The per-test (and per-hook) timeout tests/setup.ts sets for the whole suite. Kept here so the waits
// that must outlast it, or fit inside it, are derived from the same number (see
// tests/utils/role-catalog-lock.ts).
export const TEST_TIMEOUT_MS = 30_000;

// Set by scripts/bun-test.ts, which passes the deadline as `--timeout` to every file of its run.
export const TIMEOUT_ON_COMMAND_LINE = "TEST_TIMEOUT_ON_COMMAND_LINE";

// bun gives the preload's `jest.setTimeout` to the first file of a process only, so a file whose tests
// can outlast bun's 5 s default calls this at its top, for a bare `bun test` of several files. Under
// the launcher it does nothing: the command line already has the deadline, or a longer one asked for.
export function holdTestTimeout(): void {
  if (process.env[TIMEOUT_ON_COMMAND_LINE] !== "1")
    jest.setTimeout(TEST_TIMEOUT_MS);
}
