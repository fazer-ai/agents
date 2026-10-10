import { describe, expect, test } from "bun:test";
import { isTestSilenced, shouldRunReset } from "@/modules/agents/test-mode";

describe("isTestSilenced", () => {
  test("production agents are never silenced", () => {
    expect(isTestSilenced("production", null)).toBe(false);
    expect(isTestSilenced("production", new Date())).toBe(false);
  });

  test("a test agent is silenced until the conversation is activated", () => {
    expect(isTestSilenced("test", null)).toBe(true);
  });

  test("a test agent fires once the conversation has been activated with /teste", () => {
    expect(isTestSilenced("test", new Date())).toBe(false);
  });
});

describe("shouldRunReset", () => {
  test("runs only once test mode is active (test + activated)", () => {
    expect(shouldRunReset("test", new Date())).toBe(true);
  });

  test("does NOT run before /teste (test, not activated): /reset defers to the silence gate", () => {
    // Regression for the bug where /reset before /teste made the agent answer. shouldRunReset is false
    // here, so the webhook skips the wipe and falls through to the test-mode gate, which silences —
    // exactly the complement of isTestSilenced("test", null) === true.
    expect(shouldRunReset("test", null)).toBe(false);
    expect(isTestSilenced("test", null)).toBe(true);
  });

  test("does NOT run for a production agent (/reset is ordinary text there)", () => {
    expect(shouldRunReset("production", new Date())).toBe(false);
    expect(shouldRunReset("production", null)).toBe(false);
  });
});
