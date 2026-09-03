import { describe, expect, test } from "bun:test";
import {
  AGENT_MODES,
  ingestsContinuously,
  isMonitoring,
  normalizeAgentMode,
} from "@/modules/agents/mode";
import { isTestSilenced, shouldRunReset } from "@/modules/agents/test-mode";

// The mode is a plain string column read by many callers; these are the answers every one of them
// has to agree on (issue #209).

describe("normalizeAgentMode", () => {
  test("every declared mode reads back as itself", () => {
    for (const m of AGENT_MODES) expect(normalizeAgentMode(m)).toBe(m);
  });

  test("anything else reads as production, as the column always has", () => {
    expect(normalizeAgentMode(null)).toBe("production");
    expect(normalizeAgentMode(undefined)).toBe("production");
    expect(normalizeAgentMode("")).toBe("production");
    expect(normalizeAgentMode("staging")).toBe("production");
  });

  test("monitoring is NOT collapsed into production", () => {
    // The failure this function exists to prevent: read through a two-way ternary, a monitoring
    // agent came back as a fully answering one.
    expect(normalizeAgentMode("monitoring")).not.toBe("production");
  });
});

describe("isMonitoring", () => {
  test("only the monitoring mode", () => {
    expect(isMonitoring("monitoring")).toBe(true);
    expect(isMonitoring("production")).toBe(false);
    expect(isMonitoring("test")).toBe(false);
    expect(isMonitoring("")).toBe(false);
  });

  test("the test-mode predicates do not silence or reset a monitoring agent on their own", () => {
    // Which is why every silence has its own arm: nothing here refuses the third mode.
    expect(isTestSilenced("monitoring", null)).toBe(false);
    expect(shouldRunReset("monitoring", new Date())).toBe(false);
  });
});

describe("ingestsContinuously", () => {
  test("production and monitoring ingest; test keeps its cost fence; unknown does not", () => {
    expect(ingestsContinuously("production")).toBe(true);
    expect(ingestsContinuously("monitoring")).toBe(true);
    expect(ingestsContinuously("test")).toBe(false);
    expect(ingestsContinuously("")).toBe(false);
  });
});
