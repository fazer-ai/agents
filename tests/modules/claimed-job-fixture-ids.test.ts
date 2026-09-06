import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A `ClaimedJob` built by hand in a test is a FIXTURE, not a row: the handler only ever reads it
// back. `jobRetired` (modules/scheduler/service.ts) looks the id up to find the tombstone a `/reset`
// or a supersede leaves behind, and an id nobody holds answers "not retired", which is the benign
// branch every one of these fixtures is written for.
//
// It stops being benign the moment the id names a row, because `scheduler_jobs_id_seq` hands out
// exactly the numbers these fixtures spell: 1, 2, 9. The file's own `schedulerJob.create` takes id 1
// whenever it is the first in the DATABASE to insert one, and a file that then retires that row (a
// `retireJobsByDedupeKey` bumps `claim_seq`) has planted a tombstone under its own fixture. From
// there the handler stands down without posting and every assertion about what should have been sent
// fails with `Expected: 1, Received: 0`.
//
// Measured on this branch, in the real path: a cold sequence handed id 1 to an insert, a fixture
// spelling `id: 1n` answered `jobRetired` false, `retireJobsByDedupeKey` retired that row, and the
// same fixture then answered true. A fixture holding a burned id answered false on both sides.
// Measured earlier, by #498, as five failures in `followup-resolved-guardrails.test.ts` under
// `TRUNCATE scheduler_jobs RESTART IDENTITY`. No local run reproduced those, because a development
// database has a warm sequence, and CI only showed them once two new files in #400 reshuffled the
// shards and put the victim first.
//
// So the rule is not "these files are broken" (most are not, today). It is that a fixture must be
// INCAPABLE of naming a row, in any order, on any shard, and the only ways to be sure are an id
// burned from the sequence (`burnSchedulerJobId`, tests/utils/scheduler.ts) or a number the sequence
// cannot reach.
//
// It sits here rather than beside the other static sweeps in tests/tooling/ because that directory
// is dropped from BOTH derived repos (tooling/derivation/manifest.ts) while the fixtures it reads
// ship to all three. A sweep that only runs in the master cannot fail the public repo's CI, which
// is where a contributor's fixture arrives.
const ROOT = join(import.meta.dir, "..");

// `id` GIVEN a number, in every spelling that reaches the same value, because the sweep is only as
// good as the grammar it admits and a fixture is written by whoever writes it next:
//
//   - both operators that hand a fixture its id: a property (`id: 1n`) and a default parameter
//     (`function jobFor(p, id = 1n)`), which is how chatwoot-recover-delivery.test.ts spelled it and
//     how a property-only sweep missed that file for a whole round;
//   - a quoted key (`"id": 1n`), which a JSON-shaped literal carries;
//   - every numeric base plus separators (`0x1n`, `0o7n`, `0b11n`, `1_000n`), all of which a
//     decimal-only pattern reads as absent;
//   - `BigInt(1)` and `BigInt("1")`, the constructor's two argument forms.
//
// `reachableBySequence` normalises what is captured, so the grammar lives here and the arithmetic
// lives there.
// Every base a bigint literal takes, plus the separator, normalised by `reachableBySequence` below.
const NUMBER = String.raw`-?\d[\d_]*|0[xX][\dA-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+`;
const LITERAL_ID = new RegExp(
  String.raw`(?:\bid|["']id["'])\s*[:=]\s*(?:(${NUMBER})n|BigInt\(\s*["']?(${NUMBER})["']?\s*\))`,
  "g",
);

// What tells a `ClaimedJob` literal from every other object with an `id`: `claimSeq`, a required
// field of the type that nothing else in the tree carries. Deliberately NOT `kind`, and not a
// "does this file import ClaimedJob" gate:
//
//   - `kind` is somebody else's field name too. Measured: `resolveByModelName` answers
//     `{ kind: "one", id }`, so namespace-resolve.test.ts's seven `{ id: 1n, name }` rows come back
//     as job fixtures under a `kind` marker, and a sweep with seven false alarms is one that gets
//     an exclusion list and then gets ignored.
//   - the file's import is not the fixture. terminal-failure-announces.test.ts hands the RAG_INGEST
//     handler a job-shaped literal without ever naming the type, and a gate on the name reads that
//     file as having no fixtures at all. It is safe today only because its id is `0n`.
//
// A window rather than a parser, and its reach is pinned from both sides below, because a window
// nobody measures is one that quietly grows to "the whole file" or shrinks to "the same line".
const NEARBY = 14;
// The FIELD NAME, not one punctuation of it: `claimSeq: 0`, the shorthand `claimSeq,` a local
// variable produces, `"claimSeq": 0` in a JSON-shaped literal and `row.claimSeq` in the line
// that fills it are all the same signal, and a marker spelled with a colon sees only the first.
const MARKERS = /\bclaimSeq\b/;

// A sequence starts at 1 and only ever climbs, so 0 and negatives are unreachable by construction,
// which is what a fixture needs and the reason this is a sign test rather than a ban on literals.
// `Number` reads every base the pattern above admits once the separators are gone, and answers NaN
// for what it cannot read, which is not a positive number either.
function reachableBySequence(value: string): boolean {
  return Number(value.replace(/_/g, "")) > 0;
}

export function fixtureIdHits(src: string): number[] {
  const lines = src.split("\n");
  const hits: number[] = [];
  for (const m of src.matchAll(LITERAL_ID)) {
    const value = m[1] ?? m[2];
    if (!value || !reachableBySequence(value)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const window = lines
      .slice(Math.max(0, line - 1 - NEARBY), line + NEARBY)
      .join("\n");
    if (!MARKERS.test(window)) continue;
    hits.push(line);
  }
  return hits;
}

// Every TypeScript file under tests/, not only `*.test.ts`: a fixture builder moved into
// tests/utils/ is the same fixture, and a sweep that only reads test files is one a refactor walks
// out of without touching a line of the fixture.
export function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(p));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      out.push(p);
  }
  return out;
}

export function offendingFixtures(): string[] {
  const hits: string[] = [];
  for (const file of testFiles(ROOT)) {
    // The sweep's own samples are fixtures on purpose, and a sweep that flags itself can only be
    // silenced by weakening it.
    if (file.endsWith("claimed-job-fixture-ids.test.ts")) continue;
    const rel = file.slice(ROOT.length + 1);
    for (const line of fixtureIdHits(readFileSync(file, "utf8")))
      hits.push(`${rel}:${line}`);
  }
  return hits.sort();
}

const fixture = (id: string, gap = 1) =>
  [
    "  const job: ClaimedJob = {",
    `    id: ${id},`,
    ...Array.from({ length: gap - 1 }, () => "    // filler"),
    "    kind: 'FOLLOWUP',",
    "    claimSeq: 0,",
    "  };",
  ].join("\n");

const untyped = [
  "    const out = await handler({",
  "      id: 7n,",
  "      tenantId,",
  "      kind: 'RAG_INGEST',",
  "      claimSeq: 0,",
  "    });",
].join("\n");

describe("a scheduler fixture may not name a row the sequence can hand out", () => {
  test("no ClaimedJob literal carries an id a sequence reaches", () => {
    expect(offendingFixtures()).toEqual([]);
  });

  // Pinned because nothing in the tree exercises it today: every fixture currently sits in a test
  // file, so narrowing the sweep back to `*.test.ts` would break nothing and read as green. The
  // file it has to reach is the shared helper's own neighbourhood, tests/utils/.
  test("the sweep reads the helpers, not only the test files", () => {
    const swept = testFiles(ROOT);
    const helpers = swept.filter(
      (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
    );
    expect(helpers.length).toBeGreaterThan(0);
    // Built with `join`, not spelled with a separator: the paths come from `join` too, and a "/"
    // written here is a test that fails on the one platform whose separator is the other one.
    expect(helpers).toContain(join(ROOT, "utils", "scheduler.ts"));
  });

  // The sweep's own eyesight, pinned on synthetic sources rather than on the tree. Without this, a
  // sweep whose regex stopped matching or whose window collapsed would read as a clean tree, which
  // is the failure mode every static sweep has and the one that matters most here: the whole point
  // is to catch the NEXT file, and a green tree tells you nothing about whether it still can.
  test.each([
    ["a bigint literal", fixture("7n"), true],
    ["a BigInt() call", fixture("BigInt(7)"), true],
    ["a BigInt() call over a string", fixture('BigInt("7")'), true],
    // Every base and the separator, because they all reach the same 7 and a decimal-only pattern
    // reads each of them as no id at all.
    ["a hex literal", fixture("0x7n"), true],
    ["an octal literal", fixture("0o7n"), true],
    ["a binary literal", fixture("0b111n"), true],
    ["digit separators", fixture("1_000n"), true],
    ["a quoted key", fixture("7n").replace("id:", '"id":'), true],
    // The sign test is about the VALUE, so it has to survive the spelling too.
    ["a hex zero", fixture("0x0n"), false],
    [
      "a default parameter",
      "function jobFor(p: object, id = 1n) {\n  claimSeq: 0;",
      true,
    ],
    ["a marker ten lines off", fixture("7n", 10), true],
    // The shape is the fixture, whether or not the file ever names the type. This is
    // terminal-failure-announces.test.ts, which hands a handler a job literal and imports nothing.
    ["a fixture that never names the type", untyped, true],
    // Zero and negatives are what a DB-free fixture is allowed to keep: no sequence produces them.
    ["zero", fixture("0n"), false],
    ["a negative", fixture("-1n"), false],
    // An object with an `id` and no `claimSeq` is a message, a contact, a row read back from a
    // create. None of those are the fixture this is about.
    [
      "an id with no claimSeq",
      "  const job: ClaimedJob = {};\n  const msg = { id: 5n, kind: 'one' };",
      false,
    ],
    // Forty lines from the marker is not one object literal, and treating it as one would flag every
    // id in every file that happens to mention a job somewhere.
    ["a marker forty lines off", fixture("7n", 40), false],
  ])("sees %s: %p", (_name, src, expected) => {
    expect(fixtureIdHits(src as string).length > 0).toBe(expected);
  });

  // `kind` is the marker this sweep deliberately does not use, pinned so that adding it back is a
  // failing test rather than seven false alarms in namespace-resolve.test.ts.
  test("kind alone is somebody else's field, and does not make a fixture", () => {
    const src = [
      "  const rows = [",
      "    { id: 1n, name: 'Foo' },",
      "  ];",
      "  expect(resolveByModelName(rows, 'Foo')).toEqual({ kind: 'one', id: 1n });",
    ].join("\n");
    expect(fixtureIdHits(src)).toEqual([]);
  });

  // The marker's own spellings. A fixture whose `claimSeq` comes from a local variable is written as
  // shorthand, and a JSON-shaped one quotes its keys: both are the same field, and a marker that
  // demanded a colon read them as no job at all.
  test.each([
    ["a property", "    claimSeq: 0,"],
    ["shorthand", "    claimSeq,"],
    ["a quoted key", '    "claimSeq": 0,'],
    ["a value read off a row", "    claimSeq: row.claimSeq,"],
  ])("recognises claimSeq written as %s", (_name, line) => {
    const src = ["  const job = {", "    id: 7n,", line, "  };"].join("\n");
    expect(fixtureIdHits(src)).toEqual([2]);
  });

  // The whole word, not a prefix of it: `claimDueJobs`, `claimed` and `claimOf` sit beside every real
  // row in the scheduler tests, and a marker matching "claim" would call each of those rows a
  // fixture.
  test("a claim in the neighbourhood is not the field", () => {
    const src = [
      "  const [claimed] = await claimDueJobs(1, appDb, new Date(), tenantId);",
      "  const msg = { id: 7n, content: 'oi' };",
    ].join("\n");
    expect(fixtureIdHits(src)).toEqual([]);
  });
});
