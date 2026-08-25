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

type Reader = {
  /** 1-indexed line of the `executionLog.<method>(` that opens the call. */
  line: number;
  /** Top-level keys of the call's `where: { ... }`, in source order. */
  keys: string[];
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
    out.push({
      line: source.slice(0, m.index).split("\n").length,
      keys,
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

const FLOWLOG_READERS: Record<string, [number, Scoping]> = {
  "tests/graph/history-ceiling-turn.test.ts": [1, "turn"],
  "tests/graph/nudge.test.ts": [3, "turn"],
  "tests/graph/runtime.test.ts": [7, "turn"],
  "tests/graph/side-effect-flowlog.test.ts": [1, "turn"],
  "tests/graph/tool-flowlog.test.ts": [1, "turn"],
  "tests/modules/contact-auth-gate-e2e.test.ts": [2, "turn"],
  "tests/modules/flowlog-astral-detail.test.ts": [1, "turn"],
  "tests/modules/flowlog-detail-pii.test.ts": [1, "turn"],
  "tests/modules/flowlog-retention.test.ts": [1, "tenant-wide"],
  "tests/modules/flowlog.test.ts": [1, "turn"],
  "tests/modules/guardrail-health.test.ts": [1, "seeded"],
  "tests/modules/memory-compaction.test.ts": [3, "turn"],
  "tests/modules/memory-dead-letter.test.ts": [1, "turn"],
  "tests/modules/playground-guardrails.test.ts": [1, "agent"],
  "tests/modules/stt.test.ts": [1, "turn"],
  "tests/modules/tts-normalize-observability.test.ts": [1, "turn"],
  "tests/modules/tts.test.ts": [2, "turn"],
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
    const expected = Object.fromEntries(
      Object.entries(FLOWLOG_READERS).map(([f, [n]]) => [f, n]),
    );
    expect(counts).toEqual(expected);
  });

  test("each one is scoped to what the test produced, or listed as not being", async () => {
    const found = await scanTests();
    const unscoped: string[] = [];
    for (const [file, readers] of found) {
      const scoping = FLOWLOG_READERS[file]?.[1] ?? "turn";
      // `seeded` and `tenant-wide` are the two answers that legitimately have no scope key.
      if (scoping === "seeded" || scoping === "tenant-wide") continue;
      for (const r of readers) {
        if (!isScoped(r, scoping))
          unscoped.push(`${file}:${r.line} { ${r.keys.join(", ")} }`);
      }
    }
    expect(unscoped).toEqual([]);
  });
});
