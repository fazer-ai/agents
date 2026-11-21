import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { TEST_TIMEOUT_MS } from "@/tests/utils/timeouts";

const ROOT = join(import.meta.dir, "../..");

// bun gives a preload's `jest.setTimeout` to the first file of a process only, so a later file ran with
// bun's 5 s default. The launcher puts the suite's deadline on the command line, where it reaches every
// file. The `bun` it starts is a stub first on PATH that records its arguments.
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
  test("runs `bun test` with the suite's deadline before the arguments it was given, and exits with its code", async () => {
    stub(`printf '%s\\n' "$@" > "${bin}/args"\nexit 7`);

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
