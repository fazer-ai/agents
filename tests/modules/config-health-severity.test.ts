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
  modelUnset: "blocking",
  modelNoEndpoint: "blocking",
  guardrails: "blocking",
  guardrailsFailing: "blocking",
  contactAuth: "blocking",
  contactAuthNoUrl: "blocking",
  stt: "degraded",
  tts: "degraded",
  ttsNormalize: "degraded",
  memoryModel: "degraded",
  modelFallback: "degraded",
  vision: "degraded",
  knowledge: "degraded",
  embedding: "degraded",
  redirect: "degraded",
  contactAuthUnlockHandoff: "advisory",
  contactAuthSilentRefusal: "advisory",
  outOfHoursBoth: "advisory",
  outOfHoursChatwoot: "advisory",
  textCap: "advisory",
};

// The key union, read out of the source the same way tests/modules/config-issue-i18n.test.ts reads
// it. The Record above is already exhaustive by type, so a new key fails the BUILD — this is what
// catches the other direction: a key removed from the union while both tables still carry it, which
// compiles fine and leaves a severity for something that can no longer be raised.
const source = await Bun.file(
  new URL("../../src/modules/agents/config-health.ts", import.meta.url),
).text();
const start = source.indexOf("export type ConfigIssueKey =");
const union = source.slice(start, source.indexOf(";", start));
const keys = [...union.matchAll(/\|\s*"([a-zA-Z]+)"/g)].map((m) => m[1] ?? "");

describe("config issue severity", () => {
  test("the key list is read from the source, and it found something", () => {
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain("guardrails");
  });

  test("every key in the union has a severity, and no extras are classified", () => {
    expect(keys.slice().sort()).toEqual(Object.keys(EXPECTED).sort());
  });

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
