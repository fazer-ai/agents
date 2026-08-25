import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// THE TWO QUESTIONS `stillWanted` ANSWERS, and they want opposite things when the read itself fails.
//
// The ask inside the thread's critical section runs before anything is written, so an unreadable
// answer has to STOP the run: guessing "still wanted" there recreates the graph state /reset just
// cleared, the operator is told the conversation was wiped, and the agent keeps answering from it.
// No later fence catches that. Every other ask guards a SEND, and there an unreadable answer must
// NOT throw: unwinding past a delivered message abandons its watermark and its job completion, so
// the scheduler retries the step and the customer gets it twice.
//
// The rule is per CALL SITE, not per function, so the test reads the source. A table-driven test of
// the callback would prove the callback and say nothing about which of the eleven asks passes
// `strict: true` — and the one that matters is reached only through `runLoadedTurn`, which the
// webhook path never uses (it passes `stillWanted: null`, having no job to retire).
const FILES = [
  "src/graph/runtime.ts",
  "src/graph/nudge.ts",
  "src/modules/channel-redirect/followup.ts",
];

// The redirect ladder asks most of its questions through the composite `fence` now (issues #246,
// #250), which answers a verdict rather than a boolean and folds the retirement half in. That does
// not weaken the rule, it moves where the rule is broken: a callback handed to `runAgentNudge`
// receives `{ strict }` and can simply DROP it, which compiles, passes every behavioural test whose
// database answers, and fails open on the one ask that runs before a write. That is exactly what a
// rebase onto the composite fence did here, and only a reviewer caught it.
//
// So the walk asks the question of the call site that matters: the `stillWanted` inside
// `runAgentNudge({ ... })` must thread `strict` through. Callbacks handed to the fixed-text senders
// are not policed — every ask they make surrounds a send, where fail-open is the correct answer.
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
    // The walk found the call site at all — without this, a rename turns the assertion below into a
    // test that proves nothing while still passing.
    expect(line).toBeDefined();
    expect(line).toContain("strict");
  });

  // Exactly one per file, and only in the two files that hold a critical section. The redirect
  // follow-up has none: every ask it makes is around a send.
  test.each([
    ["src/graph/runtime.ts", 1],
    ["src/graph/nudge.ts", 1],
    ["src/modules/channel-redirect/followup.ts", 0],
  ])("%s has %i strict ask(s)", (file, expected) => {
    const strict = asks(readFileSync(file as string, "utf8")).filter(
      (a) => a.strict,
    );
    expect(strict).toHaveLength(expected as number);
  });

  // And the strict one is inside the critical section, not merely somewhere in the file. Anchored on
  // `withKeyedQueue`, which is what the section is: an ask that drifts out of it stops being the
  // pre-write fence and starts being a probe that can abort a delivered message.
  test.each([["src/graph/runtime.ts"], ["src/graph/nudge.ts"]])(
    "%s asks strictly inside withKeyedQueue",
    (file) => {
      const src = readFileSync(file as string, "utf8");
      const lines = src.split("\n");
      const strict = asks(src).filter((a) => a.strict);
      expect(strict).toHaveLength(1);
      const queueOpens = lines.findIndex((l) => /withKeyedQueue\(/.test(l));
      expect(queueOpens).toBeGreaterThan(-1);
      // After the section opens, and before the first ask that follows the section's own writes.
      expect(strict[0]?.line).toBeGreaterThan(queueOpens + 1);
    },
  );
});
