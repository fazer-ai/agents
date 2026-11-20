import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_TIMEOUT_MS } from "@/tests/utils/timeouts";

const ROOT = join(import.meta.dir, "../..");

// bun gives a preload's `jest.setTimeout` to the first file of a process only, so a later file ran with
// bun's 5 s default. The launcher puts the suite's deadline on the command line, where it reaches every
// file. The `bun` it starts is a stub first on PATH that records its arguments.
let bin = "";

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "bun-test-"));
  writeFileSync(
    join(bin, "bun"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\nexit 7\n`,
  );
  chmodSync(join(bin, "bun"), 0o755);
});

afterEach(() => rmSync(bin, { recursive: true, force: true }));

describe("scripts/bun-test.ts", () => {
  test("runs `bun test` with the suite's deadline and the arguments it was given, and exits with its code", () => {
    const out = Bun.spawnSync(
      [process.execPath, "scripts/bun-test.ts", "a.test.ts", "--bail"],
      {
        cwd: ROOT,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );

    expect(readFileSync(join(bin, "args"), "utf8").split("\n")).toEqual([
      "test",
      "--timeout",
      String(TEST_TIMEOUT_MS),
      "a.test.ts",
      "--bail",
      "",
    ]);
    expect(out.exitCode).toBe(7);
  });
});
