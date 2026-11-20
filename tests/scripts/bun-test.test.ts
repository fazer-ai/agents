import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_TIMEOUT_MS } from "@/tests/utils/timeouts";

const ROOT = join(import.meta.dir, "../..");

// bun gives a preload's `jest.setTimeout` to the first file of a process only, so a later file ran with
// bun's 5 s default. The wrapper puts the suite's deadline on the command line, where it reaches every
// file. The run here is in a directory of its own, without the suite's preload.
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bun-test-"));
  writeFileSync(
    join(dir, "a.test.ts"),
    'import { test } from "bun:test";\ntest("first", () => {});\n',
  );
  writeFileSync(
    join(dir, "b.test.ts"),
    [
      'import { test } from "bun:test";',
      'test("second, past 5 s", async () => {',
      "  await new Promise((resolve) => setTimeout(resolve, 5_500));",
      "});",
      "",
    ].join("\n"),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("scripts/bun-test.sh", () => {
  test(
    "gives the second file of a run the suite's deadline, not bun's 5 s",
    async () => {
      const proc = Bun.spawn(
        [join(ROOT, "scripts/bun-test.sh"), "./a.test.ts", "./b.test.ts"],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${out}${err}`).not.toContain("timed out");
      expect(err).toMatch(/^ *2 pass$/m);
      expect(code).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
