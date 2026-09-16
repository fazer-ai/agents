import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { withoutComments } from "@/../tests/utils/source-text";

// The branch rule on `main` requires a set of status-check CONTEXTS, and a context that never gets
// published blocks the merge exactly as a red one does. Nothing in this repo connected the two
// facts, so the workflows drifted from the rule twice and the cost landed on a human: PRs #602 and
// #641 touched only docs, `paths-ignore` kept all three workflows from starting, the required
// contexts stayed absent, and the ship gate's T0 merge had to be done by hand (issue #643).
//
// The fix has three halves and this fence holds all of them. The workflows always START and ask a
// `changes` job what moved; the required NAME belongs to a small job that always RUNS; and the
// question "is this only documentation?" is not answered by the directory alone, because part of
// `docs/` is read by the suite as INPUT.
//
// This test cannot read the branch rule (it lives in GitHub, not in the tree), so REQUIRED below is
// a copy of it. That is the point rather than a flaw: changing one without the other is the failure
// this exists to make loud.

const WORKFLOWS = [
  ".github/workflows/lint.yml",
  ".github/workflows/build-check.yml",
  ".github/workflows/test.yml",
] as const;

const SHARED = ".github/workflows/changed-code.yml";

// Where the suite actually lives. `bunfig.toml` roots discovery here, so a sweep hard-coded to
// "tests" would go quietly blind the day that changes — and it is not hypothetical: `src/` already
// holds two `.test.ts` files that never run for exactly this reason.
const SUITE_ROOT = (
  readFileSync("bunfig.toml", "utf8").match(/^\s*root\s*=\s*"([^"]+)"/m)?.[1] ??
  "./tests"
).replace(/^\.\//, "");

// The contexts the `main` ruleset of fazer-ai/agents requires. Until the rule is edited this is the
// list this PR INSTALLS, not the one live: the rule still names `test (1/4)`..`test (4/4)`, and it
// cannot be edited first because no open PR publishes `tests` yet and every one of them would block
// on an absent context. The order is merge, then edit the rule, and this list is what the edit must
// produce.
const REQUIRED = ["lint", "type-check", "tests"] as const;

// The trigger-syntax globs that used to sit in `paths-ignore`. They must not come back: that filter
// skips the workflow, which is what published nothing.
const DOCS_ONLY = [
  "docs/**",
  "**.md",
  ".claude/**",
  "licensing/**",
  ".github/ISSUE_TEMPLATE/**",
];

type Job = {
  if?: string;
  needs?: string | string[];
  strategy?: { matrix?: unknown };
  steps?: Array<{ if?: string; run?: string }>;
  uses?: string;
};

function load(path: string) {
  const raw = readFileSync(path, "utf8");
  const doc = parse(raw);
  return {
    raw,
    jobs: doc.jobs as Record<string, Job>,
    on: doc.on as Record<string, { "paths-ignore"?: string[] } | null>,
  };
}

const files = WORKFLOWS.map((p) => ({ path: p, ...load(p) }));
const shared = readFileSync(SHARED, "utf8");
const allJobs = new Map<string, { job: Job; path: string }>();
for (const f of files) {
  for (const [id, job] of Object.entries(f.jobs))
    allJobs.set(id, { job, path: f.path });
}

/**
 * THE CLASSIFIER'S OWN ANSWER, not a guess at it.
 *
 * An earlier version of this fence looked for literal text in the YAML (`docs/deploy.md) echo "test
 * input:`). That reads a correct classifier as broken the moment anyone reorders the alternatives
 * inside an arm, which the shell treats as the same program, or groups two paths into one arm, which
 * is the natural shape of the second entry. A fence that cries wolf is the one people learn to
 * delete, so this runs the arms instead of matching them.
 *
 * It also cannot be replaced by a glob library: in shell `case`, `*` crosses `/`, so `.claude/*`
 * matches `.claude/rules/prisma.md`. minimatch and Bun.Glob do not, and swapping them in would
 * silently stop covering a case this already covers.
 */
function extractCase(): { variable: string; arms: string } {
  const run = String(
    parse(readFileSync(SHARED, "utf8")).jobs.detect.steps[0].run ?? "",
  );
  // Anchored on the LOOP, so renaming `$f` cannot leave this reading the wrong `case`. The first
  // `case` in the step is the one over `github.event_name`, whose `*)` matches everything.
  const loop = run.match(
    /while\s+IFS=\s*read\s+-r\s+(\w+)\s*;\s*do([\s\S]*?)\bdone\b/,
  );
  if (!loop?.[1] || !loop[2])
    throw new Error("ci fence: no `while read` loop in changed-code.yml");
  const variable = loop[1];
  const block = loop[2].match(
    new RegExp(`case\\s+"\\$${variable}"\\s+in([\\s\\S]*?)\\besac\\b`),
  );
  if (!block?.[1])
    throw new Error(`ci fence: no \`case "$${variable}"\` inside the loop`);
  return { variable, arms: block[1] };
}

const CASE = extractCase();

/** What the classifier answers for one path: `true` means the suite runs for it. */
function classify(path: string): boolean {
  // The arms print their reasoning; only `$code` is the answer, so their stdout goes nowhere.
  const script = `code=false\n${CASE.variable}="$1"\n{ case "$${CASE.variable}" in\n${CASE.arms}\nesac ; } >/dev/null 2>&1\nprintf '%s' "$code"`;
  const out = Bun.spawnSync(["sh", "-c", script, "sh", path]);
  const answer = out.stdout.toString().trim();
  if (answer !== "true" && answer !== "false") {
    throw new Error(
      `ci fence: the classifier answered ${JSON.stringify(answer)} for ${path}`,
    );
  }
  return answer === "true";
}

/**
 * Every file the suite OPENS and asserts on, whatever its extension.
 *
 * Comments are stripped first (`withoutComments` keeps string bodies, which is exactly what reading a
 * path out of a literal needs): after this round the fence's own prose names `CLAUDE.md`, and a
 * sweep over raw text would report itself.
 *
 * A path held in a `const` counts, because that is the idiom already in the tree
 * (tests/prisma/rls-policy-split-migration.test.ts). DYNAMIC reads do not: a path built by `join`, a
 * template with a variable, or `new URL` is not resolvable by reading the file, and there are 30-odd
 * of them in `tests/`. That is a declared gap rather than an oversight — the ones that matter here
 * are documentation a person edits by hand, and nobody reaches those through a computed path.
 */
function filesReadByTests(): string[] {
  const hits = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) {
        const src = withoutComments(readFileSync(p, "utf8"));
        const consts = new Map<string, string>();
        for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*"([^"\n]+)"/g)) {
          if (m[1] && m[2]) consts.set(m[1], m[2]);
        }
        for (const m of src.matchAll(
          /(?:Bun\.file|readFileSync)\(\s*(?:"([^"\n]+)"|(\w+))/g,
        )) {
          const literal = m[1] ?? (m[2] ? consts.get(m[2]) : undefined);
          if (literal && !literal.startsWith("/") && !literal.includes("${"))
            hits.add(literal);
        }
      }
    }
  };
  walk(SUITE_ROOT);
  return [...hits].sort();
}

describe("the required contexts are always published", () => {
  test("every context the branch rule requires exists as a job", () => {
    expect(REQUIRED.filter((c) => !allJobs.has(c))).toEqual([]);
  });

  test("each required job runs even when the work below it is skipped", () => {
    // Without `always()` the job inherits its needs' skip, and a skipped job publishes `skipped` at
    // best and nothing at worst. `always()` is what makes the context exist on a docs-only PR, and
    // what leaves that PR with a check that actually executed instead of an absence of evidence.
    for (const context of REQUIRED) {
      const job = allJobs.get(context)?.job;
      expect(`${context}: ${job?.if ?? "NO JOB"}`).toContain("always()");
    }
  });

  test("no required context is held by a matrix job", () => {
    // Measured on agents-pro: a skipped matrix job publishes `test (${{ matrix.shard }}/4)`
    // uninterpolated, so per-shard contexts are absent precisely when the suite is skipped.
    for (const context of REQUIRED) {
      const matrix = allJobs.get(context)?.job.strategy?.matrix;
      expect(`${context} matrix: ${JSON.stringify(matrix ?? null)}`).toBe(
        `${context} matrix: null`,
      );
    }
  });

  test("no required context is published by two jobs", () => {
    // A second producer of the same name can report last and vouch for what it never ran. `changes`
    // is the near miss: it publishes one check-run per workflow, all three under that name.
    const producers = new Map<string, number>();
    for (const f of files) {
      for (const id of Object.keys(f.jobs))
        producers.set(id, (producers.get(id) ?? 0) + 1);
    }
    for (const context of REQUIRED) {
      expect(
        `${context} published by ${producers.get(context) ?? 0} job(s)`,
      ).toBe(`${context} published by 1 job(s)`);
    }
    expect(
      `REQUIRED includes changes: ${REQUIRED.includes("changes" as never)}`,
    ).toBe("REQUIRED includes changes: false");
  });

  test("each required job fails when the work it vouches for failed", () => {
    // A context that is always green vouches for nothing.
    for (const context of REQUIRED) {
      const job = allJobs.get(context)?.job;
      const needs = Array.isArray(job?.needs) ? job.needs : [job?.needs];
      const real = needs.find((n) => n && n !== "changes");
      expect(`${context} vouches for: ${real ?? "NOTHING"}`).not.toContain(
        "NOTHING",
      );
      const guard = (job?.steps ?? []).find((s) => s.run?.includes("exit 1"));
      expect(`${context}: ${guard?.if ?? "NO GUARD"}`).toContain(
        `needs.${real}.result == 'failure'`,
      );
      // Not knowing what changed is not evidence that nothing did.
      expect(`${context}: ${guard?.if ?? "NO GUARD"}`).toContain(
        "needs.changes.result",
      );
    }
  });
});

describe("the workflows always start", () => {
  test("no workflow filters itself out by path", () => {
    // Asked of the PARSED triggers, not of the text: these files talk about `paths-ignore` in the
    // comment that explains why it left, and a grep would read its own tombstone as the thing.
    for (const f of files) {
      for (const [event, cfg] of Object.entries(f.on)) {
        expect(
          `${f.path} on.${event}: ${JSON.stringify(cfg?.["paths-ignore"] ?? null)}`,
        ).toBe(`${f.path} on.${event}: null`);
      }
    }
  });

  test("the docs-only path list lives in one file", () => {
    for (const p of DOCS_ONLY) {
      // `**.md` is a glob for the trigger syntax; the shared job matches it as a shell pattern.
      const needle = p === "**.md" ? "*.md" : p.replace("/**", "/*");
      expect(`${p} -> ${shared.includes(needle) ? "covered" : "MISSING"}`).toBe(
        `${p} -> covered`,
      );
    }
    for (const f of files) {
      expect(`${f.path} repeats the list: ${f.raw.includes("'docs/**'")}`).toBe(
        `${f.path} repeats the list: false`,
      );
    }
  });

  test("every workflow asks the shared job what changed", () => {
    for (const f of files) {
      expect(`${f.path}: ${f.jobs.changes?.uses ?? "absent"}`).toBe(
        `${f.path}: ./.github/workflows/changed-code.yml`,
      );
    }
  });
});

describe("what counts as documentation", () => {
  test("the classifier's arms were actually found", () => {
    // A text extractor that matches nothing returns nothing, and "no pattern skips anything" then
    // reads as "everything is fine". Every derivation below is worthless without this one, so it
    // asserts the shapes are non-empty rather than trusting that they were.
    expect(`loop variable: ${CASE.variable}`).not.toBe("loop variable: ");
    expect(`arms found: ${CASE.arms.trim().length > 0}`).toBe(
      "arms found: true",
    );
    expect(`suite root: ${SUITE_ROOT}`).toBe("suite root: tests");
    expect(`files read by the suite: ${filesReadByTests().length}`).not.toBe(
      "files read by the suite: 0",
    );
  });

  test("every file the suite reads is classified as code", () => {
    // `docs/` is not prose by definition, and neither is any other skippable path. Three tests open
    // `docs/deploy.md` and assert on it, so an edit there can turn the suite red; letting it skip the
    // suite would land that red on the next code PR, charged to whoever did not cause it. Measured:
    // replacing `stop the old process` inside the migration note takes
    // native-tool-names-renamed-by-migration from 2 pass to 1 pass 1 fail.
    //
    // The sweep covers EVERY skippable set, not just `docs/`: `*.md` reaches CLAUDE.md and README.md
    // at the root, and a test reading one of those would reopen the hole this closed (#676).
    for (const file of filesReadByTests()) {
      expect(`${file} runs the suite: ${classify(file)}`).toBe(
        `${file} runs the suite: true`,
      );
    }
  });

  test("a path nothing reads is still allowed to skip the suite", () => {
    // The other half: a fence that answers `code` for everything protects nothing and costs every
    // docs-only PR the full suite.
    for (const doc of [
      "docs/mcp.md",
      "docs/ui.md",
      ".claude/rules/prisma.md",
      "README.md",
    ]) {
      expect(`${doc} runs the suite: ${classify(doc)}`).toBe(
        `${doc} runs the suite: false`,
      );
    }
    for (const code of [
      "package.json",
      "src/config.ts",
      "prisma/schema.prisma",
      "openapi.json",
    ]) {
      expect(`${code} runs the suite: ${classify(code)}`).toBe(
        `${code} runs the suite: true`,
      );
    }
  });

  test("a rename is judged by both of its paths", () => {
    // The API reports a rename's destination in `filename` and its source in `previous_filename`.
    // Asked of the two jq expressions rather than of the file's word count: the comment above them
    // names the field too, and counting mentions would pass on the explanation alone.
    expect(shared).toContain(
      '.[] | [.filename, (.previous_filename // "")] | @tsv',
    );
    expect(shared).toContain(
      ".files[]? | .filename, (.previous_filename // empty)",
    );
  });

  test("a file list that hit its cap runs everything", () => {
    // Both APIs truncate, at 3000 files for a PR and 300 for a compare, and the entries that do not
    // come back are exactly the ones nothing can classify.
    expect(shared).toContain('[ "$count" -ge 3000 ]');
    expect(shared).toContain('[ "$count" -ge 300 ]');
  });

  test("a push that is not a fast-forward runs everything", () => {
    // `compare` answers from the MERGE BASE, so on a force push to a divergent history it never
    // mentions what the old side had and the new one dropped.
    expect(shared).toContain('.status // "unknown"');
    expect(shared).toContain('[ "$status" != ahead ]');
  });
});
