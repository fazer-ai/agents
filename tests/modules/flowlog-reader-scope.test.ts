import { describe, expect, test } from "bun:test";

// EVERY TEST THAT READS THE FLOW LOG, AND WHAT SCOPES IT.
//
// `emitFlowEvent` is fire-and-forget by design (src/modules/flowlog/service.ts): the hot WhatsApp
// path must not pay write latency for six log lines. A test that asserts on those lines therefore
// has two obligations, and the readers honoured them unevenly (issue #258).
//
//   SCOPE  a reader filtered only by `tenantId` returns rows of whatever else ran in the file. Every
//          DB-backed test file seeds ONE tenant (`slug: <prefix>-${process.pid}`), so the tenant
//          fences the FILE and nothing inside it: the neighbour a reader answers with is another
//          test of the same file, never another file.
//   WAIT   even a correctly scoped reader can run before the row lands, because nothing awaits the
//          write.
//   CLEAR  a test that EMPTIES the table empties it of the rows that exist. A write the previous case
//          only scheduled lands after the DELETE, into a table this case believes it owns, and
//          `orderBy: { id: "asc" }` hands that row back FIRST (issue #375).
//
// This file guards all three, and the second only since #419. It used to say the second "cannot be
// read off the source", because "is there a wait" is a question about control flow, which was true
// of the wait it had. The wait was a POLL LOOP, and a loop is a shape rather than a name, so there
// was nothing to grep for. The observation underneath it was also right and is worth keeping: a poll
// is only correct when the assertion is that a line EXISTS, since polling for an absence just spends
// the timeout before answering the empty read it opened with.
//
// What changed is not the analysis, it is the wait. `flowLogRows` / `flowLogRow` / `flowLogCount`
// settle the scheduled writes and then read, which makes the obligation checkable the same way the
// third already was: by having ONE SPELLING. It also answers the objection rather than working
// around it, because a settle is exact in both directions where a poll could only do presence.
//
// The argument for spending that is that the comments this obligation was left to did not hold.
// chatwoot-command-dropped.test.ts polled for its `command` row and read its `route` row raw, three
// lines apart, under a comment explaining the hazard for the first one, and the raw read turned CI
// red on a branch touching no server file (#419). An obligation spelled out per site is one a new
// site is written without, which is the reason tests/utils/flowlog.ts gives for the clear helper
// existing at all.
//
// The third is checkable for the same reason: `clearFlowLog` (tests/utils/flowlog.ts) settles the
// scheduled writes and then deletes. A raw DELETE is the defect, so the guard is that there are no
// raw ones rather than a per-site judgement.
//
// WHAT IT DOES NOT COVER, said out loud rather than left to be discovered: 29 files end with a loop
// over a table list, `execution_logs` among the entries and the name interpolated into
// `DELETE FROM ${table}`, so the literal never sits next to the verb and no widening of the pattern
// below reaches it. Those are TEARDOWNS — nothing reads the table after them — so they cannot produce
// the failure this obligation is about. What they can produce is a log line arriving after its tenant
// was deleted, and that was measured on both sides rather than argued: ONE swallowed
// `execution_logs_tenant_id_fkey` per full-suite run, in 8 of 8 runs of the base, and converting all
// 29 loops to a settling helper left it at exactly one. A guard for them would be enforcing a rule
// with no measured effect, so this file does not pretend to have one.
//
// The ledger is per file with a count, following tests/lib/storable-write-sweep.test.ts: a NEW
// reader in an already-listed file trips this too, not only a new file. The classification is the
// point of the ledger. `tenant-wide` is a real answer for a reader whose subject is the TABLE rather
// than one turn's trail, and it is written down so it stays a decision instead of an omission.
//
// NOTE: the price of a ledger over the whole test tree is that ANY branch adding a reader anywhere
// has to touch this file, and it will find out from this test rather than from review. That is the
// intended cost — it is the same trade tests/lib/storable-write-sweep.test.ts makes over `src/` —
// but it has one edge the other does not: an entry in a file the derivation drops from an edition
// would make this red in that edition and green here. Every file listed below survives into both
// today, and a reader added inside a `@full-only` test file is the case to watch for.

type Reader = {
  /** 1-indexed line of the `executionLog.<method>(` that opens the call. */
  line: number;
  /** Top-level keys of the call's `where: { ... }`, in source order. */
  keys: string[];
  /** The `flowlog-scope:` marker above the call, when it declares something other than a turn. */
  marker: Scoping | null;
};

// The keys that name the row THIS test produced. `tenantId` is deliberately absent: it is the file's
// fence, and a reader that has only it is exactly the defect.
const TURN_KEYS = ["conversationId", "threadId", "turnId"];

// `agentId` is NOT one of them, and is accepted only where the ledger says the file's tests own an
// agent each. It names a row's agent, not its turn, so in a file where every test drives the same
// agent it fences nothing: `{ tenantId, agentId }` is the tenant filter with extra words.
const AGENT_KEY = "agentId";

/** Index of the closer matching the opener at `from`, or -1. */
function matchDelimiter(s: string, from: number, open: string, close: string) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === open) depth += 1;
    else if (s[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level (depth-0) comma split, so a nested object or template literal stays one part. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// The exemption is declared AT the reader, never at a position in the ledger. A per-file exemption
// travels to readers written later, and a per-INDEX one is worse than it looks: inserting a reader
// above an exempt one silently hands it the exemption, which is what the array version did when a
// `{ tenantId, stage }` reader was added at the top of guardrail-health and the suite stayed green.
// A marker on the call site moves with the call site.
const MARKER = /\/\/\s*flowlog-scope:\s*(turn|agent|seeded|tenant-wide)\b/;

// NOTE: the marker is looked for in the comment block IMMEDIATELY above the call — consecutive
// comment/blank lines and nothing else — so it cannot be inherited from a neighbouring reader's
// explanation several statements up.
function markerAbove(source: string, line: number): Scoping | null {
  const lines = source.split("\n");
  for (let i = line - 2; i >= 0; i--) {
    const text = (lines[i] ?? "").trim();
    if (text === "") continue;
    if (!text.startsWith("//") && !text.startsWith("*")) return null;
    const hit = MARKER.exec(text);
    if (hit) return hit[1] as Scoping;
  }
  return null;
}

// NOTE: written against the delimiters rather than as one regex on purpose. The first version of
// this scan matched `where` keys with `/(?:^|,|\{)\s*(\w+)\s*[,:}]/g`, which reads correctly and is
// wrong: `findall` cannot overlap, so the comma that ends one key is consumed and the key after it
// never matches. It reported `{ tenantId, stage, threadId }` as `[tenantId]` and put 21 readers on
// the list instead of 9 — a scan that is generous in the direction that creates work nobody needs.
export function flowlogReaders(source: string): Reader[] {
  const out: Reader[] = [];
  // Both spellings, because the WAIT obligation (#419) moved every reader onto `flowLogRows` and
  // friends and this scan would otherwise go blind on the day that landed, reporting a tree with no
  // readers at all as a tree with nothing to check. The helper takes the client and then the SAME
  // args object, so `where` still sits at the call site and everything below reads it unchanged;
  // that is why the helper passes its args through instead of wrapping them away.
  const call =
    /(?:executionLog\.(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy)|\bflowLog(?:Rows|Row|Count))\s*\(/g;
  for (const m of source.matchAll(call)) {
    const open = m.index + m[0].length - 1;
    const close = matchDelimiter(source, open, "(", ")");
    if (close < 0) continue;
    const args = source.slice(open, close + 1);
    const where = /where\s*:\s*\{/.exec(args);
    let keys: string[] = [];
    if (where) {
      const braceOpen = where.index + where[0].length - 1;
      const braceClose = matchDelimiter(args, braceOpen, "{", "}");
      if (braceClose > 0) {
        keys = splitTopLevel(args.slice(braceOpen + 1, braceClose)).map((p) =>
          (p.split(":")[0] ?? "").trim(),
        );
      }
    }
    const line = source.slice(0, m.index).split("\n").length;
    // Inside the call OR in the comment block above it. The first is what survives the formatter:
    // it moved a marker off `await suDb.executionLog.findFirst({` onto the `(` the wrapper opened,
    // and a marker the formatter can detach is a marker that silently stops applying.
    const inside = MARKER.exec(args);
    out.push({
      line,
      keys,
      marker: (inside?.[1] as Scoping | undefined) ?? markerAbove(source, line),
    });
  }
  return out;
}

//   turn        scoped to the row this test produced, by conversationId / threadId / turnId
//   agent       scoped to an agent this test owns, where every test in the file shares one tenant
//               but not one agent (playground-guardrails spells out why at the call site)
//   seeded      reads rows the test itself INSERTED with `executionLog.create`, awaited: there is no
//               emit in the path, so neither obligation applies
//   tenant-wide the subject is the table, not a turn. Scoping would defeat the assertion: the
//               retention sweep proves WHICH rows survived it, which only an exhaustive read of the
//               tenant can say. This entry USED to justify itself with "the file holds a single
//               test", which was true of one of the four files carrying it — the others hold 7, 18
//               and 23, and all four empty the table between cases. What makes it safe is the CLEAR
//               obligation above, not the file being short: a tenant-wide reader answers with
//               whatever is in the tenant, so it is exactly the reader that cannot survive a clear
//               that left a neighbour's row behind.
type Scoping = "turn" | "agent" | "seeded" | "tenant-wide";

export function isScoped(reader: Reader, scoping: Scoping): boolean {
  const allowed =
    scoping === "agent" ? [...TURN_KEYS, AGENT_KEY] : [...TURN_KEYS];
  return reader.keys.some((k) => allowed.includes(k));
}

const FLOWLOG_READERS: Record<string, number> = {
  "tests/graph/duplicate-tool-name-visible.test.ts": 1,
  "tests/graph/history-ceiling-turn.test.ts": 1,
  "tests/graph/nudge.test.ts": 3,
  "tests/graph/runtime.test.ts": 7,
  "tests/graph/side-effect-flowlog.test.ts": 1,
  "tests/graph/tool-flowlog.test.ts": 1,
  "tests/modules/chatwoot-command-dropped.test.ts": 2,
  "tests/modules/chatwoot-gate-trail.test.ts": 1,
  "tests/modules/chatwoot-inbox-remove.test.ts": 1,
  "tests/modules/chatwoot-recover-delivery.test.ts": 2,
  "tests/modules/chatwoot-unbound-inbox.test.ts": 1,
  "tests/modules/contact-auth-gate-e2e.test.ts": 3,
  "tests/modules/debounce.test.ts": 8,
  "tests/modules/delivery-sweep.test.ts": 3,
  "tests/modules/eager-media-flow-context.test.ts": 2,
  "tests/modules/flowlog-astral-detail.test.ts": 1,
  "tests/modules/flowlog-debug-mode-e2e.test.ts": 2,
  "tests/modules/flowlog-detail-pii.test.ts": 1,
  "tests/modules/flowlog-retention.test.ts": 1,
  "tests/modules/flowlog-settle.test.ts": 1,
  "tests/modules/flowlog.test.ts": 1,
  "tests/modules/guardrail-health.test.ts": 1,
  "tests/modules/memory-compaction.test.ts": 3,
  "tests/modules/memory-dead-letter.test.ts": 1,
  "tests/modules/playground-guardrails.test.ts": 1,
  "tests/modules/reengage.test.ts": 2,
  "tests/modules/model-fallback-turn.test.ts": 1,
  "tests/modules/spend-ceiling-gate-e2e.test.ts": 1,
  "tests/modules/spend-ceiling-paths-e2e.test.ts": 3,
  "tests/modules/stt.test.ts": 1,
  "tests/modules/tts-normalize-observability.test.ts": 1,
  "tests/modules/terminal-failure-announces.test.ts": 1,
  "tests/modules/tool-precondition-alerting.test.ts": 1,
  "tests/modules/tts.test.ts": 2,
  "tests/modules/vision-retry.test.ts": 1,
  "tests/modules/webhooks-outbound-dead-alert.test.ts": 1,
  "tests/modules/webhooks-outbound-deliveries.test.ts": 1,
};

// Lives beside the rest of the flowlog family rather than in tests/tooling/, which the manifest
// drops from BOTH derived repos: a guard that does not exist in the public tree cannot stop the next
// unscoped reader from being written there.
//
// The one file the scan skips, because its fixtures below are unscoped reads written on purpose.
const SELF = "tests/modules/flowlog-reader-scope.test.ts";

// The helper file, skipped by BOTH scans below and for the same reason each time: it is where the
// one correct spelling is DEFINED, so it holds the raw clear and the raw reads that every other file
// is forbidden. Exempting it is not a hole: nothing in it asserts on a row, so neither obligation
// has anything to be about.
const HELPER = "tests/utils/flowlog.ts";

// A clear of `execution_logs` written by hand, in any spelling a test has reached for. `TRUNCATE` is
// listed because it is the same act under a different verb, and a guard that only knew `DELETE`
// would wave it through. `\s` inside the pattern rather than a literal space for the same reason
// the scan below is whole-file: `executionLog\n  .deleteMany(…)` and a `DELETE\nFROM execution_logs`
// inside a template literal are what the formatter produces on a long enough line, and a predicate
// run per line would report the file as clean.
const RAW_CLEAR =
  /executionLog\s*\.\s*deleteMany\s*\(|(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+"?execution_logs"?/gi;

// A READ of `execution_logs` written against the client instead of the settling helper. Same shape
// as RAW_CLEAR above and for the same reason: `\s` rather than a literal space, because
// `executionLog\n  .findMany(…)` is what the formatter produces on a long enough line and a
// per-line predicate would call that file clean.
//
// Only the READING methods. `deleteMany` has its own guard above, and `create` is how a test SEEDS
// rows it then reads, awaited, with no emit in the path, so the wait obligation has nothing to be about.
const RAW_READ =
  /executionLog\s*\.\s*(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\s*\(/g;

export function rawReadLines(src: string): number[] {
  const out: number[] = [];
  const re = new RegExp(RAW_READ.source, "gi");
  for (;;) {
    const hit = re.exec(src);
    if (!hit) return out;
    out.push(src.slice(0, hit.index).split("\n").length);
  }
}

export function rawClearLines(src: string): number[] {
  const out: number[] = [];
  // A fresh regex per call: a `g` pattern carries `lastIndex` between calls, so a shared instance
  // would start the second file mid-way through and miss whatever sits before that offset.
  const re = new RegExp(RAW_CLEAR.source, "gi");
  for (;;) {
    const hit = re.exec(src);
    if (!hit) return out;
    // The line the match STARTS on, counted from the offset rather than from a per-line loop, which
    // is what lets the match itself span lines.
    out.push(src.slice(0, hit.index).split("\n").length);
  }
}

// `clearFlowLog` is the one correct spelling. Three files are exempt and each for its own reason:
// the helper IS the spelling; the settle file's subject is what a clear that does not settle leaves
// behind, so it has to write the wrong one to assert what it costs; and this file, like the reader
// scan above it, holds fixtures of the very thing it flags.
const CLEAR_EXEMPT = new Set([
  HELPER,
  "tests/modules/flowlog-settle.test.ts",
  SELF,
]);

// `flowLogRows` / `flowLogRow` / `flowLogCount` are the correct spellings. The same three files are
// exempt as for the clear, and the middle one for a sharper reason than there: flowlog-settle's
// SUBJECT is that the row is not there when the emit returns, so it has to read without settling to
// assert what settling buys. A guard that forced it to settle would delete its premise.
const READ_EXEMPT = new Set([
  HELPER,
  "tests/modules/flowlog-settle.test.ts",
  SELF,
]);

async function scanTests(): Promise<Map<string, Reader[]>> {
  const { Glob } = await import("bun");
  const found = new Map<string, Reader[]>();
  for await (const rel of new Glob("**/*.{ts,tsx}").scan("tests")) {
    const path = `tests/${rel}`;
    if (path === SELF || path === HELPER) continue;
    const readers = flowlogReaders(await Bun.file(path).text());
    if (readers.length > 0) found.set(path, readers);
  }
  return found;
}

// The positive control, and the reason it is not optional: a sweep that finds nothing passes exactly
// like a sweep that finds everything, so without an offender the parser could return `[]` for every
// file and this suite would stay green while guarding nothing (#266). These fixtures are the
// offender, held as strings so the scan above cannot see them.
describe("the scan can actually tell a scoped reader from an unscoped one", () => {
  const UNSCOPED = `
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, stage: "generate" },
      select: { detail: true },
    });`;
  const SCOPED = `
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, stage: "generate", threadId },
      select: { detail: true },
    });`;
  const SHORTHAND_AFTER_A_VALUE = `
    await suDb.executionLog.count({
      where: { tenantId, stage: "memory", threadId },
    });`;
  const MARKED = `
    const rows = await suDb.executionLog.findMany({
      // flowlog-scope: tenant-wide — the subject is the table, not one turn.
      where: { tenantId },
    });`;
  const BY_AGENT = `
    await suDb.executionLog.findFirst({
      where: { tenantId, agentId },
    });`;
  const NESTED_FILTER = `
    await suDb.executionLog.findFirst({
      where: { tenantId, detail: { path: ["outcome"], equals: "sent" } },
    });`;

  test("it flags a reader filtered by tenant alone", () => {
    const [r] = flowlogReaders(UNSCOPED);
    expect(r?.keys).toEqual(["tenantId", "stage"]);
    expect(r ? isScoped(r, "turn") : true).toBe(false);
  });

  test("it accepts one carrying the thread it produced", () => {
    const [r] = flowlogReaders(SCOPED);
    expect(r ? isScoped(r, "turn") : false).toBe(true);
  });

  test("a shorthand key AFTER a value is still seen", () => {
    // The bug the first version of this parser had, pinned: `stage: "memory"` sits between the two
    // keys, and a regex that consumes the separator loses everything after the first pair.
    const [r] = flowlogReaders(SHORTHAND_AFTER_A_VALUE);
    expect(r?.keys).toEqual(["tenantId", "stage", "threadId"]);
  });

  test("agentId counts only where the ledger says the tests own an agent each", () => {
    // The hole this closes: accepting `agentId` for every entry let a reader in a file where all 74
    // tests drive ONE agent pass the guard while still answering with a neighbour's rows. The key is
    // sufficient in playground-guardrails and nowhere else, so the ledger decides, not the key.
    const [r] = flowlogReaders(BY_AGENT);
    expect(r?.keys).toEqual(["tenantId", "agentId"]);
    expect(r ? isScoped(r, "agent") : false).toBe(true);
    expect(r ? isScoped(r, "turn") : true).toBe(false);
  });

  test("a marker inside the call declares that reader's exemption", () => {
    const [r] = flowlogReaders(MARKED);
    expect(r?.marker).toBe("tenant-wide");
  });

  test("a marker does not reach the reader after it", () => {
    // The failure the marker exists to prevent, in miniature. A per-file or per-index exemption
    // hands itself to whatever is written next; this asserts the second reader is judged on its own.
    const rs = flowlogReaders(`${MARKED}\n${UNSCOPED}`);
    expect(rs.length).toBe(2);
    expect(rs[1]?.marker).toBeNull();
    expect(rs[1] ? isScoped(rs[1], "turn") : true).toBe(false);
  });

  test("a nested filter object does not leak its inner keys", () => {
    // `path` and `equals` belong to the filter, not to the row, and counting them would let a reader
    // pass by naming a JSON path that happens to spell a scope key.
    const [r] = flowlogReaders(NESTED_FILTER);
    expect(r?.keys).toEqual(["tenantId", "detail"]);
  });
});

describe("every flow-log reader in the suite is accounted for", () => {
  test("the file list and the per-file counts still match", async () => {
    const found = await scanTests();
    const counts = Object.fromEntries(
      [...found].map(([f, rs]) => [f, rs.length]),
    );
    const expected = { ...FLOWLOG_READERS };
    expect(counts).toEqual(expected);
  });

  test("each one is scoped to what the test produced, or listed as not being", async () => {
    const found = await scanTests();
    const unscoped: string[] = [];
    for (const [file, readers] of found) {
      for (const r of readers) {
        // `turn` is the default precisely because it is the strict one: a reader that declares
        // nothing is held to the strictest rule, and the three that are something else say so at
        // their own call site.
        const scoping = r.marker ?? "turn";
        if (scoping === "seeded" || scoping === "tenant-wide") continue;
        if (!isScoped(r, scoping))
          unscoped.push(`${file}:${r.line} { ${r.keys.join(", ")} }`);
      }
    }
    expect(unscoped).toEqual([]);
  });
});

describe("nothing empties the flow log by hand", () => {
  test("it flags a raw deleteMany and a raw DELETE, and both spellings of TRUNCATE", () => {
    expect(
      rawClearLines("await db.executionLog.deleteMany({ where });"),
    ).toEqual([1]);
    expect(
      rawClearLines(
        "await db.$executeRawUnsafe(`DELETE FROM execution_logs WHERE x`);",
      ),
    ).toEqual([1]);
    expect(
      rawClearLines('await db.$executeRawUnsafe("TRUNCATE execution_logs");'),
    ).toEqual([1]);
    expect(
      rawClearLines(
        'await db.$executeRawUnsafe(`TRUNCATE TABLE "execution_logs"`);',
      ),
    ).toEqual([1]);
  });

  test("the spellings the formatter produces do not escape it", () => {
    // The hole round 1 of review found, pinned. The predicate was applied per line, so any clear the
    // formatter had broken across lines read as clean — and these are not exotic spellings, they are
    // what Biome emits once the chain or the template is long enough.
    expect(
      rawClearLines("await suDb.executionLog\n  .deleteMany({ where });"),
    ).toEqual([1]);
    expect(
      rawClearLines(
        "await db.$executeRawUnsafe(`DELETE\n  FROM execution_logs\n  WHERE x`);",
      ),
    ).toEqual([1]);
    expect(
      rawClearLines(
        "const a = 1;\nconst b = 2;\nawait db.executionLog.deleteMany({ w });",
      ),
    ).toEqual([3]);
    // Two of them, so the scan cannot stop at the first and call the rest of the file clean.
    expect(
      rawClearLines(
        "await db.executionLog.deleteMany({ a });\nawait db.executionLog.deleteMany({ b });",
      ),
    ).toEqual([1, 2]);
  });

  test("it does not flag the helper call, nor another table's clear", () => {
    // The positive control above is what makes this line mean something: a predicate that flagged
    // nothing would pass this test and the sweep below without reading anything.
    expect(rawClearLines("await clearFlowLog(suDb, { tenantId });")).toEqual(
      [],
    );
    expect(
      rawClearLines("await suDb.alertDelivery.deleteMany({ where });"),
    ).toEqual([]);
    expect(
      rawClearLines(
        "await suDb.$executeRawUnsafe(`DELETE FROM alert_deliveries WHERE x`);",
      ),
    ).toEqual([]);
  });

  test("every clear in the suite goes through clearFlowLog", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("tests")) {
      const path = `tests/${rel}`;
      if (CLEAR_EXEMPT.has(path)) continue;
      for (const line of rawClearLines(await Bun.file(path).text())) {
        offenders.push(`${path}:${line}`);
      }
    }
    // A raw clear empties the table of the rows that exist and of nothing else, so the case that runs
    // next inherits whatever the case before it had only scheduled. `clearFlowLog` settles first.
    expect(offenders).toEqual([]);
  });
});

describe("nothing reads the flow log without waiting for the write", () => {
  test("it flags a raw read in each of its methods, and across a line break", () => {
    expect(
      rawReadLines("const r = await db.executionLog.findMany({ w });"),
    ).toEqual([1]);
    expect(rawReadLines("await db.executionLog.findFirst({ w });")).toEqual([
      1,
    ]);
    expect(rawReadLines("await db.executionLog.count({ w });")).toEqual([1]);
    // What Biome emits once the chain is long enough, and the shape a per-line predicate misses.
    expect(
      rawReadLines("await suDb.executionLog\n  .findMany({ w });"),
    ).toEqual([1]);
    // Two of them, so the scan cannot stop at the first and call the rest of the file clean.
    expect(
      rawReadLines(
        "await db.executionLog.findMany({ a });\nawait db.executionLog.count({ b });",
      ),
    ).toEqual([1, 2]);
  });

  test("it does not flag the helper calls, a seeding create, nor another table", () => {
    // The positive control above is what makes this line mean something: a predicate that flagged
    // nothing would pass this test and the sweep below without reading anything.
    expect(
      rawReadLines("const r = await flowLogRows(suDb, { where });"),
    ).toEqual([]);
    expect(
      rawReadLines("const r = await flowLogRow(suDb, { where });"),
    ).toEqual([]);
    expect(
      rawReadLines("const n = await flowLogCount(suDb, { where });"),
    ).toEqual([]);
    // A test that INSERTS its own rows awaits the write, so there is no emit to outrun.
    expect(rawReadLines("await suDb.executionLog.create({ data });")).toEqual(
      [],
    );
    expect(
      rawReadLines("await suDb.alertDelivery.findMany({ where });"),
    ).toEqual([]);
  });

  test("every read in the suite goes through the settling helper", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("tests")) {
      const path = `tests/${rel}`;
      if (READ_EXEMPT.has(path)) continue;
      for (const line of rawReadLines(await Bun.file(path).text())) {
        offenders.push(`${path}:${line}`);
      }
    }
    // A read that does not settle answers before the row lands. For an assertion that a line EXISTS
    // that is a flake; for one that a line does NOT exist it is worse, because the read passes for
    // exactly the reason that makes it wrong. Measured on chatwoot-command-dropped with the write
    // delayed 200ms: seven of its nine cases fail without the settle, and the two that pass are the
    // two asserting an absence.
    expect(offenders).toEqual([]);
  });
});
