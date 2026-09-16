import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

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

/** Every `docs/...` path the suite opens and asserts on. Derived, never listed by hand. */
function docsReadByTests(): string[] {
  const hits = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) {
        for (const m of readFileSync(p, "utf8").matchAll(
          /(?:Bun\.file|readFileSync)\(\s*"(docs\/[^"]+)"/g,
        )) {
          const doc = m[1];
          if (doc) hits.add(doc);
        }
      }
    }
  };
  walk("tests");
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
  test("a doc the suite reads as input is classified as code", () => {
    // `docs/` is not prose by definition. Three tests open `docs/deploy.md` and assert on it, so an
    // edit there can turn the suite red; letting it skip the suite would land that red on the next
    // code PR, charged to whoever did not cause it. Measured: replacing `stop the old process`
    // inside the migration note takes native-tool-names-renamed-by-migration from 2 pass to 1 pass
    // 1 fail, while the untouched tree passes.
    //
    // The list is DERIVED from the tests, so a test that starts reading another doc turns this red
    // instead of silently reopening the hole.
    const read = docsReadByTests();
    expect(`docs read by tests: ${read.length}`).not.toBe(
      "docs read by tests: 0",
    );
    const catchAll = shared.indexOf("docs/*|");
    expect(`the docs catch-all exists: ${catchAll > -1}`).toBe(
      "the docs catch-all exists: true",
    );
    for (const doc of read) {
      const arm = shared.indexOf(`${doc}) echo "test input:`);
      expect(`${doc} has a test-input arm: ${arm > -1}`).toBe(
        `${doc} has a test-input arm: true`,
      );
      // Shell `case` takes the FIRST match, so the exception is worthless below the catch-all.
      expect(
        `${doc} arm before the catch-all: ${arm > -1 && arm < catchAll}`,
      ).toBe(`${doc} arm before the catch-all: true`);
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
