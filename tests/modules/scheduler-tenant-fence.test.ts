import { describe, expect, test } from "bun:test";
import { codeOnly } from "@/tests/utils/source-text";

// A CROSS-TENANT DRAIN IN A TEST STEALS ROWS FROM WHATEVER ELSE SHARES THE DATABASE.
//
// The scheduler tick and the claims under it are cross-tenant BY DESIGN: production runs one leader
// and a batch that stopped at a tenant boundary would starve every tenant after it. That design is
// documented where it lives, on `TickOptions.tenantId` in src/modules/scheduler/worker.ts, together
// with the fence it hands a test: pass your own tenant and drain only your own rows.
//
// The fence has no enforcement, and one call site had already lost it. `tests/db-name.ts` derives ONE
// database per checkout and every DB-backed file shares it, so an unfenced drain reaches rows the
// current file never created. Serially that is survivable by luck: the thief runs before or after its
// victim and the stolen row was already spent. Under `bun test --parallel` the two run at the same
// moment in different processes, and the row is gone before its owner looks.
//
// Measured, at `--parallel=12` on this suite: `runSchedulerTick(appDb, { staleMs, batchSize: 20 })` in
// tests/modules/failure-note.test.ts claimed the WEBHOOK_RETRY that tests/modules/debounce.test.ts had
// just enqueued for its own tenant, and `debounce > the scheduler claim excludes DEBOUNCE` failed with
// `Expected: true, Received: false` in a file that had done nothing wrong. Two of six runs failed that
// way, never the same test twice, which is the shape that costs a day to attribute: the failure never
// names the file that caused it.
//
// So the rule is enforced here rather than remembered. It is a SOURCE sweep and not a runtime check
// because the cost it prevents is paid by a DIFFERENT file than the one at fault, and a runtime check
// can only fire in the victim.

// Every entry point whose default reach is the whole database. Each is cross-tenant when its tenant
// argument is absent, and each is reachable from a test.
const CROSS_TENANT = [
  "runSchedulerTick",
  "claimDueJobs",
  "claimDueTrafficJobs",
  "claimDueDebounceJobs",
  "claimPendingByKeyPrefix",
  "reapStaleJobs",
] as const;

interface CallSite {
  file: string;
  line: number;
  fn: string;
  text: string;
}

// The call's own argument text, taken by BALANCING parentheses rather than by reading to the next
// `)`. An options object holding a call of its own (`{ now: new Date() }`) closes a naive scan early,
// and the half it cuts off is exactly where a trailing `tenantId` would sit.
function callsIn(source: string, file: string): CallSite[] {
  const code = codeOnly(source);
  const out: CallSite[] = [];
  for (const fn of CROSS_TENANT) {
    const re = new RegExp(`\\b${fn}\\(`, "g");
    for (const m of code.matchAll(re)) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < code.length && depth > 0) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")") depth--;
        i++;
      }
      out.push({
        file,
        line: code.slice(0, m.index).split("\n").length,
        fn,
        text: code.slice(m.index, i),
      });
    }
  }
  return out;
}

async function testSources(): Promise<Map<string, string>> {
  const { Glob } = await import("bun");
  const files = new Map<string, string>();
  for await (const rel of new Glob("**/*.test.{ts,tsx}").scan("tests")) {
    files.set(`tests/${rel}`, await Bun.file(`tests/${rel}`).text());
  }
  return files;
}

// This file names the functions in a list to sweep for, so it matches itself on every one of them.
const SELF = "tests/modules/scheduler-tenant-fence.test.ts";

describe("a test that drains the scheduler drains only its own tenant", () => {
  test("every cross-tenant claim in the suite carries a tenant", async () => {
    const offenders: CallSite[] = [];
    for (const [file, src] of await testSources()) {
      if (file === SELF) continue;
      for (const call of callsIn(src, file)) {
        if (!/\btenantId\b/.test(call.text)) offenders.push(call);
      }
    }
    expect(
      offenders.map((o) => `${o.file}:${o.line} ${o.fn}`),
      "A scheduler drain without `tenantId` claims rows belonging to other test files sharing this " +
        "database, and under `bun test --parallel` the failure surfaces in the file it robbed, not " +
        "here. Pass the tenant the file seeded. See TickOptions.tenantId in " +
        "src/modules/scheduler/worker.ts.",
    ).toEqual([]);
  });

  // The check above passes just as well when the glob reads nothing, and a sweep that reads nothing is
  // the failure mode this whole file exists to prevent: silent, green, and wrong.
  test("the sweep reads the tree", async () => {
    const files = await testSources();
    expect(files.size).toBeGreaterThan(400);
    const total = [...files].flatMap(([f, s]) =>
      f === SELF ? [] : callsIn(s, f),
    );
    expect(total.length).toBeGreaterThan(20);
  });

  // The balancing above is the part that can go wrong quietly: a scan that stops early reads a fenced
  // call as unfenced (noisy, and someone fixes it) or an unfenced one as fenced (silent, and this file
  // stops working). Both directions are pinned against text written here.
  test("the extractor takes the whole argument list, nested calls included", () => {
    const src = [
      "await runSchedulerTick(appDb, { staleMs: 5, batchSize: 20 });",
      "await runSchedulerTick(appDb, { batchSize: f(g(1)), tenantId });",
      "await claimDueJobs(50, appDb, new Date(), tenantId);",
    ].join("\n");
    const found = callsIn(src, "x.ts");
    expect(found.map((c) => c.fn)).toEqual([
      "runSchedulerTick",
      "runSchedulerTick",
      "claimDueJobs",
    ]);
    expect(found.map((c) => /\btenantId\b/.test(c.text))).toEqual([
      false,
      true,
      true,
    ]);
    expect(found.map((c) => c.line)).toEqual([1, 2, 3]);
  });

  // `codeOnly` strips comments and literal contents, and both matter here. A note ABOUT an unfenced
  // drain is prose, and a fixture string holding one is data; neither is a call.
  test("a mention in a comment or a string is not a call site", () => {
    const src = [
      "// runSchedulerTick(appDb, { batchSize: 20 }) would be unfenced here.",
      'const sample = "runSchedulerTick(appDb, { batchSize: 20 })";',
      "await runSchedulerTick(appDb, { batchSize: 20, tenantId });",
    ].join("\n");
    expect(callsIn(src, "x.ts")).toHaveLength(1);
  });
});
