import { describe, expect, test } from "bun:test";
import {
  type DecisionLine,
  summarizeDecisions,
} from "@/client/pages/agents/decisionsActivity";

// What the agent editor says a decisions agent has been doing, counted off the engine's own
// `observe` lines. The counts are by rule index, so only the lines that carry the mark of the block
// being shown are counted: an index means nothing without the list it indexes.

function line(
  createdAt: string,
  detail: Record<string, unknown>,
  status = "ok",
): DecisionLine {
  return {
    createdAt,
    status,
    detail: { engine: "decisions", block: "aaaa", ...detail },
  };
}

const LINES: DecisionLine[] = [
  line("2026-10-08T12:00:00Z", {
    answers: {
      pede_reembolso: { type: "yes_no", probability: 0.91 },
      assunto: { type: "choice", choice: "reembolso", confidence: 0.8 },
    },
    actions: [
      { rule: 0, tool: "set_labels", outcome: "ran" },
      { rule: 2, tool: "private_note", outcome: "not_granted" },
    ],
    notFired: [{ rule: 1, miss: { why: "below_threshold" } }],
  }),
  line("2026-10-08T12:05:00Z", {
    answers: {
      pede_reembolso: { type: "yes_no", probability: 0.12 },
      irritacao: { type: "score", score: 1.4, confidence: 0.6 },
    },
    actions: [{ rule: 0, tool: "set_labels", outcome: "shadow" }],
    notFired: [
      { rule: 1, miss: { why: "below_threshold" } },
      { rule: 2, miss: { why: "other_choice" } },
    ],
  }),
  line("2026-10-08T12:10:00Z", {
    answers: { pede_reembolso: { type: "refusal" } },
    actions: [],
    notFired: [0, 1, 2].map((rule) => ({ rule, miss: { why: "refused" } })),
  }),
];

describe("what a decisions agent has been doing", () => {
  // The `shadow` action is an outcome only old lines carry: it reads as fired and neither run nor
  // blocked.
  test("counts each rule's fired, ran and blocked decisions, and an old recorded-only line as fired", () => {
    const a = summarizeDecisions(LINES, "aaaa", 3);
    expect(a.decisions).toBe(3);
    expect(a.rules.get(0)).toEqual({
      fired: 2,
      ran: 1,
      blocked: 0,
      refused: 0,
      refusedBy: {},
      held: 0,
      merged: 0,
    });
    expect(a.rules.get(2)).toEqual({
      fired: 1,
      ran: 0,
      blocked: 1,
      refused: 0,
      refusedBy: {},
      held: 0,
      merged: 0,
    });
    // A rule that never fired has no entry: zero is said by the reader, against `decisions`.
    expect(a.rules.has(1)).toBe(false);
  });

  test("the order the lines arrive in does not change the counts", () => {
    const a = summarizeDecisions(LINES, "aaaa", 3);
    const b = summarizeDecisions([...LINES].reverse(), "aaaa", 3);
    expect(b.decisions).toBe(a.decisions);
    expect([...b.rules.entries()]).toEqual([...a.rules.entries()]);
  });

  // agents#1426: the editor shows no answers, so the summary carries none.
  test("carries the counts and no answers", () => {
    expect(Object.keys(summarizeDecisions(LINES, "aaaa", 3)).sort()).toEqual([
      "decisions",
      "rules",
    ]);
  });

  test("counts only the lines that ran the block being shown", () => {
    // The middle line ran another block: the rules were reordered and a tick was in flight.
    const lines = LINES.map((l, i) =>
      i === 1
        ? { ...l, detail: { ...(l.detail as object), block: "bbbb" } }
        : l,
    );
    const a = summarizeDecisions(lines, "aaaa", 3);
    expect(a.decisions).toBe(2);
    expect(a.rules.get(0)).toEqual({
      fired: 1,
      ran: 1,
      blocked: 0,
      refused: 0,
      refusedBy: {},
      held: 0,
      merged: 0,
    });
    // ...and the other block's line is counted when THAT block is the one shown.
    expect(summarizeDecisions(lines, "bbbb", 3).decisions).toBe(1);
  });

  test("a line with no mark, and a block that cannot run, count nothing", () => {
    const unmarked = LINES.map((l) => {
      const { block: _block, ...rest } = l.detail as Record<string, unknown>;
      return { ...l, detail: rest };
    });
    expect(summarizeDecisions(unmarked, "aaaa", 3).decisions).toBe(0);
    expect(summarizeDecisions(LINES, null, 3).decisions).toBe(0);
  });

  // Two rules firing the same tool with the same arguments run it once, and the line carries the
  // action under the first one's index: the second is in neither list.
  test("a rule merged into an earlier rule's identical call still counts as fired", () => {
    const a = summarizeDecisions(
      [
        line("2026-10-08T12:00:00Z", {
          answers: { pede_reembolso: { type: "yes_no", probability: 0.9 } },
          actions: [{ rule: 0, tool: "set_labels", outcome: "ran" }],
          notFired: [{ rule: 2, miss: { why: "below_threshold" } }],
        }),
      ],
      "aaaa",
      3,
    );
    expect(a.rules.get(0)).toEqual({
      fired: 1,
      ran: 1,
      blocked: 0,
      refused: 0,
      refusedBy: {},
      held: 0,
      merged: 0,
    });
    expect(a.rules.get(1)).toEqual({
      fired: 1,
      ran: 0,
      blocked: 0,
      refused: 0,
      refusedBy: {},
      held: 0,
      merged: 1,
    });
    expect(a.rules.has(2)).toBe(false);
  });

  // A fence inside the tool refusing the call is not a run, and not "could not run" either: it is
  // counted apart, by fence.
  test("an action a fence refused counts as refused, by fence, and never as ran", () => {
    const a = summarizeDecisions(
      [
        line("2026-10-08T12:00:00Z", {
          answers: { pede_reembolso: { type: "yes_no", probability: 0.9 } },
          actions: [
            {
              rule: 0,
              tool: "set_labels",
              outcome: "refused",
              fence: "protected_label",
            },
            {
              rule: 1,
              tool: "private_note",
              outcome: "refused",
              fence: "precondition",
            },
            { rule: 2, tool: "handoff_to_human", outcome: "not_granted" },
          ],
        }),
        line("2026-10-08T12:05:00Z", {
          answers: { pede_reembolso: { type: "yes_no", probability: 0.9 } },
          actions: [
            {
              rule: 0,
              tool: "set_labels",
              outcome: "refused",
              fence: "protected_label",
            },
          ],
          notFired: [1, 2].map((rule) => ({ rule, miss: {} })),
        }),
      ],
      "aaaa",
      3,
    );
    expect(a.rules.get(0)).toMatchObject({
      fired: 2,
      ran: 0,
      blocked: 0,
      refused: 2,
      refusedBy: { protected_label: 2 },
    });
    expect(a.rules.get(1)).toMatchObject({
      ran: 0,
      refused: 1,
      refusedBy: { precondition: 1 },
    });
    expect(a.rules.get(2)).toMatchObject({ blocked: 1, refused: 0 });
  });

  // The line names the later rules an action answers for: their outcome is the action's.
  test("a merged rule takes the outcome of the action it rode on", () => {
    const a = summarizeDecisions(
      [
        line("2026-10-08T12:00:00Z", {
          answers: { pede_reembolso: { type: "yes_no", probability: 0.9 } },
          actions: [
            {
              rule: 0,
              tool: "set_labels",
              outcome: "refused",
              fence: "protected_label",
              merged: [1],
            },
          ],
          notFired: [{ rule: 2, miss: {} }],
        }),
      ],
      "aaaa",
      3,
    );
    expect(a.rules.get(1)).toMatchObject({
      fired: 1,
      ran: 0,
      refused: 1,
      merged: 1,
    });
  });

  // A rule its trigger held back fired and did not act: it is neither "did not fire" nor merged.
  test("a rule its trigger held back counts as fired and held", () => {
    const a = summarizeDecisions(
      [
        line("2026-10-08T12:00:00Z", {
          answers: { pede_reembolso: { type: "yes_no", probability: 0.9 } },
          actions: [],
          held: [{ rule: 0, trigger: "on_start" }],
          notFired: [1, 2].map((rule) => ({ rule, miss: {} })),
        }),
      ],
      "aaaa",
      3,
    );
    expect(a.rules.get(0)).toMatchObject({
      fired: 1,
      held: 1,
      ran: 0,
      merged: 0,
    });
  });

  test("counts only ticks the decisions engine decided", () => {
    const a = summarizeDecisions(
      [
        // The model engine's line, a failed call, a skipped tick and a line with no detail.
        {
          createdAt: "2026-10-08T12:00:00Z",
          status: "ok",
          detail: { engine: "llm", block: "aaaa", actions: [], answers: {} },
        },
        line("2026-10-08T12:00:00Z", { failed: "decision_call" }, "error"),
        line(
          "2026-10-08T12:00:00Z",
          { skipped: "decisions_config_invalid" },
          "skipped",
        ),
        { createdAt: "2026-10-08T12:00:00Z", status: "ok", detail: null },
      ],
      "aaaa",
      3,
    );
    expect(a.decisions).toBe(0);
    expect(a.rules.size).toBe(0);
  });
});
