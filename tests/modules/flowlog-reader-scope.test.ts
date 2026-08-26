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
//
// This file guards the first obligation only, and says so rather than implying a clean bill of
// health. The second cannot be read off the source: "is there a wait" is a question about control
// flow, and a poll loop is only correct when the assertion is that a line EXISTS — polling for an
// absence just spends the timeout before answering. Those live as comments at the call sites.
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
  const call =
    /executionLog\.(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\s*\(/g;
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
//               tenant can say. Safe because the file holds a single test.
type Scoping = "turn" | "agent" | "seeded" | "tenant-wide";

export function isScoped(reader: Reader, scoping: Scoping): boolean {
  const allowed =
    scoping === "agent" ? [...TURN_KEYS, AGENT_KEY] : [...TURN_KEYS];
  return reader.keys.some((k) => allowed.includes(k));
}

const FLOWLOG_READERS: Record<string, number> = {
  "tests/graph/history-ceiling-turn.test.ts": 1,
  "tests/graph/nudge.test.ts": 3,
  "tests/graph/runtime.test.ts": 7,
  "tests/graph/side-effect-flowlog.test.ts": 1,
  "tests/graph/tool-flowlog.test.ts": 1,
  "tests/modules/chatwoot-command-dropped.test.ts": 2,
  "tests/modules/chatwoot-gate-trail.test.ts": 1,
  "tests/modules/chatwoot-inbox-remove.test.ts": 1,
  "tests/modules/chatwoot-unbound-inbox.test.ts": 1,
  "tests/modules/contact-auth-gate-e2e.test.ts": 3,
  "tests/modules/debounce.test.ts": 4,
  "tests/modules/delivery-sweep.test.ts": 3,
  "tests/modules/eager-media-flow-context.test.ts": 2,
  "tests/modules/flowlog-astral-detail.test.ts": 1,
  "tests/modules/flowlog-debug-mode-e2e.test.ts": 2,
  "tests/modules/flowlog-detail-pii.test.ts": 1,
  "tests/modules/flowlog-retention.test.ts": 1,
  "tests/modules/flowlog.test.ts": 1,
  "tests/modules/guardrail-health.test.ts": 1,
  "tests/modules/memory-compaction.test.ts": 3,
  "tests/modules/memory-dead-letter.test.ts": 1,
  "tests/modules/playground-guardrails.test.ts": 1,
  "tests/modules/model-fallback-turn.test.ts": 1,
  "tests/modules/stt.test.ts": 1,
  "tests/modules/tts-normalize-observability.test.ts": 1,
  "tests/modules/terminal-failure-announces.test.ts": 1,
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

async function scanTests(): Promise<Map<string, Reader[]>> {
  const { Glob } = await import("bun");
  const found = new Map<string, Reader[]>();
  for await (const rel of new Glob("**/*.{ts,tsx}").scan("tests")) {
    const path = `tests/${rel}`;
    if (path === SELF) continue;
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
