import { describe, expect, test } from "bun:test";

// EVERY TEST THAT READS THE FLOW LOG, AND WHAT SCOPES IT. `emitFlowEvent` is fire-and-forget
// (src/modules/flowlog/service.ts), so a test asserting on its lines has three obligations: SCOPE (a
// tenant-only filter answers with another test of the same file), WAIT (read through `flowLogRows` /
// `flowLogRow` / `flowLogCount`, which settle first) and CLEAR (`clearFlowLog` settles, then
// deletes). Each has ONE SPELLING, so each is checked off the source. The ledger is per file with a
// count, and `tenant-wide` is a decision written down, not an omission. What it does not cover, and
// the cost of a tree-wide ledger: docs/logs.md, "Testing the flow log".

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
// travels to readers written later, and a per-INDEX one is worse: inserting a reader above an exempt
// one silently hands it the exemption. A marker on the call site moves with the call site.
const MARKER = /\/\/\s*flowlog-scope:\s*(turn|agent|seeded|tenant-wide)\b/;

// The marker is looked for in the comment block IMMEDIATELY above the call — consecutive
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

// Written against the delimiters rather than as one regex on purpose. A regex like
// `/(?:^|,|\{)\s*(\w+)\s*[,:}]/g` reads correctly and is wrong: matches cannot overlap, so the comma
// that ends one key is consumed and the key after it never matches (`{ tenantId, stage, threadId }`
// reads as `[tenantId]`), flagging readers that are in fact scoped.
export function flowlogReaders(source: string): Reader[] {
  const out: Reader[] = [];
  // Both spellings, because the WAIT obligation puts readers on `flowLogRows` and friends, and a scan
  // of the raw client alone would report a tree with no readers as a tree with nothing to check. The
  // helper takes the client and then the SAME args object, so `where` still sits at the call site; that
  // is why the helper passes its args through instead of wrapping them away.
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
    // Inside the call OR in the comment block above it. The first is what survives the formatter, which
    // can move a marker off `await suDb.executionLog.findFirst({` onto the `(` the wrapper opened; a
    // marker the formatter can detach is a marker that silently stops applying.
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
//   tenant-wide the subject is the table, not a turn (the retention sweep proves WHICH rows survive).
//               Safe because of the CLEAR obligation, not because a file is short: it answers with
//               whatever is in the tenant, so it cannot survive a clear that left a neighbour's row.
type Scoping = "turn" | "agent" | "seeded" | "tenant-wide";

export function isScoped(reader: Reader, scoping: Scoping): boolean {
  const allowed =
    scoping === "agent" ? [...TURN_KEYS, AGENT_KEY] : [...TURN_KEYS];
  return reader.keys.some((k) => allowed.includes(k));
}

const FLOWLOG_READERS: Record<string, number> = {
  "tests/modules/alert-cause.test.ts": 2,
  "tests/modules/alert-rate.test.ts": 1,
  // NOTE: The capacity lines one conversation produced, read by its conversation.
  "tests/modules/capacity-wait-db.test.ts": 1,
  // NOTE: The clip line a code tool's call wrote, read by the turn that made it.
  "tests/graph/code-tool-clip.test.ts": 1,
  "tests/graph/duplicate-tool-name-visible.test.ts": 1,
  "tests/graph/history-ceiling-turn.test.ts": 1,
  "tests/graph/ingest.test.ts": 2,
  "tests/graph/label-allowed-wiring.test.ts": 1,
  // NOTE: A turn a gate stopped writes no closing line, which only a read can show.
  "tests/graph/nudge.test.ts": 7,
  "tests/graph/nudge-waits-for-turn.test.ts": 2,
  // NOTE: A withdrawn turn closes on no line.
  "tests/graph/read-receipt-turn.test.ts": 1,
  // NOTE: Scoped by thread or conversation: the provisional stamp of the `skip_reply` line, the turn fact
  // absent from a turn that did not decide silence, the `tts` line of a reply sent as text, every line
  // of one conversation (the text reply is in none), `replyRecovered` and the `silenceUnexplained` warn
  // that must not fire on it, `silenceRetry` and the warn's detail, and the lines of a turn whose
  // recovered reply a takeover refused, a guardrail replaced, or that was delivered.
  "tests/graph/runtime.test.ts": 36,
  "tests/graph/side-effect-flowlog.test.ts": 1,
  "tests/graph/skip-handover.test.ts": 2,
  "tests/graph/skip-reply-reason-logged.test.ts": 1,
  // NOTE: The helper that runs one tool call end to end, plus the case that asks WHEN the turn's delivery is
  // read: that one drives the callback by hand, so it cannot go through the helper.
  "tests/graph/skip-reply-turn-delivered.test.ts": 2,
  "tests/graph/tool-flowlog.test.ts": 1,
  // NOTE: The clip lines two code tools wrote in one turn, one silenced and one not, read by that turn.
  "tests/graph/tool-silence-truncation-alert.test.ts": 1,
  "tests/graph/tool-schema-refusal.test.ts": 2,
  // NOTE: Two readers in one test, and the second is the first one's control. The alert-channel test send
  // must write no line the alerting path would itself route, and the tenant is minutes old, so the zero
  // and the one have to come off the same query.
  "tests/modules/alert-channel-exclude-agents.test.ts": 1,
  "tests/modules/alert-channel-test.test.ts": 2,
  "tests/modules/channel-failure.test.ts": 1,
  // NOTE: The line a playground turn that failed unhandled leaves, read by the turn's own id.
  "tests/modules/playground-turn-failure.test.ts": 1,
  // NOTE: The lines of one playground thread, read by its threadId.
  "tests/modules/playground.test.ts": 1,
  "tests/modules/chatwoot-command-dropped.test.ts": 2,
  "tests/modules/chatwoot-gate-trail.test.ts": 1,
  "tests/modules/chatwoot-human-reply-takeover.test.ts": 1,
  "tests/modules/chatwoot-inbox-remove.test.ts": 1,
  "tests/modules/chatwoot-monitoring-seam.test.ts": 4,
  "tests/modules/chatwoot-observer-route.test.ts": 1,
  "tests/modules/chatwoot-recover-delivery.test.ts": 6,
  "tests/modules/chatwoot-recover-takeover.test.ts": 1,
  "tests/modules/chatwoot-unbound-inbox.test.ts": 1,
  "tests/modules/contact-auth-gate-e2e.test.ts": 3,
  "tests/modules/debounce-late-visual.test.ts": 1,
  "tests/modules/debounce.test.ts": 10,
  "tests/modules/delivery-sweep.test.ts": 6,
  "tests/modules/eager-media-flow-context.test.ts": 6,
  "tests/modules/failure-note.test.ts": 1,
  "tests/modules/flowlog-astral-detail.test.ts": 1,
  "tests/modules/flowlog-debug-mode-e2e.test.ts": 2,
  "tests/modules/flowlog-detail-pii.test.ts": 1,
  "tests/modules/flowlog-retention.test.ts": 1,
  "tests/modules/flowlog-settle.test.ts": 1,
  "tests/modules/flowlog.test.ts": 1,
  // NOTE: Two reads, tenant-wide on purpose: their subject is HOW MANY lines a lost follow-up sequence wrote
  // (one) and a one-step ladder re-run wrote (none); each case empties this file's tenant first.
  "tests/modules/followup-sweep-later-step.test.ts": 2,
  "tests/modules/guardrail-health.test.ts": 1,
  // NOTE: One reader answering both directions on the same query: the line that names a colleague's reply
  // nobody remembered, and its absence on the customer's own lost ingestion, which keeps the report
  // from naming the wrong message.
  "tests/modules/human-agent-ingest.test.ts": 1,
  "tests/modules/inbound-sweep.test.ts": 1,
  // NOTE: The `human_reply_recovery_gone` line, the only durable record that a colleague's reply will not be
  // recovered.
  "tests/modules/chatwoot-recover-human-reply.test.ts": 1,
  "tests/modules/memory-compaction.test.ts": 3,
  "tests/modules/memory-dead-letter.test.ts": 1,
  "tests/modules/observe-job.test.ts": 2,
  "tests/modules/observer-sibling-media.test.ts": 1,
  "tests/modules/playground-guardrails.test.ts": 1,
  // NOTE: The `vision` stage line of the reengage turn is the only proof the attachment was opened: the reply
  // text cannot tell "read and summarised" from "made up".
  "tests/modules/reengage-vision.test.ts": 1,
  "tests/modules/reengage.test.ts": 3,
  "tests/modules/model-fallback-turn.test.ts": 1,
  // NOTE: The close line of one conversation, read by that conversation.
  "tests/modules/nothing-to-answer.test.ts": 1,
  // NOTE: Two reads, tenant-wide on purpose: one counts HOW MANY lines a death wrote, the other asks under
  // WHICH tenant the line landed, and none of the units that die there has a turn to scope by.
  "tests/modules/scheduler-dead-letter-erased.test.ts": 2,
  // NOTE: One reader, tenant-wide on purpose: its subject is HOW MANY lines a discarded outcome wrote, and
  // each case empties this file's tenant first.
  "tests/modules/scheduler-discard-announced.test.ts": 1,
  "tests/modules/spend-ceiling-gate-e2e.test.ts": 1,
  "tests/modules/spend-ceiling-paths-e2e.test.ts": 4,
  "tests/modules/spend-ceiling-poll.test.ts": 3,
  "tests/modules/stt.test.ts": 3,
  "tests/modules/tts-check.test.ts": 3,
  "tests/modules/tts-normalize-observability.test.ts": 1,
  "tests/modules/terminal-failure-announces.test.ts": 1,
  "tests/modules/tool-precondition-alerting.test.ts": 1,
  "tests/modules/tts.test.ts": 2,
  "tests/modules/unpriced-model-alert.test.ts": 1,
  "tests/modules/vision-email-body.test.ts": 1,
  "tests/modules/vision-every-attachment.test.ts": 1,
  "tests/modules/vision-retry.test.ts": 5,
  "tests/modules/vision-unread-reason.test.ts": 1,
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
// file and this suite would stay green while guarding nothing. These fixtures are the offender, held
// as strings so the scan above cannot see them.
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
    // `stage: "memory"` sits between the two keys, and a regex that consumes the separator loses
    // everything after the first pair.
    const [r] = flowlogReaders(SHORTHAND_AFTER_A_VALUE);
    expect(r?.keys).toEqual(["tenantId", "stage", "threadId"]);
  });

  test("agentId counts only where the ledger says the tests own an agent each", () => {
    // `agentId` accepted for every entry would let a reader in a file where every test drives ONE agent
    // pass the guard while answering with a neighbour's rows. The key is sufficient in
    // playground-guardrails and nowhere else, so the ledger decides, not the key.
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
    // NOTE: A per-line predicate reads any clear the formatter broke across lines as clean, and these are not
    // exotic spellings: they are what Biome emits once the chain or the template is long enough.
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
    // NOTE: A read that does not settle answers before the row lands. For an assertion that a line EXISTS that
    // is a flake; for one that a line does NOT exist it is worse, because the read passes for exactly the
    // reason that makes it wrong: with the write delayed, only the cases asserting an absence still pass.
    expect(offenders).toEqual([]);
  });
});
