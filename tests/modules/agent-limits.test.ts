import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_TOOL_CALLS,
  readLimitsConfig,
} from "@/modules/agents/limits";

describe("readLimitsConfig — maxHistoryTokens", () => {
  const read = (limits: unknown) => readLimitsConfig({ limits });

  test("absent means no ceiling", () => {
    expect(readLimitsConfig(undefined).maxHistoryTokens).toBeNull();
    expect(readLimitsConfig({}).maxHistoryTokens).toBeNull();
    expect(read({}).maxHistoryTokens).toBeNull();
    expect(read({ maxToolCalls: 5 }).maxHistoryTokens).toBeNull();
  });

  // Zero and negatives disable it instead of clamping up to the floor. An operator who empties the
  // field in the editor is asking for "off", and clamping would hand them the TIGHTEST possible
  // ceiling instead — the opposite of the intent, and not recoverable from that same field.
  test("zero, negative and non-numeric all mean off, never the floor", () => {
    for (const raw of [0, -1, -5000, "12000", null, {}, Number.NaN]) {
      expect(read({ maxHistoryTokens: raw }).maxHistoryTokens).toBeNull();
    }
  });

  test("a value below the floor is raised to it", () => {
    expect(read({ maxHistoryTokens: 1 }).maxHistoryTokens).toBe(2_000);
    expect(read({ maxHistoryTokens: 1_999 }).maxHistoryTokens).toBe(2_000);
  });

  test("a value above the cap is lowered to it", () => {
    expect(read({ maxHistoryTokens: 9_000_000 }).maxHistoryTokens).toBe(
      1_000_000,
    );
  });

  test("a value in range is kept, rounded", () => {
    expect(read({ maxHistoryTokens: 12_000 }).maxHistoryTokens).toBe(12_000);
    expect(read({ maxHistoryTokens: 12_000.4 }).maxHistoryTokens).toBe(12_000);
  });

  test("it does not disturb the tool-call cap next to it", () => {
    expect(read({ maxHistoryTokens: 12_000 }).maxToolCalls).toBe(
      DEFAULT_MAX_TOOL_CALLS,
    );
    expect(read({ maxToolCalls: 3, maxHistoryTokens: 12_000 })).toEqual({
      maxToolCalls: 3,
      maxHistoryTokens: 12_000,
    });
    // A bag that only carries the new knob must not silently reset the old one, and vice versa.
    expect(read({ maxToolCalls: 99 })).toEqual({
      maxToolCalls: 50,
      maxHistoryTokens: null,
    });
  });
});
