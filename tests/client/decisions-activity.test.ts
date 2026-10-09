import { describe, expect, test } from "bun:test";
import {
  type DecisionLine,
  summarizeDecisions,
} from "@/client/pages/agents/decisionsActivity";

// What the agent editor says a decisions agent has been doing, counted off the engine's own
// `observe` lines. The counts are by rule index, so a line older than the last save is left out:
// nothing on it says which block it ran.

function line(
  createdAt: string,
  detail: Record<string, unknown>,
  status = "ok",
): DecisionLine {
  return { createdAt, status, detail: { engine: "decisions", ...detail } };
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
  }),
  line("2026-10-08T12:10:00Z", {
    answers: { pede_reembolso: { type: "refusal" } },
    actions: [],
  }),
];

describe("what a decisions agent has been doing", () => {
  test("counts each rule's fired, ran, shadow and blocked decisions", () => {
    const a = summarizeDecisions(LINES, null);
    expect(a.decisions).toBe(3);
    expect(a.rules.get(0)).toEqual({ fired: 2, ran: 1, shadow: 1, blocked: 0 });
    expect(a.rules.get(2)).toEqual({ fired: 1, ran: 0, shadow: 0, blocked: 1 });
    // A rule that never fired has no entry: zero is said by the reader, against `decisions`.
    expect(a.rules.has(1)).toBe(false);
  });

  test("keeps each question's latest answers, newest first", () => {
    const a = summarizeDecisions(LINES, null);
    expect(a.answers.get("pede_reembolso")).toEqual([
      { type: "refusal" },
      { type: "yes_no", probability: 0.12 },
      { type: "yes_no", probability: 0.91 },
    ]);
    expect(a.answers.get("irritacao")).toEqual([
      { type: "score", score: 1.4, confidence: 0.6 },
    ]);
    expect(
      summarizeDecisions(LINES, null, 1).answers.get("pede_reembolso"),
    ).toEqual([{ type: "refusal" }]);
  });

  test("the order the lines arrive in does not change the answer", () => {
    const a = summarizeDecisions([...LINES].reverse(), null);
    expect(a.answers.get("pede_reembolso")?.[0]).toEqual({ type: "refusal" });
  });

  test("leaves out what was decided before the agent was last saved", () => {
    const a = summarizeDecisions(LINES, "2026-10-08T12:03:00Z");
    expect(a.decisions).toBe(2);
    expect(a.rules.get(0)).toEqual({ fired: 1, ran: 0, shadow: 1, blocked: 0 });
    expect(a.rules.has(2)).toBe(false);
    expect(a.answers.has("assunto")).toBe(false);
  });

  test("counts only ticks the decisions engine decided", () => {
    const a = summarizeDecisions(
      [
        // The model engine's line, a failed call, a skipped tick and a line with no detail.
        {
          createdAt: "2026-10-08T12:00:00Z",
          status: "ok",
          detail: { engine: "llm", actions: [], answers: {} },
        },
        line("2026-10-08T12:00:00Z", { failed: "decision_call" }, "error"),
        line(
          "2026-10-08T12:00:00Z",
          { skipped: "decisions_config_invalid" },
          "skipped",
        ),
        { createdAt: "2026-10-08T12:00:00Z", status: "ok", detail: null },
      ],
      null,
    );
    expect(a.decisions).toBe(0);
    expect(a.rules.size).toBe(0);
  });
});
