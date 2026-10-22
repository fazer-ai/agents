// The master skips on main what a pull request already passed (already-tested.yml, mark-tested.yml).
// The marker job's script and the lookup's script run against a fake `gh` that answers the endpoints
// they call from a scenario, through the real `jq` (what `gh --jq` evaluates), so the name the
// upload writes is the name the lookup asks for, and every check in between is a branch that runs.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dir, "../..");
const WORKFLOWS = join(ROOT, ".github/workflows");
const REPO = "fazer-ai/agents-master";

type Step = {
  id?: string;
  run?: string;
  uses?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, string>;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  "continue-on-error"?: boolean;
  steps?: Step[];
};
type Workflow = { jobs: Record<string, Job> };

const load = async (file: string) =>
  parse(await Bun.file(join(WORKFLOWS, file)).text()) as Workflow;

const needsOf = (job: Job) =>
  [job.needs ?? []].flat().filter((need): need is string => Boolean(need));

// The three workflows that vouch for their own work, and the work each marker covers.
const CALLERS = [
  { file: "test.yml", name: "test", work: "test", prefix: "test (" },
  { file: "lint.yml", name: "lint", work: "lint-run", prefix: "lint-run" },
  {
    file: "build-check.yml",
    name: "build-check",
    work: "type-check-run",
    prefix: "type-check-run",
  },
] as const;

const lookup = await load("already-tested.yml");
const marker = await load("mark-tested.yml");
const lookStep = lookup.jobs.look?.steps?.find((step) => step.run);
const readStep = marker.jobs.tree?.steps?.find((step) => step.run);
const uploadStep = marker.jobs.mark?.steps?.find((step) =>
  (step.uses ?? "").startsWith("actions/upload-artifact@"),
);

const scratch: string[] = [];
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "already-tested-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function runStep(script: string, env: Record<string, string>, cwd: string) {
  const result = Bun.spawnSync(["bash", "-e", "-c", script], {
    cwd,
    env: { HOME: process.env.HOME ?? "", ...env },
  });
  return {
    exit: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

describe.each(CALLERS)(
  "$file asks the lookup and leaves the marker",
  (caller) => {
    test("the lookup runs only on a push to the master, once the change is code", async () => {
      const job = (await load(caller.file)).jobs["already-tested"];
      expect(job?.uses).toBe("./.github/workflows/already-tested.yml");
      expect(job?.with).toEqual({
        workflow: caller.name,
        suites: caller.prefix,
      });
      expect(needsOf(job ?? {})).toEqual(["changes"]);
      const condition = (job?.if ?? "").replace(/\s+/g, " ").trim();
      expect(condition).toBe(
        `github.event_name == 'push' && github.repository == '${REPO}' && needs.changes.outputs.code == 'true'`,
      );
      expect(job?.permissions).toEqual({ actions: "read", contents: "read" });
    });

    test("the work waits for the lookup and runs unless the tree already passed", async () => {
      const job = (await load(caller.file)).jobs[caller.work];
      expect(new Set(needsOf(job ?? {}))).toEqual(
        new Set(["changes", "already-tested"]),
      );
      // `!cancelled()` because `already-tested` is skipped on every pull request, and a job whose need
      // was skipped is skipped too unless its condition calls a status function.
      expect((job?.if ?? "").replace(/\s+/g, " ").trim()).toBe(
        "!cancelled() && needs.changes.outputs.code == 'true' && needs.already-tested.outputs.skip != 'true'",
      );
    });

    test("the marker is its own job, after the work passed, on a pull request of the master", async () => {
      const job = (await load(caller.file)).jobs["mark-tested"];
      expect(job?.uses).toBe("./.github/workflows/mark-tested.yml");
      expect(job?.with).toEqual({ workflow: caller.name });
      expect(needsOf(job ?? {})).toEqual([caller.work]);
      expect((job?.if ?? "").replace(/\s+/g, " ").trim()).toBe(
        `!cancelled() && github.event_name == 'pull_request' && github.repository == '${REPO}' && needs.${caller.work}.result == 'success'`,
      );
      expect(job?.permissions).toEqual({ contents: "read" });
    });

    test("no required context waits for the marker or the lookup", async () => {
      // Required contexts are published by the always() aggregators, which exist for pull requests
      // only; a skipped or failed marker must never be able to block a merge.
      const jobs = (await load(caller.file)).jobs;
      for (const [id, job] of Object.entries(jobs)) {
        if (!/always\(\)/.test(job.if ?? "")) continue;
        expect(
          `${id} needs ${needsOf(job).filter((n) => n === "mark-tested" || n === "already-tested")}`,
        ).toBe(`${id} needs `);
      }
    });
  },
);

describe("the marker jobs", () => {
  test("have no checkout, run none of the PR's code and cannot paint the PR red", () => {
    expect(marker.jobs.tree?.["continue-on-error"]).toBe(true);
    expect(marker.jobs.mark?.["continue-on-error"]).toBe(true);
    expect(marker.jobs.tree?.steps?.map((step) => step.uses ?? "run")).toEqual([
      "run",
    ]);
    expect(marker.jobs.mark?.steps?.map((step) => step.uses ?? "run")).toEqual([
      "run",
      expect.stringMatching(/^actions\/upload-artifact@/),
    ]);
    expect(readStep?.env?.SHA).toMatch(/^\$\{\{\s*github\.sha\s*\}\}$/);
  });

  test("the tree is in the NAME of the job the lookup trusts", () => {
    // A name is written by the workflow definition; an artifact can be uploaded by anything that
    // holds the runner's credentials.
    expect(needsOf(marker.jobs.mark ?? {})).toEqual(["tree"]);
    expect((marker.jobs.mark as { name?: string }).name).toBe(
      `mark \${{ needs.tree.outputs.tree }}`,
    );
  });
});

describe("the lookup job", () => {
  test("its errors leave the output empty instead of failing main", () => {
    expect(lookStep?.["continue-on-error"]).toBe(true);
    expect(lookup.jobs.look?.outputs?.skip).toMatch(
      new RegExp(
        `^\\$\\{\\{\\s*steps\\.${lookStep?.id}\\.outputs\\.skip\\s*\\}\\}$`,
      ),
    );
  });
});

// A real pull request run is `.github/workflows/<name>.yml`; its jobs are the work and, from a
// reusable workflow, `mark-tested / mark` (the caller's job id, then the called job's name).
const MARK_JOB = (tree: string) => `mark-tested / mark ${tree}`;

describe.each(CALLERS)("the lookup for $name", (caller) => {
  const TREE = "1".repeat(40);
  const SHA = "c".repeat(40);
  const HEAD = "d".repeat(40);
  const MERGE = "2".repeat(40);
  const BLOB = "e".repeat(40);
  const WORKFLOW = `.github/workflows/${caller.name}.yml`;
  const FILES = [
    WORKFLOW,
    ".github/workflows/already-tested.yml",
    ".github/workflows/mark-tested.yml",
  ];
  const WORK_DONE = "2026-10-21T20:00:00Z";
  const MARKED = "2026-10-21T20:00:30Z";
  // The work as it is published: four shards for the tests, one job for the rest.
  const workNames =
    caller.name === "test"
      ? [1, 2, 3, 4].map((n) => `test (${n}/4)`)
      : [caller.work];

  type RunJob = {
    name: string;
    status: string;
    conclusion: string | null;
    completed_at: string | null;
  };
  type Run = {
    path: string;
    event: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
    jobs: RunJob[];
  };
  type Scenario = {
    tree: string;
    commits: Record<string, string>;
    blobs: Record<string, string>;
    artifacts: {
      name: string;
      expired: boolean;
      run: number;
      created_at: string;
    }[];
    runs: Record<string, Run>;
  };
  const done = (name: string, at = WORK_DONE): RunJob => ({
    name,
    status: "completed",
    conclusion: "success",
    completed_at: at,
  });
  const greenRun = (): Run => ({
    path: WORKFLOW,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD,
    jobs: [
      done("changes"),
      ...workNames.map((name) => done(name)),
      // The aggregator shares the work's prefix in spirit, not in name: it must not be counted.
      done(`${caller.name}-required`),
      done(MARK_JOB(TREE), "2026-10-21T20:00:40Z"),
    ],
  });

  // Answers `gh api <endpoint> [--jq <filter>]` from the scenario, and 404 (exit 1, like gh) for
  // anything it does not hold. The artifact listing filters by exact name, as the API does.
  const FAKE_GH = `
const [command, endpoint, ...rest] = process.argv.slice(2);
const filter = rest[0] === "--jq" ? rest[1] : undefined;
if (command !== "api" || (rest.length !== 0 && filter === undefined) || rest.length > 2) {
  console.error("fake gh: unexpected call: " + process.argv.slice(2).join(" "));
  process.exit(2);
}
const scenario = await Bun.file(process.env.FAKE_GH_SCENARIO).json();
const url = new URL(endpoint, "https://api.github.com/");
const path = decodeURIComponent(url.pathname.slice(1));
const repo = "repos/${REPO}";
let body;
let match;
if (path.startsWith(repo + "/contents/")) {
  const sha = scenario.blobs[path.slice(repo.length + 10) + "@" + url.searchParams.get("ref")];
  if (sha) body = { sha };
} else if ((match = path.match(new RegExp("^" + repo + "/git/commits/(\\\\w+)$")))) {
  const tree = scenario.commits[match[1]];
  if (tree) body = { sha: match[1], tree: { sha: tree } };
} else if (path === repo + "/actions/artifacts") {
  body = {
    artifacts: scenario.artifacts
      .filter((a) => a.name === url.searchParams.get("name"))
      .map((a) => ({ name: a.name, expired: a.expired, created_at: a.created_at, workflow_run: { id: a.run } })),
  };
} else if ((match = path.match(new RegExp("^" + repo + "/actions/runs/(\\\\d+)$")))) {
  const run = scenario.runs[match[1]];
  if (run) body = { id: Number(match[1]), path: run.path, event: run.event, status: run.status, conclusion: run.conclusion, head_sha: run.head_sha };
} else if ((match = path.match(new RegExp("^" + repo + "/actions/runs/(\\\\d+)/jobs$")))) {
  const run = scenario.runs[match[1]];
  if (run) body = { total_count: run.jobs.length, jobs: run.jobs };
}
if (body === undefined) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (filter === undefined) {
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}
const jq = Bun.spawnSync(["jq", "-r", filter], { stdin: new TextEncoder().encode(JSON.stringify(body)) });
process.stdout.write(jq.stdout);
process.stderr.write(jq.stderr);
process.exit(jq.exitCode);
`;
  const bin = scratchDir();
  writeFileSync(join(bin, "fake-gh.ts"), FAKE_GH);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-gh.ts")}" "$@"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  const fakeEnv = (scenario: Scenario, dir: string) => {
    const file = join(dir, "scenario.json");
    writeFileSync(file, JSON.stringify(scenario));
    return {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GH_SCENARIO: file,
      GH_TOKEN: "fake",
    };
  };
  const varIn = (step: Step | undefined, expr: RegExp) =>
    Object.entries(step?.env ?? {}).find(([, value]) => expr.test(value))?.[0];

  // The marker job's script for the merge commit `github.sha` names, and the artifact name its upload
  // step builds from what the script wrote and from the `workflow` input the caller passes.
  const markFor = (scenario: Scenario, sha: string) => {
    const dir = scratchDir();
    const githubOutput = join(dir, "out");
    writeFileSync(githubOutput, "");
    const result = runStep(
      readStep?.run ?? "exit 9",
      {
        ...fakeEnv(scenario, dir),
        GITHUB_OUTPUT: githubOutput,
        [varIn(readStep, /^\$\{\{\s*github\.sha\s*\}\}$/) ?? "_"]: sha,
        [varIn(readStep, /github\.repository\b/) ?? "_"]: REPO,
      },
      dir,
    );
    const name = String(uploadStep?.with?.name ?? "").replace(
      /\$\{\{\s*inputs\.workflow\s*\}\}/g,
      caller.name,
    );
    const placeholders = [
      ...name.matchAll(/\$\{\{\s*needs\.tree\.outputs\.(\w+)\s*\}\}/g),
    ];
    expect(placeholders).toHaveLength(1);
    const written = Bun.spawnSync(["cat", githubOutput]).stdout.toString();
    const value = written.match(
      new RegExp(`^${placeholders[0]?.[1]}=(.*)$`, "m"),
    )?.[1];
    return {
      exit: result.exit,
      name:
        value === undefined
          ? undefined
          : name.replace(placeholders[0]?.[0] ?? "", value),
    };
  };

  const scenarioBase = (): Scenario => ({
    tree: TREE,
    commits: { [MERGE]: TREE },
    blobs: Object.fromEntries(
      FILES.flatMap((f) => [
        [`${f}@${SHA}`, BLOB],
        [`${f}@${HEAD}`, BLOB],
      ]),
    ),
    artifacts: [],
    runs: { "7": greenRun() },
  });
  let MARKER = "";
  beforeAll(() => {
    const marked = markFor(scenarioBase(), MERGE);
    expect(marked.exit).toBe(0);
    MARKER = marked.name ?? "";
  });
  const valid = (): Scenario => ({
    ...scenarioBase(),
    artifacts: [{ name: MARKER, expired: false, run: 7, created_at: MARKED }],
  });

  test("the marker names the workflow and the tree the API gives for the tested merge commit, and no tree at all on an error", () => {
    expect(MARKER).toBe(`tested-${caller.name}-${TREE}`);
    const failed = markFor({ ...scenarioBase(), commits: {} }, MERGE);
    expect(failed.exit).not.toBe(0);
    expect(failed.name).toBeUndefined();
  });

  const skips = (scenario: Scenario) => {
    const dir = scratchDir();
    const output = join(dir, "out");
    writeFileSync(output, "");
    const result = runStep(
      lookStep?.run ?? "exit 9",
      {
        ...fakeEnv(scenario, dir),
        GITHUB_OUTPUT: output,
        [varIn(lookStep, /github\.event\.head_commit\.tree_id/) ?? "_"]:
          scenario.tree,
        [varIn(lookStep, /^\$\{\{\s*github\.sha\s*\}\}$/) ?? "_"]: SHA,
        [varIn(lookStep, /github\.repository\b/) ?? "_"]: REPO,
        [varIn(lookStep, /inputs\.workflow\b/) ?? "_"]: caller.name,
        [varIn(lookStep, /inputs\.suites\b/) ?? "_"]: caller.prefix,
      },
      ROOT,
    );
    expect(result.output).not.toContain("fake gh: unexpected call");
    const written = Bun.spawnSync(["cat", output]).stdout.toString();
    return written.match(/^skip=(.*)$/m)?.[1] === "true";
  };

  test("reads the push's tree, its commit, the repository and the caller's inputs from the step's env", () => {
    expect(
      varIn(lookStep, /github\.event\.head_commit\.tree_id/),
    ).toBeDefined();
    expect(varIn(lookStep, /^\$\{\{\s*github\.sha\s*\}\}$/)).toBeDefined();
    expect(varIn(lookStep, /github\.repository\b/)).toBeDefined();
    expect(varIn(lookStep, /inputs\.workflow\b/)).toBeDefined();
    expect(varIn(lookStep, /inputs\.suites\b/)).toBeDefined();
  });

  test("a marker for this tree from a green pull request run of this workflow skips", () => {
    expect(skips(valid())).toBe(true);
  });

  test("a bad candidate is passed over, not taken as the answer", () => {
    const scenario = valid();
    scenario.artifacts.unshift({
      name: MARKER,
      expired: false,
      run: 6,
      created_at: MARKED,
    });
    scenario.runs["6"] = { ...greenRun(), conclusion: "failure" };
    expect(skips(scenario)).toBe(true);
  });

  test("a marker another workflow uploaded for the same tree does not count", () => {
    const scenario = valid();
    scenario.artifacts[0] = {
      name: `tested-other-${TREE}`,
      expired: false,
      run: 7,
      created_at: MARKED,
    };
    expect(skips(scenario)).toBe(false);
  });

  const runWith = (change: Partial<Run>) => (s: Scenario) => {
    s.runs["7"] = { ...greenRun(), ...change };
  };
  const jobWith =
    (name: string, change: Partial<RunJob>) =>
    (s: Scenario): void => {
      const run = s.runs["7"] as Run;
      run.jobs = run.jobs.map((job) =>
        job.name === name ? { ...job, ...change } : job,
      );
    };
  const withoutJob = (name: string) => (s: Scenario) => {
    const run = s.runs["7"] as Run;
    run.jobs = run.jobs.filter((job) => job.name !== name);
  };
  // Each piece of work in turn, so every shard is checked on its own.
  const eachWork = (
    label: string,
    change: Partial<RunJob>,
  ): [string, (s: Scenario) => void][] =>
    workNames.map((name) => [`${label} (${name})`, jobWith(name, change)]);

  test.each<[string, (s: Scenario) => void]>([
    [
      "no marker at all",
      (s) => {
        s.artifacts = [];
      },
    ],
    [
      "a marker for another tree",
      (s) => {
        s.tree = "a".repeat(40);
      },
    ],
    [
      "an expired marker",
      (s) => {
        (s.artifacts[0] as Scenario["artifacts"][0]).expired = true;
      },
    ],
    ["a failed run", runWith({ conclusion: "failure" })],
    ["a cancelled run", runWith({ conclusion: "cancelled" })],
    [
      "a run still in progress",
      runWith({ status: "in_progress", conclusion: null }),
    ],
    [
      "a run of another workflow",
      runWith({ path: ".github/workflows/other.yml" }),
    ],
    ["a run of a push, not a pull request", runWith({ event: "push" })],
    ...FILES.map((file): [string, (s: Scenario) => void] => [
      `a run whose ${file} is another blob`,
      (s) => {
        s.blobs[`${file}@${HEAD}`] = "f".repeat(40);
      },
    ]),
    ...FILES.map((file): [string, (s: Scenario) => void] => [
      `a run whose head lacks ${file}`,
      (s) => {
        delete s.blobs[`${file}@${HEAD}`];
      },
    ]),
    ...eachWork("work that failed", { conclusion: "failure" }),
    ...eachWork("work that was skipped", { conclusion: "skipped" }),
    ...eachWork("work that has not finished", {
      status: "in_progress",
      conclusion: null,
      completed_at: null,
    }),
    ...eachWork("a marker created before the work finished", {
      completed_at: "2026-10-21T20:01:00Z",
    }),
    // The shards are not each demanded by name: the workflow file at the run's head is byte for byte
    // the one on main, so the matrix is the same, and a shard that was never created cannot happen
    // without the file differing. What must hold is that SOME work is listed.
    [
      "a run that lists no work at all",
      (s) => {
        const run = s.runs["7"] as Run;
        run.jobs = run.jobs.filter((job) => !workNames.includes(job.name));
      },
    ],
    [
      `a run whose ${MARK_JOB(TREE)} failed`,
      jobWith(MARK_JOB(TREE), { conclusion: "failure" }),
    ],
    [`a run that does not list ${MARK_JOB(TREE)}`, withoutJob(MARK_JOB(TREE))],
    [
      "a forged artifact in a run whose mark job names another tree",
      (s) => {
        jobWith(MARK_JOB(TREE), { name: MARK_JOB("a".repeat(40)) })(s);
      },
    ],
    [
      "a run that lists no job",
      (s) => {
        (s.runs["7"] as Run).jobs = [];
      },
    ],
    [
      "a push with no head_commit",
      (s) => {
        s.tree = "";
      },
    ],
    [
      "an API error",
      (s) => {
        s.runs = {};
      },
    ],
  ])("does not skip on %s", (_, change) => {
    const scenario = valid();
    change(scenario);
    expect(skips(scenario)).toBe(false);
  });
});
