// `bun test` with the suite's per-test deadline on the command line, the only place it reaches every
// file: bun applies the preload's `jest.setTimeout` to the first file of a process only and ignores a
// `timeout` in bunfig.toml. The number is the constant the preload sets. A `--timeout` among the
// arguments comes after it and wins, except in a file that sets its own (the first, through the
// preload, and the dashboard sums files).
//
// Usage: bun --no-env-file scripts/bun-test.ts [bun test arguments]
// (`--no-env-file` leaves the dotenv files to `bun test`, which honours its own flags for them.)
import { delimiter } from "node:path";
import { TEST_TIMEOUT_MS } from "../tests/utils/timeouts";

// A package script runs with node_modules/.bin first on PATH, and the `bun` there would start the run
// past the one the machine puts in front of the real binary (a queue that caps concurrent runs). The
// machine's `bun`, found on PATH without the project's bin directories, starts the run when it is this
// one's version, as scripts/test-staged.sh does for the hook; otherwise the binary running this script
// does. The run keeps the PATH it was given.
function testBun(path: string): string {
  const outside = path
    .split(delimiter)
    .filter((dir) => !/(^|[\\/])node_modules[\\/]\.bin[\\/]?$/.test(dir))
    .join(delimiter);
  const machine = Bun.which("bun", { PATH: outside });
  if (machine === null) return process.execPath;
  try {
    const version = Bun.spawnSync([machine, "--version"])
      .stdout.toString()
      .trim();
    return version === Bun.version ? machine : process.execPath;
  } catch {
    // One the system cannot start (a shim whose interpreter is gone) is not the machine's runtime.
    return process.execPath;
  }
}

const proc = Bun.spawn(
  [
    testBun(process.env.PATH ?? ""),
    "test",
    "--timeout",
    String(TEST_TIMEOUT_MS),
    ...Bun.argv.slice(2),
  ],
  { stdio: ["inherit", "inherit", "inherit"] },
);
// A signal sent to this process alone reaches the run too, so a `--watch` is not left behind. A machine
// shim in front of bun passes the signals it gets on to its own child, as the queue on this suite's
// shared machines does: one that did not would leave every caller's run behind, not only this one's.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => proc.kill(signal));
process.exitCode = await proc.exited;
