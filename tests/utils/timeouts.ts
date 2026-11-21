import { jest } from "bun:test";

// The per-test (and per-hook) timeout tests/setup.ts sets for the whole suite. Kept here so the waits
// that must outlast it, or fit inside it, are derived from the same number (see
// tests/utils/role-catalog-lock.ts).
export const TEST_TIMEOUT_MS = 30_000;

// Set by scripts/bun-test.ts on the run it starts, which has the deadline as `--timeout` on its command
// line. Read once, when the preload first loads this file, and taken out of the environment, so a
// `bun test` a test starts in turn, which inherits the environment and not the arguments, is not
// taken for one the launcher started.
export const TIMEOUT_ON_COMMAND_LINE = "TEST_TIMEOUT_ON_COMMAND_LINE";
const launched = process.env[TIMEOUT_ON_COMMAND_LINE] === "1";
delete process.env[TIMEOUT_ON_COMMAND_LINE];

// bun gives the preload's `jest.setTimeout` to the first file of a process only, so a file whose tests
// can outlast bun's 5 s default calls this at its top, for a bare `bun test` of several files. In a run
// the launcher started it does nothing: the command line has the deadline, or a longer one asked for.
export function holdTestTimeout(onCommandLine = launched): void {
  if (!onCommandLine) jest.setTimeout(TEST_TIMEOUT_MS);
}
