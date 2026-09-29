import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codeOnly, withoutComments } from "../utils/source-text";

// A `ClaimedJob` built by hand is a FIXTURE, and its id must be INCAPABLE of naming a row: `jobRetired`
// (src/modules/scheduler/service.ts) looks the id up for a tombstone, and an id the sequence can hand
// out (1, 2, 9) may name a real row, so a retire plants a tombstone under the fixture and the handler
// stands down without posting. Only CI's `RESTART IDENTITY` shows it. Use an id burned from the
// sequence (`burnSchedulerJobId`, tests/utils/scheduler.ts) or one it cannot reach.

// Not in tests/tooling/: that directory is dropped from both derived repos
// (tooling/derivation/manifest.ts) while these fixtures ship to all three, and a master-only sweep
// cannot fail the public repo's CI, where a contributor's fixture arrives.
const ROOT = join(import.meta.dir, "..");

// `id` GIVEN a number, in every spelling that reaches the same value: a property (`id: 1n`), a
// default parameter (`id = 1n`), a quoted key, a typed default (`id: bigint = 1n`, the annotation
// read as "whatever is not the operator", up to one line), a parenthesised value, every numeric base
// and separator, either sign, and every argument `BigInt` accepts (`BigInt("1")`, `BigInt(1e3)`).
// The bound: this reads LITERALS. An id computed at run time is out of reach of any text sweep, and
// is exactly what `burnSchedulerJobId` produces, so the blind spot and the fix are the same thing.
const NUMBER = String.raw`[+-]?\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?|[+-]?0[xX][\dA-Fa-f_]+|[+-]?0[oO][0-7_]+|[+-]?0[bB][01_]+`;
const LITERAL_ID = new RegExp(
  String.raw`(?:\bid|["']id["'])(?:\s*:\s*[^=;,)\n]{1,80})?\s*[:=]\s*\(?\s*(?:(${NUMBER})n|BigInt\(\s*["'\`]?\s*(${NUMBER})n?\s*["'\`]?\s*\))`,
  "g",
);

// What tells a `ClaimedJob` literal from any object with an `id`: `claimSeq`, a required field
// nothing else carries. Not `kind` (`resolveByModelName` answers `{ kind: "one", id }`, seven false
// alarms in namespace-resolve.test.ts), and not the file's import (terminal-failure-announces.test.ts
// hands a handler a job literal without naming the type). An annotation OF A VALUE (`: ClaimedJob =`,
// `satisfies`, `as`) also marks one, since `claimSeq` can arrive by an imported spread; the import
// and a parameter's annotation do not, as they name a job the code is handed, not one written here.
// A window rather than a parser, pinned from both sides below, because an unmeasured window quietly
// grows to "the whole file" or shrinks to "the same line".
const NEARBY = 14;
// The FIELD NAME, not one punctuation of it: `claimSeq: 0`, the shorthand `claimSeq,` a local
// variable produces, `"claimSeq": 0` in a JSON-shaped literal and `row.claimSeq` in the line
// that fills it are all the same signal, and a marker spelled with a colon sees only the first.
const MARKERS = /\bclaimSeq\b/g;
// Asked of the code, so `note: "claimSeq"` and the SQL alias `claim_seq AS "claimSeq"` (which
// src/modules/scheduler/service.ts writes for real) are data rather than a job. That strip also
// blanks a quoted KEY, which is a spelling of the field and not data, so the key is asked for
// separately and by its shape: quoted, then a colon. Its opening quote must itself be code, or the
// JSON inside a string (`const raw = '{"claimSeq":0}'`) would answer for a fixture that is not
// there.
const QUOTED_MARKER = /["']claimSeq["']\s*:/g;
// An annotation over a literal WRITTEN AT THAT POINT: `= {`, `= [`, `=> ({`, `<ClaimedJob>{`, or a
// `satisfies`/`as` after a literal's closing bracket. The TYPE side is read as whatever is not the
// operator, a rule rather than a list, because a type expression is a language and a literal is a
// brace; the LITERAL side stays strict. That tells `({…}) as unknown as ClaimedJob` (a fixture) from
// `claimed.find(…) as ClaimedJob` (a found row). An annotation with no literal (`job: ClaimedJob`, a
// return type, `Promise<ClaimedJob>`) says nothing about where the literal is, so a job whose only
// mention is its factory's return type is out of reach: a blind corner, asserted below.
const TYPE_MARKER =
  /(?::\s*[^=;{}\n]*\bClaimedJob\b[^=;{}\n]*=\s*\(?\s*|:\s*ClaimedJob(?:\[\])?\s*=>\s*\(\s*|(?<![\w$])<\s*ClaimedJob\s*>\s*)[[{]|[}\]]\s*\)?\s*(?:(?:as|satisfies)\s+(?:unknown|const|readonly)\s+)*(?:as|satisfies)\s+ClaimedJob\b/g;

// A sequence starts at 1 and only ever climbs, so 0 and negatives are unreachable by construction,
// which is what a fixture needs and the reason this is a sign test rather than a ban on literals.
// `Number` reads every base the pattern above admits once the separators are gone, and answers NaN
// for what it cannot read, which is not a positive number either.
function reachableBySequence(value: string): boolean {
  // The leading `+` goes because `Number("+0x1")` is NaN while `BigInt(+0x1)` is `1n`, and a sweep
  // that reads a reachable id as unreadable calls it safe. The leading `-` STAYS, for the same
  // arithmetic in the other direction: `Number("-0x1")` is NaN, and a negative id is unreachable
  // anyway, so the NaN and the sign agree.
  return Number(value.replace(/_/g, "").replace(/^\+/, "")) > 0;
}

export function fixtureIdHits(source: string): number[] {
  // Prose that NAMES the shape is not the shape. A comment explaining what a fixture used to spell
  // sits within the window of the fixture it explains, so a raw scan turns documentation into a red
  // sweep, and the cheap way out of that is deleting the sentence that explained the trap. The strip
  // preserves offsets, so the line numbers below still name the line the reader will open. Comments
  // only, not string bodies: a quoted key (`"id": 1n`) is code, and this pattern reads it.
  const src = withoutComments(source);
  // The same source with string BODIES blanked too, offsets intact. It is not what the pattern runs
  // over, because half of what the pattern reads is legitimately inside quotes: a quoted key
  // (`"id": 1n`) and a stringified argument (`BigInt("7")`) are both real spellings of a fixture.
  // What it answers is one question, about the FIRST character of the match: a match that STARTS
  // inside a string body is text that spells a fixture (`payload: "id: 1n"`), not one.
  const code = codeOnly(source);
  const lineOf = (at: number) => src.slice(0, at).split("\n").length;
  // Every line carrying the field, gathered once. `MARKERS` reads the blanked copy, so a word in
  // string data never counts; `QUOTED_MARKER` reads the unblanked one for the key spelling that
  // blanking would erase, and answers only where its own opening quote survived the blanking.
  const markerLines = new Set<number>();
  for (const m of code.matchAll(MARKERS)) markerLines.add(lineOf(m.index));
  for (const m of code.matchAll(TYPE_MARKER)) markerLines.add(lineOf(m.index));
  for (const m of src.matchAll(QUOTED_MARKER))
    if (code[m.index] === src[m.index]) markerLines.add(lineOf(m.index));

  const hits: number[] = [];
  for (const m of src.matchAll(LITERAL_ID)) {
    const value = m[1] ?? m[2];
    if (!value || !reachableBySequence(value)) continue;
    if (m.index === undefined || code[m.index] !== src[m.index]) continue;
    const line = lineOf(m.index);
    const marked = [...markerLines].some(
      (l) => l >= line - NEARBY && l <= line + NEARBY,
    );
    if (!marked) continue;
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

// Untyped on purpose: the annotation is a marker of its own, so a sample carrying it would be marked
// no matter what the `claimSeq` rows below are trying to measure.
const fixture = (id: string, gap = 1) =>
  [
    "  const job = {",
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
    ["a BigInt() call over a template", fixture("BigInt(`7`)"), true],
    // `BigInt(" 1 ")` is `1n`: the quotes are trimmed before the number is read.
    ["a BigInt() call over a padded string", fixture('BigInt(" 7 ")'), true],
    ["a BigInt() call over a signed number", fixture("BigInt(+7)"), true],
    ["a BigInt() call over a signed string", fixture('BigInt("+7")'), true],
    // `Number("+0x1")` is NaN while `BigInt(+0x1)` is `1n`, so the sign has to come off before the
    // arithmetic or a reachable id reads as unreadable, and unreadable reads as safe.
    ["a BigInt() call over a signed hex", fixture("BigInt(+0x7)"), true],
    // NOTE: BigInt over a bigint is the identity, and the `n` must not end the match before the `)`.
    ["a BigInt() call over a bigint", fixture("BigInt(7n)"), true],
    // Neither is a bigint literal, and both are what BigInt turns into one.
    ["a BigInt() call over an exponent", fixture("BigInt(1e3)"), true],
    ["a separator inside the exponent", fixture("BigInt(1e1_0)"), true],
    ["a BigInt() call over a whole float", fixture("BigInt(1.0)"), true],
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
    // The annotation sits between the name and the operator, which is where a pattern reading
    // "name, then operator, then number" stops.
    [
      "a typed default parameter",
      "function job(id: bigint = 1n) {\n  claimSeq: 0;",
      true,
    ],
    ["a parenthesised value", fixture("(7n)"), true],
    // The annotation is a marker in its own right, because a fixture can take its claim token from
    // a spread whose source is imported, and then no `claimSeq` is written anywhere near the id.
    [
      "a spread fixture named by its type",
      "  const job: ClaimedJob = { id: 1n, ...baseJob };",
      true,
    ],
    // The angle-bracket assertion is the same annotation written in front of the literal. Nothing in
    // this tree spells one, and it costs one alternative to read, plus the lookbehind that keeps it
    // from reading the `<ClaimedJob>` inside `Promise<ClaimedJob> {`, where the brace is a body.
    [
      "an angle-bracket assertion",
      "  const job = <ClaimedJob>{ id: 1n, ...baseJob };",
      true,
    ],
    [
      "a spread fixture named by satisfies",
      "  const job = { id: 1n, ...baseJob } satisfies ClaimedJob;",
      true,
    ],
    // Both spellings the tree actually uses, and they differ by what sits before the `as`.
    [
      "a literal cast through unknown",
      "  const job = ({ id: 1n, ...b }) as unknown as ClaimedJob;",
      true,
    ],
    [
      "a literal asserted const",
      "  const job = { id: 1n, ...b } as const satisfies ClaimedJob;",
      true,
    ],
    // NOTE: Written as a repetition rather than as the list those two would start, so a third bridge
    // needs no new alternative.
    [
      "a literal behind two bridges",
      "  const job = { id: 1n, ...b } as const as unknown as ClaimedJob;",
      true,
    ],
    [
      "a cast of a row that was found",
      "  const mine = claimed.find((j) => j.id === id) as ClaimedJob;\n  const m = { id: 1n };",
      false,
    ],
    [
      "an annotated array",
      "  const jobs: ClaimedJob[] = [{ id: 1n, ...b }];",
      true,
    ],
    // The type side is a language, so it is read as a rule rather than as a list of its spellings.
    [
      "a generic-array annotation",
      "  const jobs: Array<ClaimedJob> = [{ id: 1n, ...b }];",
      true,
    ],
    [
      "a union annotation over a literal",
      "  const job: ClaimedJob | undefined = { id: 1n, ...b };",
      true,
    ],
    // A parenthesised initializer is still an initializer, and `= (` cannot open a body.
    [
      "a parenthesised initializer",
      "  const job: ClaimedJob = ({ ...baseJob, id: 1n });",
      true,
    ],
    // The literal side stays strict, and this is what that buys: a function TAKING a job and
    // returning some other object is not a fixture, however its parameter is typed.
    [
      "an arrow that takes a job and returns something else",
      "  const f = (j: ClaimedJob) => ({ id: 7n });",
      false,
    ],
    // The arrow with an expression body is the one return type that DOES say where the literal is:
    // it is the next thing after the annotation.
    [
      "an arrow factory returning a literal",
      "  const jobFor = (): ClaimedJob => ({ id: 1n, ...baseJob });",
      true,
    ],
    // The other side of that: a return type says what the function produces, not where the literal
    // is, so these are the sweep's stated blind corner rather than a case it means to catch.
    [
      "a declared factory's return type",
      "  function jobFor(): ClaimedJob {\n    return { id: 1n, ...baseJob };",
      false,
    ],
    [
      "an arrow factory with a block body",
      "  const jobFor = (): ClaimedJob => {\n    return { id: 1n, ...baseJob };",
      false,
    ],
    [
      "an async factory's wrapped return type",
      "  async function jobFor(): Promise<ClaimedJob> {\n    return { id: 1n, ...baseJob };",
      false,
    ],
    // A defaulted parameter is still a parameter: the value is somebody else's, and the id below
    // belongs to another object.
    [
      "a defaulted parameter",
      "  function inspect(job: ClaimedJob = defaultJob) {\n    const tenant = { id: 7n };",
      false,
    ],
    // A job the function is HANDED is not a job written here, and the id below belongs to a tenant.
    [
      "a parameter annotation",
      "  function inspect(job: ClaimedJob) {\n    const tenant = { id: 7n };",
      false,
    ],
    // The import is not an annotation, and it sits at the top of every file that has one.
    [
      "an import of the type",
      'import type { ClaimedJob } from "@/modules/scheduler/service";\n  const msg = { id: 5n };',
      false,
    ],
    // The annotation is whatever is not the operator: an indexed access and a union both read the
    // same way, and both are how a factory declares the id it defaults.
    [
      "an indexed-access annotation",
      'function job(id: ClaimedJob["id"] = 1n) {\n  claimSeq: 0;',
      true,
    ],
    [
      "a union annotation",
      "function job(id: bigint | undefined = 1n) {\n  claimSeq: 0;",
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
    ["an id with no claimSeq", "  const msg = { id: 5n, kind: 'one' };", false],
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

  // NOTE: The marker's own spellings. A fixture whose `claimSeq` comes from a local variable is written
  // as shorthand, and a JSON-shaped one quotes its keys: both are the same field, and a marker that
  // demanded a colon would read them as no job at all.
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
  // The marker has the same two sides as the id. `claimSeq` inside string DATA is not a field, and
  // the case is not hypothetical: src/modules/scheduler/service.ts aliases a column as "claimSeq" in
  // a raw query, and a test doing the same beside any id literal would fail the whole tree.
  test("the marker inside string data is not the field", () => {
    const src = [
      '  const rows = await suDb.$queryRaw`SELECT claim_seq AS "claimSeq"`;',
      "  const msg = { id: 7n, note: 'oi' };",
    ].join("\n");
    expect(fixtureIdHits(src)).toEqual([]);
  });

  // And JSON inside a string is not a key. The quoted spelling is admitted by SHAPE, so the only
  // thing separating `"claimSeq": 0` from `'{"claimSeq":0}'` is whether the opening quote is code.
  test("a quoted marker inside a string is not the field", () => {
    const src = [
      "  const raw = '{\"claimSeq\":0}';",
      "  const msg = { id: 7n, note: 'oi' };",
    ].join("\n");
    expect(fixtureIdHits(src)).toEqual([]);
  });

  // Neither is a string that spells one. A payload or an expected message can carry the shape as
  // DATA, and a sweep that reads it as code fails the tree over somebody's fixture text, which is
  // the same red-for-nothing that a comment produces.
  test("a string that spells a fixture is not a fixture", () => {
    const src = [
      "  const job: ClaimedJob = {",
      "    id: phantomJobId,",
      '    payload: { note: "id: 1n" },',
      "    claimSeq: 0,",
      "  };",
    ].join("\n");
    expect(fixtureIdHits(src)).toEqual([]);
  });

  // Prose about a fixture is not a fixture. The comment that explains what a line used to spell sits
  // inside the window of the line it explains, so a sweep reading raw text turns the explanation into
  // a red CI, and the cheapest way to green is deleting the explanation.
  test("a comment naming the old spelling is not a fixture", () => {
    const src = [
      "  const job: ClaimedJob = {",
      "    // was id: 1n, which the sequence hands out",
      "    id: phantomJobId,",
      "    claimSeq: 0,",
      "  };",
    ].join("\n");
    expect(fixtureIdHits(src)).toEqual([]);
  });

  test("a claim in the neighbourhood is not the field", () => {
    const src = [
      "  const [claimed] = await claimDueJobs(1, appDb, new Date(), tenantId);",
      "  const msg = { id: 7n, content: 'oi' };",
    ].join("\n");
    expect(fixtureIdHits(src)).toEqual([]);
  });
});
