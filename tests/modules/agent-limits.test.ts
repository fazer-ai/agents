import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_PROACTIVE_PER_DAY,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_TURNS_PER_HOUR,
  MAX_PROACTIVE_PER_DAY,
  MAX_TURNS_PER_HOUR,
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
  // ceiling instead: the opposite of the intent, and not recoverable from that same field.
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
      retrySilence: true,
      maxTurnsPerHour: DEFAULT_MAX_TURNS_PER_HOUR,
      maxProactivePerDay: DEFAULT_MAX_PROACTIVE_PER_DAY,
    });
    // A bag that only carries the new knob must not silently reset the old one, and vice versa.
    expect(read({ maxToolCalls: 99 })).toEqual({
      maxToolCalls: 50,
      maxHistoryTokens: null,
      retrySilence: true,
      maxTurnsPerHour: DEFAULT_MAX_TURNS_PER_HOUR,
      maxProactivePerDay: DEFAULT_MAX_PROACTIVE_PER_DAY,
    });
  });
});

// The retry of an unexplained silence is ON unless the operator says `false`.
describe("limits.retrySilence", () => {
  const read = (limits: unknown) => readLimitsConfig({ limits });
  test("on by default, with no settings at all", () => {
    expect(readLimitsConfig(undefined).retrySilence).toBe(true);
    expect(readLimitsConfig({}).retrySilence).toBe(true);
    expect(read({}).retrySilence).toBe(true);
  });

  test("only an explicit false turns it off", () => {
    expect(read({ retrySilence: false }).retrySilence).toBe(false);
    expect(read({ retrySilence: true }).retrySilence).toBe(true);
    expect(read({ retrySilence: null }).retrySilence).toBe(true);
    expect(read({ retrySilence: "false" }).retrySilence).toBe(true);
  });
});

// The turn limit is ON for an agent that never set it, and "no limit" is a stored 0, not a missing key.
describe("readLimitsConfig — maxTurnsPerHour", () => {
  const read = (limits: unknown) => readLimitsConfig({ limits });

  test("absent, null or non-numeric reads as the default of 60", () => {
    expect(DEFAULT_MAX_TURNS_PER_HOUR).toBe(60);
    expect(readLimitsConfig(undefined).maxTurnsPerHour).toBe(60);
    expect(readLimitsConfig({}).maxTurnsPerHour).toBe(60);
    expect(read({ maxToolCalls: 4 }).maxTurnsPerHour).toBe(60);
    expect(read({ maxTurnsPerHour: null }).maxTurnsPerHour).toBe(60);
    expect(read({ maxTurnsPerHour: "sessenta" }).maxTurnsPerHour).toBe(60);
  });

  test("0 or below turns it off", () => {
    expect(read({ maxTurnsPerHour: 0 }).maxTurnsPerHour).toBe(0);
    expect(read({ maxTurnsPerHour: -5 }).maxTurnsPerHour).toBe(0);
  });

  test("a positive value is rounded and clamped to 1..1000", () => {
    expect(read({ maxTurnsPerHour: 7 }).maxTurnsPerHour).toBe(7);
    expect(read({ maxTurnsPerHour: 2.6 }).maxTurnsPerHour).toBe(3);
    expect(read({ maxTurnsPerHour: 0.2 }).maxTurnsPerHour).toBe(1);
    expect(read({ maxTurnsPerHour: 5000 }).maxTurnsPerHour).toBe(
      MAX_TURNS_PER_HOUR,
    );
  });
});

describe("readLimitsConfig — maxProactivePerDay", () => {
  const read = (limits: unknown) => readLimitsConfig({ limits });

  test("absent, null or non-numeric reads as the default of 10", () => {
    expect(DEFAULT_MAX_PROACTIVE_PER_DAY).toBe(10);
    expect(readLimitsConfig(undefined).maxProactivePerDay).toBe(10);
    expect(read({ maxTurnsPerHour: 4 }).maxProactivePerDay).toBe(10);
    expect(read({ maxProactivePerDay: null }).maxProactivePerDay).toBe(10);
    expect(read({ maxProactivePerDay: "dez" }).maxProactivePerDay).toBe(10);
  });

  test("0 or below turns it off, without touching the turn limit", () => {
    expect(read({ maxProactivePerDay: 0 })).toMatchObject({
      maxProactivePerDay: 0,
      maxTurnsPerHour: DEFAULT_MAX_TURNS_PER_HOUR,
    });
    expect(read({ maxProactivePerDay: -1 }).maxProactivePerDay).toBe(0);
  });

  test("a positive value is rounded and clamped to 1..1000", () => {
    expect(read({ maxProactivePerDay: 4 }).maxProactivePerDay).toBe(4);
    expect(read({ maxProactivePerDay: 0.3 }).maxProactivePerDay).toBe(1);
    expect(read({ maxProactivePerDay: 9999 }).maxProactivePerDay).toBe(
      MAX_PROACTIVE_PER_DAY,
    );
  });
});
