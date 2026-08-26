import { describe, expect, test } from "bun:test";

// ── EVERY UNIT OF WORK THAT DIES PERMANENTLY SAYS SO, AND THE COUNT STAYS AT ZERO (issue #356) ──
//
// Four buses can reach a terminal failure state, and the history of this repo is the count of silent
// ones going down by one at a time without anything recording how many were left: #196 gave the
// compaction its line, #318 the unrouted delivery, #317 the dropped command, #325 the dead outbound
// delivery, #282 the stranded one. Five rounds, five sites, one question.
//
// So the acceptance criterion is not a checklist in an issue body — that is satisfied by halves with
// nothing going red. It is this sweep, and it asks two things:
//
//   1. the function that writes a terminal status also announces it;
//   2. the SET of write sites is exactly the one below, so a sixth bus cannot be added silently.
//
// A source sweep, because the alternative (a runtime assertion) can only fire on a path a test
// already drives, and the whole failure mode here is the path nobody thought to drive. This one
// replaces the narrower fence #325 left behind (`webhooks-outbound-dead-fence.test.ts`): the
// outbound module's entry below is what carries that property now, and the same question asked in
// two files is how the two answers start to differ.

const SRC = "src";

// A terminal status being WRITTEN, in the three spellings this codebase uses: the string literal in
// a Prisma `data`, the generated enum member, and the SQL cast inside a raw statement. The fourth is
// the argument form (`finish(row, tenantId, "DEAD", base)`), where the write itself is a shared
// helper and the literal never appears beside `status:` at all.
const TERMINAL = "(?:DEAD|FAILED)";
const KEYED = new RegExp(
  `(?<!where:\\s*\\{[^}]{0,80})status:\\s*(?:"${TERMINAL}"|'${TERMINAL}'|[A-Za-z]+Status\\.${TERMINAL})`,
);
const ARG = new RegExp(`[(,]\\s*"${TERMINAL}"\\s*[,)]`);
const SQL = new RegExp(`'${TERMINAL}'::`);

// Asking which rows are dead is a question, not a death. These are the shapes a READ takes, and
// leaving them in would bury the eight real sites under filters, comparisons and type annotations.
const NOT_A_WRITE = /\bin:\s*\[|\|\s*"|"\s*\||===|!==|\.status\s*[!=]=/;

const FUNCTION_DECL = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/;

// What "and announces it" is spelled as. `writeFlowEvent` is the awaited form of the same write,
// used by the one caller whose line is its only other trace (../../src/modules/flowlog/service.ts).
const ANNOUNCES =
  /\b(?:emitDeadLetter|emitDeliveryDead|emitFlowEvent|writeFlowEvent)\(/;

export interface TerminalSite {
  fn: string;
  announces: boolean;
}

// Exported for its own positive control: a sweep that finds nothing passes identically whether the
// codebase is clean or the predicate is broken, so the predicate has to be shown finding something.
export function terminalWriteSites(source: string): TerminalSite[] {
  const lines = source.split("\n");
  const declAt: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (FUNCTION_DECL.test(lines[i] as string)) declAt.push(i);
  }
  const out: TerminalSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (NOT_A_WRITE.test(line)) continue;
    if (!(KEYED.test(line) || ARG.test(line) || SQL.test(line))) continue;
    let start = -1;
    for (const d of declAt) {
      if (d <= i) start = d;
      else break;
    }
    if (start < 0) {
      out.push({ fn: "<top level>", announces: false });
      continue;
    }
    const next = declAt.find((d) => d > start);
    const body = lines.slice(start, next ?? lines.length).join("\n");
    out.push({
      fn: (
        FUNCTION_DECL.exec(lines[start] as string) as RegExpExecArray
      )[1] as string,
      announces: ANNOUNCES.test(body),
    });
  }
  return out;
}

// THE CENSUS. Every place in `src/` that puts a unit of work into a terminal failure state, with
// what each one does about it. A site that is not here fails the sweep, which is the point: the
// decision about a new bus's silence is made in this diff or not at all.
const CENSUS: Record<string, string> = {
  // Announce in the same function they write in.
  "src/modules/webhooks/outbound/worker.ts:finalizeDead":
    "an outbound delivery the bus gave up on (#325)",
  "src/modules/flowlog/alert-worker.ts:finalizeDead":
    "an alert the bus gave up on — the one that cannot alert about itself (#356)",
  "src/modules/webhooks/inbound/service.ts:persistFailed":
    "an authenticated payload the receptor cannot process (#356)",
  "src/modules/webhooks/inbound/service.ts:processInboundDelivery":
    "an inbound delivery past its processing budget (#356)",
  "src/modules/rag/documents.ts:runIngestJobForTenant":
    "a document that will never be indexed; the second line is the same fact broadcast live (#356)",
  "src/modules/chatwoot/delivery-sweep.ts:record":
    "a delivery stranded by a process death (#282)",
  // The two that announce ELSEWHERE, and the only exemptions here. Both are CAS writes in the
  // scheduler's service layer, and neither can announce from where it sits: what a dead job means is
  // decided per kind by a registry only the worker holds, and both roads converge on the worker's
  // `dispatchDeadLetter`, which announces for every kind since #356. The complementary sweep that
  // every reaper calls `announceReaped` lives in memory-dead-letter.test.ts.
  "src/modules/scheduler/service.ts:failJob":
    "ANNOUNCES ELSEWHERE: ../scheduler/worker.ts dispatchDeadLetter",
  "src/modules/scheduler/service.ts:reapStaleJobs":
    "ANNOUNCES ELSEWHERE: ../scheduler/worker.ts dispatchDeadLetter, via announceReaped",
};
const ANNOUNCES_ELSEWHERE = new Set([
  "src/modules/scheduler/service.ts:failJob",
  "src/modules/scheduler/service.ts:reapStaleJobs",
]);

async function sweepSrc(): Promise<{ key: string; announces: boolean }[]> {
  const files = [...new Bun.Glob("**/*.ts").scanSync(SRC)]
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => `${SRC}/${f}`)
    .sort();
  const out: { key: string; announces: boolean }[] = [];
  for (const f of files) {
    const source = await Bun.file(f).text();
    for (const s of terminalWriteSites(source)) {
      out.push({ key: `${f}:${s.fn}`, announces: s.announces });
    }
  }
  return out;
}

describe("the terminal-failure fence", () => {
  test("positive control: the predicate sees a stray write, and names the function it is in", () => {
    const fixture = `
async function finalizeDead(base, d) {
  await db.outboundWebhookDelivery.update({ data: { status: "DEAD" } });
  emitDeadLetter({ unit: "job" });
}
async function someNewPath(base, d) {
  await db.inboundDelivery.update({ data: { status: "FAILED" } });
}
`;
    expect(terminalWriteSites(fixture)).toEqual([
      { fn: "finalizeDead", announces: true },
      { fn: "someNewPath", announces: false },
    ]);
  });

  test("positive control: the enum and raw-SQL spellings count, and a read does not", () => {
    expect(
      terminalWriteSites(
        `function f() { await u({ data: { status: WebhookDeliveryStatus.DEAD } }); }`,
      ),
    ).toEqual([{ fn: "f", announces: false }]);
    expect(
      terminalWriteSites(
        `function g() { await db.$executeRaw\`SET status = 'DEAD'::"SchedulerJobStatus"\`; }`,
      ),
    ).toEqual([{ fn: "g", announces: false }]);
    expect(
      terminalWriteSites(
        `function h() { await m({ where: { status: "DEAD" } }); }`,
      ),
    ).toEqual([]);
  });

  test("positive control: the argument form counts, because the write is a shared helper", () => {
    expect(
      terminalWriteSites(
        `function record() { await finish(row, t, "DEAD", base); }`,
      ),
    ).toEqual([{ fn: "record", announces: false }]);
  });

  test("positive control: a filter, a union type and a comparison are not writes", () => {
    expect(
      terminalWriteSites(
        `function a() { where: { status: { in: ["FAILED", "UNINDEXED"] } } }`,
      ),
    ).toEqual([]);
    expect(
      terminalWriteSites(
        `function b(status: "PROCESSED" | "DEAD") { return status; }`,
      ),
    ).toEqual([]);
    expect(
      terminalWriteSites(
        `function c() { if (current.status !== "DEAD") return; }`,
      ),
    ).toEqual([]);
  });

  test("positive control: a commented-out write is not a write", () => {
    expect(
      terminalWriteSites(`function f() {\n  // status: "DEAD"\n}`),
    ).toEqual([]);
  });

  test("every terminal-status write in src/ is a site this census knows about", async () => {
    const sites = await sweepSrc();
    expect(sites.length).toBeGreaterThan(0);
    const unknown = sites.map((s) => s.key).filter((k) => !(k in CENSUS));
    expect(unknown).toEqual([]);
    // And the other direction: a census entry with no site left is a decision about code that no
    // longer exists, which is how a stale exemption outlives the thing it exempted.
    const seen = new Set(sites.map((s) => s.key));
    expect(Object.keys(CENSUS).filter((k) => !seen.has(k))).toEqual([]);
  });

  test("and it announces, in the same function or at the chokepoint named here", async () => {
    const silent = (await sweepSrc())
      .filter((s) => !s.announces && !ANNOUNCES_ELSEWHERE.has(s.key))
      .map((s) => s.key);
    expect(silent).toEqual([]);
  });
});
