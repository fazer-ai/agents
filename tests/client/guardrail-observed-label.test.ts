import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import {
  flowStageLabel,
  guardrailExternalLabel,
  guardrailObservedLabel,
  guardrailUncheckedLabel,
} from "@/client/lib/flowLabels";
import { GUARDRAIL_OBSERVED, selectorOf } from "@/modules/flowlog/stages";

// Each key's English default, with its placeholders filled, as the Logs page would show it.
const t = ((_k: string, o: string | { defaultValue: string }) => {
  if (typeof o === "string") return o;
  return o.defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    String((o as unknown as Record<string, unknown>)[k]),
  );
}) as unknown as TFunction;

describe("an observed guardrail line on the Logs page", () => {
  // The bug it catches: an observed trip read as a trip that acted, so the operator goes looking for
  // a note or a hand-over that never happened.
  test("says the conversation was left alone, the categories and the rationale", () => {
    expect(
      guardrailObservedLabel(
        "guardrail",
        {
          direction: "input",
          action: "observe",
          categories: ["unsafe_content", "pii"],
          rationale: "RAZAO-X1",
        },
        t,
      ),
    ).toBe(
      "The customer's message tripped the check; only recorded, the turn went on as if it had passed · categories: unsafe_content, pii · rationale: RAZAO-X1",
    );
    expect(
      guardrailObservedLabel(
        "guardrail",
        { direction: "output", action: "observe", rationaleChars: 42 },
        t,
      ),
    ).toBe(
      'The reply tripped the check; only recorded, it went out as written · a rationale was given (42 characters), shown here only when "Log the values sent to tools" is on',
    );
  });

  // The control: a trip that acted, another stage and the external check's own line are not
  // observed lines, so the sentence above is not written for every guardrail row.
  test("is silent for every other line", () => {
    const acted = { direction: "input", action: "handoff" };
    expect(guardrailObservedLabel("guardrail", acted, t)).toBeNull();
    expect(
      guardrailObservedLabel("observe", { action: "observe" }, t),
    ).toBeNull();
    expect(
      guardrailObservedLabel(
        "guardrail",
        { check: "external", action: "observe", decision: "block" },
        t,
      ),
    ).toBeNull();
    expect(guardrailObservedLabel("guardrail", null, t)).toBeNull();
  });

  // The bug it catches: an observed trip with no rationale counted as "unchecked", which would tell
  // the operator the check failed when it judged and tripped.
  test("is never read as a check that could not judge", () => {
    expect(
      guardrailUncheckedLabel(
        "guardrail",
        { direction: "input", action: "observe", categories: ["pii"] },
        t,
      ),
    ).toBeNull();
  });

  // The bug it catches: a turn review of a write call that could not run read "the reply was let
  // through unchecked", while what went on unreviewed (or was held) was the call.
  test("a turn review of a call that could not run names the call", () => {
    const call = {
      direction: "output",
      check: "turn_review",
      step: "call",
      tool: "agendar",
      outcome: "analysis_failed",
    };
    expect([
      guardrailUncheckedLabel("guardrail", { ...call, unchecked: true }, t),
      guardrailUncheckedLabel("guardrail", { ...call, held: true }, t),
    ]).toEqual([
      "The turn review could not judge the call to agendar, so the call ran unreviewed",
      "The turn review could not judge the call to agendar, so the call did not run and a hand-over to the team was requested",
    ]);
  });

  test("its badge names the observed selector, and only for an observed trip", () => {
    expect(selectorOf("guardrail", { action: "observe" })).toBe(
      GUARDRAIL_OBSERVED,
    );
    expect(selectorOf("guardrail", { action: "handoff" })).toBe("guardrail");
    expect(selectorOf("observe", { action: "observe" })).toBe("observe");
    expect(selectorOf("guardrail", null)).toBe("guardrail");
    expect(flowStageLabel(GUARDRAIL_OBSERVED, t)).toBe(
      "Guardrail check (observed only)",
    );
  });
});

describe("an external check line under observe", () => {
  // The bug it catches: an observed block read as "blocked the reply (observe)" and an observed
  // replace as "replaced the reply", when the reply went out as written in both.
  test("says what the endpoint would have done and that the reply went out", () => {
    const base = { check: "external", action: "observe", latencyMs: 30 };
    expect(
      guardrailExternalLabel("guardrail", { ...base, decision: "block" }, t),
    ).toBe(
      "The external check would have blocked the reply; only recorded, the reply went out as written · took 30 ms",
    );
    expect(
      guardrailExternalLabel(
        "guardrail",
        { ...base, decision: "replace", reasonChars: 9 },
        t,
      ),
    ).toBe(
      'The external check would have replaced the reply; only recorded, the reply went out as written · took 30 ms · a reason was given (9 characters), shown here only when "Log the values sent to tools" is on',
    );
    expect(
      guardrailExternalLabel("guardrail", { ...base, decision: "allow" }, t),
    ).toBe("The external check allowed the reply · took 30 ms");
  });

  // The bug it catches: an observed write call told as a reply that went out, when no reply was sent;
  // and a line written at the review claiming a run or a delivery that comes later, if at all.
  test("a turn review line names the step: a call that ran, or a reply that went out", () => {
    expect([
      guardrailObservedLabel(
        "guardrail",
        {
          check: "turn_review",
          direction: "output",
          action: "observe",
          step: "call",
          tool: "handoff_to_human",
          rationaleChars: 10,
        },
        t,
      )?.split(" · ")[0],
      guardrailObservedLabel(
        "guardrail",
        {
          check: "turn_review",
          direction: "output",
          action: "observe",
          step: "reply",
        },
        t,
      ),
    ]).toEqual([
      "The turn review found the call to handoff_to_human against the agent's instructions; only recorded, the turn review did not block it",
      "The turn review found the reply against the agent's instructions; only recorded, the turn review did not block it",
    ]);
  });
});
