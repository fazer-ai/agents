// `bun test` with the suite's per-test deadline on the command line, the only place it reaches every
// file: bun applies the preload's `jest.setTimeout` to the first file of a process only and ignores a
// `timeout` in bunfig.toml. The number is the constant the preload sets. A `--timeout` among the
// arguments comes after it and wins, except in a file that sets its own (the first, through the
// preload, and the dashboard sums files).
//
// Usage: bun --no-env-file scripts/bun-test.ts [bun test arguments]
// (`--no-env-file` leaves the dotenv files to `bun test`, which honours its own flags for them.)
import { TEST_TIMEOUT_MS } from "../tests/utils/timeouts";

// `bun` from PATH, not this process's binary: a machine may put a queue in front of the real one.
const proc = Bun.spawn(
  ["bun", "test", "--timeout", String(TEST_TIMEOUT_MS), ...Bun.argv.slice(2)],
  { stdio: ["inherit", "inherit", "inherit"] },
);
// A signal sent to this process alone reaches the run too, so a `--watch` is not left behind.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => proc.kill(signal));
process.exitCode = await proc.exited;
