import { describe, expect, test } from "bun:test";
import type { DurationUnit } from "@/client/lib/duration";
import { formatDuration, readableDuration } from "@/client/lib/duration";

// Which unit a duration is READ in, as a table. The rule is the whole module, so the table is the
// whole test: every threshold, both sides, plus the inputs that are not durations at all.
//
// The last group matters most: a first-response median that cannot be computed must come back as
// `null` and never as a zero, or the dashboard reads "0" where it means "nothing to report".

describe("readableDuration", () => {
  const rows: [
    label: string,
    seconds: number | null,
    unit: DurationUnit | null,
    value: number | null,
  ][] = [
    ["zero is a duration, and it is seconds", 0, "second", 0],
    ["under two minutes stays in seconds", 95, "second", 95],
    ["seconds round to whole seconds", 42.6, "second", 43],
    ["two minutes exactly switches to minutes", 120, "minute", 2],
    ["one second short of it does not", 119, "second", 119],
    ["minutes round to whole minutes", 3599, "minute", 60],
    ["two hours exactly switches to hours", 7200, "hour", 2],
    ["one second short of it does not", 7199, "minute", 120],
    ["hours keep one decimal", 19080, "hour", 5.3],
    ["two days exactly switches to days", 172800, "day", 2],
    ["one second short of it does not", 172799, "hour", 47.99972222222222],
    ["a week reads in days", 604800, "day", 7],
    // Not durations. Every one of these has to be absence, never a number.
    ["null is absence", null, null, null],
    ["a negative interval is not a duration", -1, null, null],
    ["NaN is absence", Number.NaN, null, null],
    ["Infinity is absence", Number.POSITIVE_INFINITY, null, null],
  ];

  for (const [label, seconds, unit, value] of rows) {
    test(`${label} (${seconds})`, () => {
      const d = readableDuration(seconds);
      expect(d?.unit ?? null).toBe(unit);
      // Compared with a tolerance only where the rule itself carries a fraction.
      if (value == null) expect(d).toBeNull();
      else expect(d?.value ?? Number.NaN).toBeCloseTo(value, 4);
    });
  }
});

// `fractionDigits` only acts inside the formatter, so the table above cannot see it: a first-response
// median of 5.3 hours and one of 5.30555… hours carry the same `value`. These rows are what makes
// the precision part of the rule rather than a field nobody reads.
//
// Asserted against ICU's own rendering of the expected value and unit, with the locale pinned: the
// separator and the abbreviation belong to ICU, and pinning those would test the runtime's locale data.
describe("formatDuration precision", () => {
  const rows: [seconds: number, value: number, unit: string][] = [
    // Hours keep one decimal; dropping it turns a 5.3 h wait into "5 h".
    [19080, 5.3, "hour"],
    // And only one: the raw quotient is 5.30555…
    [19100, 5.3, "hour"],
    // Whole hours do not grow a trailing ".0".
    [7200, 2, "hour"],
    // Seconds and minutes are whole by rule, and stay whole through the formatter.
    [42.6, 43, "second"],
    [3599, 60, "minute"],
  ];
  for (const [seconds, value, unit] of rows) {
    test(`${seconds}s formats as ${value} ${unit}`, () => {
      const expected = new Intl.NumberFormat("en-US", {
        style: "unit",
        unit,
        unitDisplay: "short",
      }).format(value);
      expect(formatDuration(seconds, "en-US")).toBe(expected);
    });
  }
  test("absence formats as absence, not as a zero", () => {
    expect(formatDuration(null, "en-US")).toBeNull();
  });
});
