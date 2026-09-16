import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// The branch rule on `main` requires a set of status-check CONTEXTS, and a context that never gets
// published blocks the merge exactly as a red one does. Nothing in this repo used to connect the two
// facts, so the workflows drifted from the rule twice and the cost landed on a human: PRs #602 and
// #641 touched only docs, `paths-ignore` kept all three workflows from starting, the six required
// contexts stayed absent, and the ship gate's T0 merge had to be done by hand (issue #643).
//
// The fix has two halves and this fence holds both. The workflows now always START and ask a
// `changes` job what moved; and the required NAME belongs to a small job that always RUNS, which is
// the only shape that survives the trap measured on agents-pro: a MATRIX job skipped by its own `if`
// does not expand its matrix. It publishes one check literally named `test (${{ matrix.shard }}/4)`,
// so requiring `test (1/4)`..`test (4/4)` left four contexts absent on every skipped run.
//
// This test cannot read the branch rule (it lives in GitHub, not in the tree), so REQUIRED below is
// a copy of it. That is the point rather than a flaw: changing one without the other is the failure
// this exists to make loud.

const WORKFLOWS = [
  ".github/workflows/lint.yml",
  ".github/workflows/build-check.yml",
  ".github/workflows/test.yml",
] as const;

// Mirrors the `main` ruleset of fazer-ai/agents. Changing this list means changing that rule in the
// same round, and the PR body says so.
const REQUIRED = ["lint", "type-check", "tests"] as const;

// The paths a docs-only change is allowed to touch. They live in changed-code.yml and MUST NOT come
// back as a `paths-ignore` block: that filter skips the workflow, which is what published nothing.
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

function load(path: string): {
  raw: string;
  jobs: Record<string, Job>;
  on: Record<string, { "paths-ignore"?: string[] } | null>;
} {
  const raw = readFileSync(path, "utf8");
  const doc = parse(raw);
  return { raw, jobs: doc.jobs as Record<string, Job>, on: doc.on };
}

const files = WORKFLOWS.map((p) => ({ path: p, ...load(p) }));
const allJobs = new Map<string, { job: Job; path: string }>();
for (const f of files) {
  for (const [id, job] of Object.entries(f.jobs))
    allJobs.set(id, { job, path: f.path });
}

describe("the required contexts are always published", () => {
  test("every context the branch rule requires exists as a job", () => {
    const missing = REQUIRED.filter((c) => !allJobs.has(c));
    expect(missing).toEqual([]);
  });

  test("each required job runs even when the work below it is skipped", () => {
    // Without `always()` the job inherits its needs' skip, and a skipped job publishes the
    // conclusion `skipped` at best and nothing at worst. `always()` is what makes the context exist
    // on a docs-only PR, which is the whole point of the change.
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

  test("each required job fails when the work it vouches for failed", () => {
    // A context that is always green vouches for nothing. Every required job must name the real
    // job's `result` in a step that exits non-zero.
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
        const ignored = cfg?.["paths-ignore"];
        expect(
          `${f.path} on.${event}: ${JSON.stringify(ignored ?? null)}`,
        ).toBe(`${f.path} on.${event}: null`);
      }
    }
  });

  test("the docs-only path list lives in one file", () => {
    const shared = readFileSync(".github/workflows/changed-code.yml", "utf8");
    for (const p of DOCS_ONLY) {
      // `**.md` is a glob for the trigger syntax; the shared job matches it as a shell pattern.
      const needle = p === "**.md" ? "*.md" : p.replace("/**", "/*");
      expect(`${p} -> ${shared.includes(needle) ? "covered" : "MISSING"}`).toBe(
        `${p} -> covered`,
      );
    }
    // And nowhere else: a second copy of the list is the drift this round removed.
    for (const f of files) {
      expect(`${f.path} repeats the list: ${f.raw.includes("'docs/**'")}`).toBe(
        `${f.path} repeats the list: false`,
      );
    }
  });

  test("a rename is judged by both of its paths", () => {
    // The API reports a rename's destination in `filename` and its source in `previous_filename`.
    // Reading only the first calls `src/config.ts` -> `docs/config.ts` a docs-only change and
    // publishes green required checks over a module that left the tree. Round 1 of the review.
    const shared = readFileSync(".github/workflows/changed-code.yml", "utf8");
    // Asked of the two jq expressions rather than of the file's word count: the comment above them
    // names the field too, and counting mentions would pass on the explanation alone.
    expect(shared).toContain(".[] | .filename, (.previous_filename // empty)");
    expect(shared).toContain(
      ".files[]? | .filename, (.previous_filename // empty)",
    );
  });

  test("a push that is not a fast-forward runs everything", () => {
    // `compare` answers from the MERGE BASE, so on a force push to a divergent history it never
    // mentions what the old side had and the new one dropped, and the docs-only list it does return
    // would skip the suite. Round 1 of the review.
    const shared = readFileSync(".github/workflows/changed-code.yml", "utf8");
    expect(shared).toContain('.status // "unknown"');
    expect(shared).toContain('[ "$status" != ahead ]');
  });

  test("every workflow asks the shared job what changed", () => {
    for (const f of files) {
      expect(`${f.path}: ${f.jobs.changes?.uses ?? "absent"}`).toBe(
        `${f.path}: ./.github/workflows/changed-code.yml`,
      );
    }
  });
});
