import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// `stillWanted` answers two questions that want opposite things when the read fails. Inside the
// critical section, before any write, an unreadable answer STOPS the run (guessing "still wanted"
// recreates the state /reset just cleared). Every other ask guards a SEND and must NOT throw
// (unwinding past a delivery makes the scheduler retry it, so the customer gets it twice). The rule
// is per CALL SITE, so the test reads the source: the ask that matters is reached only through
// `runLoadedTurn`, which the webhook path never uses (it passes `stillWanted: null`).
const FILES = [
  "src/graph/runtime.ts",
  "src/graph/nudge.ts",
  "src/modules/channel-redirect/followup.ts",
];

// A callback handed to `runAgentNudge` receives `{ strict }` and can simply DROP it, which compiles,
// passes every behavioural test whose database answers, and fails open on the one ask before a
// write. So the `stillWanted` inside `runAgentNudge({ ... })` must thread `strict` through. The
// fixed-text senders are not policed: every ask they make surrounds a send, where fail-open is right.
const NUDGE_CALLERS = ["src/modules/channel-redirect/followup.ts"];

// The `stillWanted` entry of the `runAgentNudge({ ... })` object literal, as written.
function nudgeStillWanted(src: string): string | undefined {
  const at = src.indexOf("runAgentNudge({");
  if (at === -1) return undefined;
  return src
    .slice(at)
    .split("\n")
    .find((l) => /^\s*stillWanted:/.test(l));
}

function asks(src: string): Array<{ line: number; strict: boolean }> {
  const out: Array<{ line: number; strict: boolean }> = [];
  src.split("\n").forEach((text, i) => {
    if (!/\bstillWanted\s*\(/.test(text)) return;
    // The declaration and the local wrapper are not asks.
    if (/(?:const|function|:\s*\(|\?:)\s*stillWanted/.test(text)) return;
    out.push({
      line: i + 1,
      strict: /\bstrict:\s*true\b|stillWanted\(true\)/.test(text),
    });
  });
  return out;
}

describe("stillWanted strictness, per call site", () => {
  test("the source walk finds the asks it is meant to police", () => {
    for (const f of FILES) {
      expect(asks(readFileSync(f, "utf8")).length).toBeGreaterThan(0);
    }
  });

  test.each(NUDGE_CALLERS)("%s threads strict into runAgentNudge", (f) => {
    const line = nudgeStillWanted(readFileSync(f as string, "utf8"));
    // NOTE: The walk found the call site at all; without this, a rename turns the assertion below into a
    // test that proves nothing while still passing.
    expect(line).toBeDefined();
    expect(line).toContain("strict");
  });

  // NOTE: TWO per file with a critical section (the redirect follow-up only asks around sends).
  // The durable claim WAITS on an append's lease and on the row lock /reset takes, so one ask comes
  // before it (a retired run takes no claim) and one after it: a single ask before the claim can be
  // dozens of seconds stale by the time anything is written.
  test.each([
    ["src/graph/runtime.ts", 2],
    ["src/graph/nudge.ts", 2],
    ["src/modules/channel-redirect/followup.ts", 0],
  ])("%s has %i strict ask(s)", (file, expected) => {
    const strict = asks(readFileSync(file as string, "utf8")).filter(
      (a) => a.strict,
    );
    expect(strict).toHaveLength(expected as number);
  });

  // And both strict asks are inside the critical section, not merely somewhere in the file. Anchored
  // on `withKeyedQueue`, which is what the section is: an ask that drifts out of it stops being the
  // pre-write fence and starts being a probe that can abort a delivered message.
  test.each([["src/graph/runtime.ts"], ["src/graph/nudge.ts"]])(
    "%s asks strictly inside withKeyedQueue",
    (file) => {
      const src = readFileSync(file as string, "utf8");
      const lines = src.split("\n");
      const strict = asks(src).filter((a) => a.strict);
      expect(strict).toHaveLength(2);
      const queueOpens = lines.findIndex((l) => /withKeyedQueue\(/.test(l));
      expect(queueOpens).toBeGreaterThan(-1);
      // After the section opens, and before the first ask that follows the section's own writes.
      for (const a of strict) expect(a.line).toBeGreaterThan(queueOpens + 1);
    },
  );

  // The claim waits out an append's lease and the row lock /reset holds, so the ask that
  // authorizes the writes must come AFTER it; a strict ask in the wrong position fails silently. A
  // source walk because the call site in `runLoadedTurn` is not reachable from a test (the webhook
  // path passes `stillWanted: null`, the debounce job goes through the whole handler).
  // `runAgentNudge` covers the same seam behaviourally in tests/graph/nudge.test.ts.
  const WRITES =
    /\.(?:updateState|upsert|create|update|createMany|updateMany|delete)\(|\$executeRaw/;
  test.each([["src/graph/runtime.ts"], ["src/graph/nudge.ts"]])(
    "%s asks again after the durable claim and before it writes",
    (file) => {
      const lines = readFileSync(file as string, "utf8").split("\n");
      const claimed = lines.findIndex((l) => /await markTurnOwning\(/.test(l));
      expect(claimed).toBeGreaterThan(-1);
      // The first thing that happens after the claim, of the only two that matter: an ask that
      // re-authorizes the run, or a write that no longer has authorization behind it. Comments are
      // skipped, so prose naming a write does not stand in for one.
      const after = lines.slice(claimed + 1);
      const asked = after.findIndex(
        (l) =>
          !/^\s*(?:\/\/|\*)/.test(l) &&
          /\bstillWanted\s*\(/.test(l) &&
          /\bstrict:\s*true\b|stillWanted\(true\)/.test(l),
      );
      const wrote = after.findIndex(
        (l) => !/^\s*(?:\/\/|\*)/.test(l) && WRITES.test(l),
      );
      expect(asked).toBeGreaterThan(-1);
      expect(wrote).toBeGreaterThan(-1);
      expect(asked).toBeLessThan(wrote);
    },
  );
});
