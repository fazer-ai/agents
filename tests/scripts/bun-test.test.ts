import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  spyOn,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { until } from "@/tests/utils/poll";
import {
  holdTestTimeout,
  TEST_TIMEOUT_MS,
  TIMEOUT_ON_COMMAND_LINE,
} from "@/tests/utils/timeouts";

const ROOT = join(import.meta.dir, "../..");

// bun gives a preload's `jest.setTimeout` to the first file of a process only, so a later file ran with
// bun's 5 s default. The launcher puts the suite's deadline on the command line, where it reaches every
// file. The `bun` it starts is a stub first on PATH that records its arguments and environment.
let bin = "";

function stub(body: string) {
  writeFileSync(join(bin, "bun"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "bun"), 0o755);
}

function launch(args: string[]) {
  return Bun.spawn([process.execPath, "scripts/bun-test.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    stdout: "ignore",
    stderr: "ignore",
  });
}

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "bun-test-"));
});

afterEach(() => rmSync(bin, { recursive: true, force: true }));

describe("scripts/bun-test.ts", () => {
  test("runs `bun test` with the suite's deadline before the arguments it was given, marked, and exits with its code", async () => {
    stub(
      `printf '%s\\n' "$@" > "${bin}/args"\necho "$${TIMEOUT_ON_COMMAND_LINE}" > "${bin}/mark"\nexit 7`,
    );

    expect(await launch(["a.test.ts", "--timeout", "90000"]).exited).toBe(7);
    expect(readFileSync(join(bin, "args"), "utf8").split("\n")).toEqual([
      "test",
      "--timeout",
      String(TEST_TIMEOUT_MS),
      "a.test.ts",
      "--timeout",
      "90000",
      "",
    ]);
    expect(readFileSync(join(bin, "mark"), "utf8")).toBe("1\n");
  });

  test("a signal sent to the launcher alone reaches the run", async () => {
    // The stub ends on its own after 10 s, so a launcher that does not pass the signal on leaves
    // nothing running behind the failed test.
    stub(
      `trap 'echo TERM > "${bin}/got"; exit 143' TERM\ntouch "${bin}/up"\ni=0\nwhile [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done`,
    );
    const proc = launch(["--watch"]);
    try {
      await until("the run to start", () => existsSync(join(bin, "up")));
      proc.kill("SIGTERM");
      await until("the run to get the signal", () =>
        existsSync(join(bin, "got")),
      );
      expect(readFileSync(join(bin, "got"), "utf8")).toBe("TERM\n");
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
});

describe("holdTestTimeout", () => {
  afterEach(() => jest.restoreAllMocks());

  test("names the suite's deadline in a bare `bun test`", () => {
    const set = spyOn(jest, "setTimeout");
    holdTestTimeout(false);
    expect(set).toHaveBeenCalledWith(TEST_TIMEOUT_MS);
  });

  test("leaves the launcher's command line, a longer deadline asked for included, alone", () => {
    const set = spyOn(jest, "setTimeout");
    holdTestTimeout(true);
    expect(set).not.toHaveBeenCalled();
  });

  // A `bun test` a test starts inherits the environment but not the launcher's `--timeout`.
  test("the launcher's mark is not passed on to a process a test starts", () => {
    expect(process.env[TIMEOUT_ON_COMMAND_LINE]).toBeUndefined();
  });
});
