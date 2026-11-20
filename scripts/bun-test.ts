// `bun test` with the suite's per-test deadline on the command line. bun applies the preload's
// `jest.setTimeout` (tests/setup.ts) to the first test file of a process only, and a `timeout` under
// `[test]` in bunfig.toml is ignored, so every later file of a multi-file run got bun's 5 s default.
// Only `--timeout` reaches every file. The number is the constant the preload sets.
//
// Usage: bun scripts/bun-test.ts [bun test arguments]
import { TEST_TIMEOUT_MS } from "../tests/utils/timeouts";

// `bun` from PATH, not this process's binary: a machine may put a queue in front of the real one.
const proc = Bun.spawn(
  ["bun", "test", "--timeout", String(TEST_TIMEOUT_MS), ...Bun.argv.slice(2)],
  { stdio: ["inherit", "inherit", "inherit"] },
);
process.exitCode = await proc.exited;
