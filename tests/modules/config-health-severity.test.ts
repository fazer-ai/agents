import { describe, expect, test } from "bun:test";
import type { ConfigIssueKey } from "@/modules/agents/config-health";
import {
  type ConfigIssueSeverity,
  severityOf,
} from "@/modules/agents/config-health-severity";

// The decision table for how bad each warning is, written out rather than derived, because the whole
// value of the field is that somebody DECIDED per key. A test that recomputed the answer from the
// same source as the code would assert `x === x`; this one is the second opinion.
//
// What each column means is in config-health-severity.ts. In one line: blocking = the customer gets
// nothing, or gets an unscreened reply while the switch reads "on"; degraded = the customer is
// served and a feature that is on does not run; advisory = nothing is off.
const EXPECTED: Record<ConfigIssueKey, ConfigIssueSeverity> = {
  model: "blocking",
  modelNotRunnable: "blocking",
  modelNoEndpoint: "blocking",
  modelBadEndpoint: "blocking",
  guardrails: "blocking",
  guardrailsFailing: "blocking",
  contactAuth: "blocking",
  contactAuthNoUrl: "blocking",
  stt: "degraded",
  tts: "degraded",
  ttsNormalize: "degraded",
  memoryModel: "degraded",
  suggestionReviewModel: "degraded",
  modelFallback: "degraded",
  vision: "degraded",
  decisions: "degraded",
  knowledge: "degraded",
  embedding: "degraded",
  redirect: "degraded",
  contactAuthUnlockHandoff: "advisory",
  contactAuthSilentRefusal: "advisory",
  outOfHoursBoth: "advisory",
  outOfHoursChatwoot: "advisory",
  textCap: "advisory",
};

describe("config issue severity", () => {
  for (const [key, severity] of Object.entries(EXPECTED)) {
    test(`${key} is ${severity}`, () => {
      expect(severityOf(key as ConfigIssueKey)).toBe(severity);
    });
  }

  // The one distinction an automated caller actually acts on. Stated as a property rather than left
  // implicit in the table: the two states that mean "the customer is not being served as configured"
  // are what `healthy` is computed from, and an advisory issue must never be able to flip it.
  test("guardrails without a key is blocking, and an out-of-hours collision is not", () => {
    expect(severityOf("guardrails")).toBe("blocking");
    expect(severityOf("outOfHoursBoth")).toBe("advisory");
  });
});
