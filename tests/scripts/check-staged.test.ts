import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

// A repository of its own per test: the hook reads the index, so each case stages exactly what it is
// about without touching the real one. It carries the lint configuration, the plugins and the script,
// committed, and borrows the repository's node_modules for Biome.
let repo = "";

// Run from a pre-commit hook, git exports GIT_DIR, GIT_INDEX_FILE and the like, absolute in a linked
// worktree, and they win over `cwd`: inherited, every command below would act on the real repository.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function git(...args: string[]) {
  const out = Bun.spawnSync(
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd: repo, env },
  );
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return out.stdout.toString();
}

function write(path: string, body: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function hook(extra: Record<string, string> = {}) {
  const out = Bun.spawnSync(["sh", "scripts/check-staged.sh"], {
    cwd: repo,
    env: { ...env, CHECK_STAGED_LINT_ONLY: "1", ...extra },
  });
  return {
    code: out.exitCode,
    stdout: out.stdout.toString(),
    output: out.stdout.toString() + out.stderr.toString(),
  };
}

const listed = () =>
  hook({ CHECK_STAGED_LIST: "1" }).stdout.split("\n").filter(Boolean);

const BAD = "export function f() {\n  debugger;\n}\n";
const GOOD = "export const y = 1;\n";
const WARN = 'export const A = () => <div className="p-2 flex" />;\n';

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "check-staged-"));
  git("init", "-q");
  cpSync(join(ROOT, "biome.jsonc"), join(repo, "biome.jsonc"));
  cpSync(join(ROOT, "biome-plugins"), join(repo, "biome-plugins"), {
    recursive: true,
  });
  mkdirSync(join(repo, "scripts"));
  cpSync(
    join(ROOT, "scripts/check-staged.sh"),
    join(repo, "scripts/check-staged.sh"),
  );
  write(".gitignore", "node_modules\n");
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  write("tests/kept.test.ts", GOOD);
  git("add", "-A");
  git("commit", "-qm", "base");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("what the pre-commit lints", () => {
  test("the staged files, not a deleted one, and nothing else", () => {
    // Content of its own, or git pairs it with the deleted file as a rename.
    write("tests/a.ts", "export const a = 2;\n");
    write("README.md", "# r\n");
    write("tests/untracked.ts", BAD);
    git("add", "tests/a.ts", "README.md");
    git("rm", "-q", "tests/kept.test.ts");
    expect(listed().sort()).toEqual(["lint: README.md", "lint: tests/a.ts"]);
  });

  test("everything, when the lint configuration or a plugin is staged", () => {
    write("tests/a.ts", GOOD);
    write("biome.jsonc", `${readFileSync(join(repo, "biome.jsonc"))}\n`);
    git("add", "tests/a.ts", "biome.jsonc");
    expect(listed()).toEqual(["lint: all"]);

    git("reset", "-q");
    write("biome-plugins/extra.grit", "`debugger`\n");
    git("add", "tests/a.ts", "biome-plugins/extra.grit");
    expect(listed()).toEqual(["lint: all"]);
  });

  test("nothing, when nothing is staged", () => {
    expect(listed()).toEqual([]);
  });
});

describe("the lint step", () => {
  test("refuses a staged finding, and ignores one the commit does not stage", () => {
    write("tests/good.ts", GOOD);
    write("tests/untracked.ts", BAD);
    git("add", "tests/good.ts");
    expect(hook().code).toBe(0);

    write("tests/bad.ts", BAD);
    git("add", "tests/bad.ts");
    const refused = hook();
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("tests/bad.ts");
  });

  test("reads a file whose name git would quote", () => {
    write("tests/café.ts", BAD);
    git("add", "tests/café.ts");
    const refused = hook();
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("noDebugger");
  });

  test("refuses a staged file whose only finding is a warning, as CI does", () => {
    write("tests/warn.tsx", WARN);
    git("add", "tests/warn.tsx");
    expect(hook().code).not.toBe(0);
  });

  test("judges a file staged in part on what the commit carries", () => {
    // The finding only on disk: the commit carries the clean copy.
    write("tests/kept.test.ts", `${GOOD}${BAD}`);
    git(
      "update-index",
      "--cacheinfo",
      `100644,${blob(GOOD + GOOD.replace("y", "z"))},tests/kept.test.ts`,
    );
    expect(hook().code).toBe(0);

    // The finding only in the index: the disk was fixed after staging.
    git(
      "update-index",
      "--cacheinfo",
      `100644,${blob(BAD)},tests/kept.test.ts`,
    );
    write("tests/kept.test.ts", GOOD);
    expect(hook().code).not.toBe(0);
  });

  test("leaves the index and the working tree as it found them", () => {
    write("tests/bad.ts", BAD);
    git("add", "tests/bad.ts");
    write("tests/bad.ts", GOOD);
    const before = [
      git("status", "--porcelain"),
      git("diff"),
      git("diff", "--cached"),
    ];
    hook();
    expect([
      git("status", "--porcelain"),
      git("diff"),
      git("diff", "--cached"),
    ]).toEqual(before);
  });
});

function blob(body: string): string {
  const out = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
    cwd: repo,
    env,
    stdin: new TextEncoder().encode(body),
  });
  return out.stdout.toString().trim();
}
