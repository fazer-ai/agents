import { describe, expect, test } from "bun:test";
import {
  effectiveMaxResponseChars,
  MODEL_RESPONSE_CHAR_LIMIT,
  maxResponseCharsAcceptable,
  valueCharLimit,
} from "@/modules/tool-definitions/response-template";

// The three rules behind an HTTP tool's own response limit, as tables. What the
// runtime, the writers and the editor DO with them is tests/modules/tool-max-response-chars.test.ts.

describe("the limit a tool declares, as the runtime reads it", () => {
  test("absent, null or not a number is the default; anything else is clamped into the band", () => {
    const table: [unknown, number][] = [
      [undefined, 4000],
      [null, 4000],
      ["12000", 4000],
      [Number.NaN, 4000],
      [12_000, 12_000],
      [500, 500],
      [20_000, 20_000],
      [499, 500],
      [100, 500],
      [-1, 500],
      [20_001, 20_000],
      [50_000, 20_000],
      [8000.7, 8000],
    ];
    for (const [raw, want] of table) {
      expect([raw, effectiveMaxResponseChars(raw)]).toEqual([raw, want]);
    }
  });

  test("a writer accepts only an integer inside the band, or nothing at all", () => {
    const table: [unknown, boolean][] = [
      [undefined, true],
      [null, true],
      [500, true],
      [4000, true],
      [20_000, true],
      [499, false],
      [20_001, false],
      [0, false],
      [-1, false],
      [1500.5, false],
      [Number.NaN, false],
      ["8000", false],
    ];
    for (const [raw, want] of table) {
      expect([raw, maxResponseCharsAcceptable(raw)]).toEqual([raw, want]);
    }
  });

  test("the per-value cut is 2000 at the default and grows with the limit", () => {
    expect(valueCharLimit(MODEL_RESPONSE_CHAR_LIMIT)).toBe(2000);
    expect(valueCharLimit(500)).toBe(2000);
    expect(valueCharLimit(14_000)).toBe(12_000);
    expect(valueCharLimit(20_000)).toBe(18_000);
  });
});
