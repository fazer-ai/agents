// `bun test` with the suite's per-test deadline on the command line. bun applies the preload's
// `jest.setTimeout` (tests/setup.ts) to the first test file of a process only, and a `timeout` under
// `[test]` in bunfig.toml is ignored, so every later file of a multi-file run got bun's 5 s default.
// Only `--timeout` reaches every file. The number is the constant the preload sets, and a `--timeout`
// among the arguments comes after it and wins.
//
// Usage: bun --no-env-file scripts/bun-test.ts [bun test arguments]
// (`--no-env-file` leaves the dotenv files to `bun test`, which then honours its own flags for them.)
import {
  TEST_TIMEOUT_MS,
  TIMEOUT_ON_COMMAND_LINE,
} from "../tests/utils/timeouts";

// `bun` from PATH, not this process's binary: a machine may put a queue in front of the real one.
const proc = Bun.spawn(
  ["bun", "test", "--timeout", String(TEST_TIMEOUT_MS), ...Bun.argv.slice(2)],
  {
    env: { ...process.env, [TIMEOUT_ON_COMMAND_LINE]: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  },
);
// A signal sent to this process alone reaches the run too, so a `--watch` is not left behind.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => proc.kill(signal));
process.exitCode = await proc.exited;
