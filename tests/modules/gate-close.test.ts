import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeClosedGate } from "@/modules/chatwoot/gate-close";

// The decision the three ownership gates share, and the sweep that keeps it shared.
//
// The table proves the FUNCTION. It cannot prove that a gate calls it: a gate that spells the
// ternary out again passes every table row and still reports the wrong thing, which is the state
// issue #271 found — one gate classifying, one gate writing nothing, one writing a line with no
// reason in it. So the second half reads the source and asks where this vocabulary is allowed to be
// written at all.

describe("describeClosedGate", () => {
  const cases: Array<{
    name: string;
    assigneeType: string | null;
    status: string | null;
    expected: ReturnType<typeof describeClosedGate>;
  }> = [
    {
      name: "a human holds it: a real handoff, whatever the status",
      assigneeType: "User",
      status: "open",
      expected: { outcome: "taken_over" },
    },
    {
      name: "a human holds it while still pending",
      assigneeType: "User",
      status: "pending",
      expected: { outcome: "taken_over" },
    },
    {
      name: "escalated out of pending with nobody on it: the ack case",
      assigneeType: null,
      status: "open",
      expected: { outcome: "ownership_lost", status: "open" },
    },
    {
      name: "escalated out of pending while a bot still holds the seat",
      assigneeType: "AgentBot",
      status: "open",
      expected: { outcome: "ownership_lost", status: "open" },
    },
    {
      name: "another party's bot holds it, still pending",
      assigneeType: "AgentBot",
      status: "pending",
      expected: { outcome: "ownership_lost", status: "pending" },
    },
    {
      name: "resolved out from under the turn",
      assigneeType: null,
      status: "resolved",
      expected: { outcome: "ownership_lost", status: "resolved" },
    },
    {
      name: "an unreadable status still names the outcome",
      assigneeType: null,
      status: null,
      expected: { outcome: "ownership_lost", status: "unknown" },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        describeClosedGate({ assigneeType: c.assigneeType, status: c.status }),
      ).toEqual(c.expected);
    });
  }
});

// The two outcomes are a vocabulary, not two strings: an operator filtering the log for one of them
// has to get every gate that produced it. A second speller is how they drift apart.
const OWNER = "src/modules/chatwoot/gate-close.ts";
const VOCABULARY = /outcome\s*:\s*["'](?:taken_over|ownership_lost)["']/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("the gate-close vocabulary has one speller", () => {
  // The control the sweep needs to be worth reading: a sweep that finds nothing passes whether it
  // works or not. Both spellings, because the one that escaped a sweep before was the one written
  // with different spacing.
  test("the predicate recognises the shape it is looking for", () => {
    expect(VOCABULARY.test('detail: { outcome: "taken_over" }')).toBe(true);
    expect(VOCABULARY.test("detail: { outcome:'ownership_lost' }")).toBe(true);
    expect(VOCABULARY.test('{ outcome  :  "taken_over" }')).toBe(true);
    expect(VOCABULARY.test('detail: { outcome: "resolved" }')).toBe(false);
  });

  test("no file outside the owner writes either outcome as a literal", () => {
    const offenders = tsFiles("src")
      .filter((f) => f !== OWNER)
      .filter((f) => VOCABULARY.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  // Every gate that closes on a customer message the bot would have answered has to SAY so, and
  // these are the files they live in: the webhook (on each event, and again after the contact-auth
  // round-trip), the flush (before the turn, and again after that same round-trip), and the runtime
  // (after the model answered). The proactive senders are deliberately not here — nothing was going
  // to be answered there, which is a different question with its own issue.
  test("every file that closes an ownership gate asks the shared unit", () => {
    const gates = [
      "src/modules/chatwoot/webhook.ts",
      "src/modules/debounce/handler.ts",
      "src/graph/runtime.ts",
    ];
    const missing = gates.filter(
      (f) => !readFileSync(f, "utf8").includes("describeClosedGate("),
    );
    expect(missing).toEqual([]);
  });
});
