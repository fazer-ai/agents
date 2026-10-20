import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

// A tree of its own per test: the selector greps `tests/` under its working directory, so each case
// lays out exactly the helpers and test files it is about.
let repo = "";

function write(path: string, body: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function select(staged: string[]) {
  const out = Bun.spawnSync(["sh", "scripts/test-staged.sh"], {
    cwd: repo,
    env: {
      ...process.env,
      TEST_STAGED_LIST: "1",
      TEST_STAGED_FILES: staged.join("\n"),
    },
  });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return out.stdout.toString();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "test-staged-"));
  mkdirSync(join(repo, "scripts"));
  cpSync(
    join(ROOT, "scripts/test-staged.sh"),
    join(repo, "scripts/test-staged.sh"),
  );
  write("app/a/service.ts", "export const a = 1;\n");
  write("app/b/other.ts", "export const b = 1;\n");
  write(
    "tests/db-gate.ts",
    [
      'import { readdirSync, readFileSync } from "node:fs";',
      "export const hash = (dir: string) =>",
      "  readdirSync(dir).map((e) => readFileSync(dir + e));",
      "",
    ].join("\n"),
  );
  write(
    "tests/utils/source-text.ts",
    'export const scan = () => new Glob("**/*.ts").scan("app");\n',
  );
  write(
    "tests/modules/db-backed.test.ts",
    'import { dbUp } from "@/tests/db-gate";\n',
  );
  write(
    "tests/modules/sweep.test.ts",
    'import { scan } from "../utils/source-text";\n',
  );
  write(
    "tests/modules/a-service.test.ts",
    'import { a } from "../../app/a/service";\n',
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("test-staged", () => {
  test("a source change does not select every test that opens a database", () => {
    const picked = select(["app/b/other.ts"]);

    expect(picked).not.toContain("tests/modules/db-backed.test.ts");
    expect(picked).toContain("tests/modules/sweep.test.ts");
  });

  test("a source change selects its importers and the tree sweeps", () => {
    const picked = select(["app/a/service.ts"]);

    expect(picked).toContain("tests/modules/a-service.test.ts");
    expect(picked).toContain("tests/modules/sweep.test.ts");
    expect(picked).not.toContain("tests/modules/db-backed.test.ts");
  });

  test("a change to the database gate still runs the whole suite", () => {
    expect(select(["tests/db-gate.ts"])).toContain(
      "changes every test file: running the whole suite",
    );
  });
});
