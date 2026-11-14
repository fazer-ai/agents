import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function select(staged: string[], extra: Record<string, string> = {}) {
  const out = Bun.spawnSync(["sh", "scripts/test-staged.sh"], {
    cwd: repo,
    env: {
      ...process.env,
      TEST_STAGED_FULL: "",
      ...extra,
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

  // The whole suite is the CI gate: on a developer machine it competes with every other session.
  // A hook that ran it again (or the ~500 importers of the database gate) would time UI tests out;
  // dropping the staged test or the sweeps with it would let the commit skip the test it touched.
  test("a change to the database gate leaves the whole suite and its importers to CI", () => {
    const out = select(["tests/db-gate.ts"]);

    expect(out).toContain(
      "tests/db-gate.ts changes every test file: the whole suite is left to CI",
    );
    expect(out).not.toContain("tests/modules/db-backed.test.ts");
    expect(out).not.toContain("bun test --parallel");
    expect(out).toContain("tests/modules/sweep.test.ts");
  });

  test("next to a path left to CI, the staged tests and the rest of the change still run", () => {
    const out = select([
      "prisma/schema.prisma",
      "app/a/service.ts",
      "tests/modules/db-backed.test.ts",
    ]);

    expect(out).toContain(
      "prisma/schema.prisma changes every test file: the whole suite is left to CI",
    );
    expect(out).toContain("tests/modules/db-backed.test.ts");
    expect(out).toContain("tests/modules/a-service.test.ts");
    expect(out).toContain("tests/modules/sweep.test.ts");
  });

  test("TEST_STAGED_FULL=1 still runs the whole suite on a database gate change", () => {
    expect(select(["tests/db-gate.ts"], { TEST_STAGED_FULL: "1" })).toContain(
      "changes every test file: running the whole suite",
    );
  });

  // One process holding every test file outgrows a developer machine's memory; each worker holds
  // only its share.
  test("the whole suite, when asked for, runs in parallel workers", () => {
    expect(
      select(["prisma/schema.prisma"], { TEST_STAGED_FULL: "1" }),
    ).toContain("running the whole suite (bun test --parallel)");
  });

  // husky puts node_modules/.bin first, and its `bun` would run the hook's tests past the machine's
  // own `bun` (a queue that caps concurrent runs); a filter that dropped more would lose the
  // developer's tools, and a failing machine bun must still fail the commit.
  test("the tests run with the machine's bun, not the one in node_modules/.bin", () => {
    const local = join(repo, "node_modules/.bin");
    const machine = join(repo, "machine-bin");
    for (const [dir, code] of [
      [local, 0],
      [machine, 3],
    ] as const) {
      write(
        join(dir.slice(repo.length + 1), "bun"),
        `#!/bin/sh\necho "$@" >> "${dir}/calls"\nexit ${code}\n`,
      );
      chmodSync(join(dir, "bun"), 0o755);
    }
    const out = Bun.spawnSync(["sh", "scripts/test-staged.sh"], {
      cwd: repo,
      env: {
        ...process.env,
        TEST_STAGED_FULL: "",
        TEST_STAGED_LIST: "",
        TEST_STAGED_FILES: "tests/modules/a-service.test.ts",
        PATH: `${local}:${machine}:${process.env.PATH ?? ""}`,
      },
    });

    expect(out.exitCode).toBe(3);
    expect(existsSync(join(local, "calls"))).toBe(false);
    expect(readFileSync(join(machine, "calls"), "utf8")).toContain(
      "test tests/modules/a-service.test.ts",
    );
  });
});
