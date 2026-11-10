import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import {
  guardrailGroundingLabel,
  guardrailObservedLabel,
} from "@/client/lib/flowLabels";

// Each key's English default, with its placeholders filled, as the Logs page would show it.
const t = ((_k: string, o: string | { defaultValue: string }) => {
  if (typeof o === "string") return o;
  return o.defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    String((o as unknown as Record<string, unknown>)[k]),
  );
}) as unknown as TFunction;

const reviewed = {
  check: "factual_grounding",
  direction: "output",
  resultChars: 5400,
  earlierSources: 1,
  inputTokens: 8100,
  outputTokens: 240,
  latencyMs: 3100,
};

describe("a factual-grounding review on the Logs page", () => {
  // The bug it catches: a clean review read as a trip, or its cost left off the row, which is the
  // whole reason the line is written.
  test("a clean review says so, with what it read and what it cost", () => {
    expect(
      guardrailGroundingLabel(
        "guardrail",
        { ...reviewed, verdict: "clean", claimCount: 0 },
        t,
      ),
    ).toBe(
      "Factual grounding: the reply matches the sources · 5400 characters of results · 1 source(s) from earlier turns · 8100 in / 240 out tokens, 3100 ms",
    );
    expect(
      guardrailObservedLabel(
        "guardrail",
        { ...reviewed, verdict: "clean", claimCount: 0 },
        t,
      ),
    ).toBeNull();
  });

  // The bug it catches: an unsourced review read as one that matched sources it never had.
  test("a review with no source consulted says so, and names no results", () => {
    const unsourced = {
      ...reviewed,
      sourced: false,
      resultChars: 0,
      earlierSources: 0,
    };
    expect([
      guardrailGroundingLabel(
        "guardrail",
        { ...unsourced, verdict: "clean", claimCount: 0 },
        t,
      ),
      guardrailGroundingLabel(
        "guardrail",
        { ...unsourced, verdict: "violated", claimCount: 1, action: "observe" },
        t,
      ),
    ]).toEqual([
      "Factual grounding: no source consulted, and the reply states no fact that needs one · 8100 in / 240 out tokens, 3100 ms",
      "Factual grounding: 1 claim(s) stated with no source consulted (observe) · 8100 in / 240 out tokens, 3100 ms",
    ]);
  });

  test("a flagged review names the claim count and the action", () => {
    expect(
      guardrailGroundingLabel(
        "guardrail",
        { ...reviewed, verdict: "violated", claimCount: 2, action: "revise" },
        t,
      ),
    ).toStartWith(
      "Factual grounding: 2 claim(s) the sources do not support (revise)",
    );
  });

  // A review that could not run has no verdict and keeps the unchecked headline.
  test("a line with no verdict is not a review", () => {
    expect(
      guardrailGroundingLabel(
        "guardrail",
        { check: "factual_grounding", outcome: "analysis_failed" },
        t,
      ),
    ).toBeNull();
  });
});
