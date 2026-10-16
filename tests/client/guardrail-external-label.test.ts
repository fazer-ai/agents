import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import {
  guardrailExternalLabel,
  guardrailUncheckedLabel,
} from "@/client/lib/flowLabels";

// Each key's English default, with its placeholders filled, as the Logs page would show it.
const t = ((_k: string, o: string | { defaultValue: string }) => {
  if (typeof o === "string") return o;
  return o.defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    String((o as unknown as Record<string, unknown>)[k]),
  );
}) as unknown as TFunction;

describe("an external check line on the Logs page", () => {
  // The bug it catches: a block with no reason or latency on the row, so the operator cannot tell
  // why a reply never went out.
  test("says the decision, the latency and the reason", () => {
    expect(
      guardrailExternalLabel(
        "guardrail",
        {
          check: "external",
          decision: "block",
          action: "template",
          latencyMs: 2100,
          endpointReason: "MOTIVO-X1",
        },
        t,
      ),
    ).toBe(
      "The external check blocked the reply (template) · took 2100 ms · reason: MOTIVO-X1",
    );
  });

  // The bug it catches: a failed endpoint read as the built-in judge's failure, or the reply's fate
  // left unsaid.
  test("a failure names the cause and what happened to the reply", () => {
    const failed = {
      check: "external",
      outcome: "external_failed",
      cause: "http_status",
      httpStatus: 500,
      latencyMs: 40,
    };
    expect(
      guardrailExternalLabel("guardrail", { ...failed, unchecked: true }, t),
    ).toBe(
      "The external check could not decide (http_status 500), so the reply was let through unchecked · took 40 ms",
    );
    expect(
      guardrailExternalLabel(
        "guardrail",
        { ...failed, held: true, unchecked: false },
        t,
      ),
    ).toContain("so the reply was held");
    expect(
      guardrailUncheckedLabel("guardrail", { ...failed, unchecked: true }, t),
    ).toBeNull();
  });

  test("a built-in guardrail line is not the external check's", () => {
    expect(
      guardrailExternalLabel(
        "guardrail",
        { direction: "output", action: "template" },
        t,
      ),
    ).toBeNull();
  });
});
