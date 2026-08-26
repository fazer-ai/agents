import { describe, expect, test } from "bun:test";
import type { DurationUnit } from "@/client/lib/duration";
import { formatDuration, readableDuration } from "@/client/lib/duration";

// Which unit a duration is READ in, as a table. The rule is the whole module, so the table is the
// whole test: every threshold, both sides, plus the inputs that are not durations at all.
//
// The last group is the one this KPI exists for. A first-response median that cannot be computed
// must come back as `null` and never as a zero. The dashboard reading "0" where it means "nothing
// to report" is the defect issue #283 is about, and a formatter that answers "0 s" would put it
// back one layer down.

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
// Asserted on the DIGITS, with the locale pinned: the separator and the unit abbreviation belong to
// ICU, and pinning those would make this a test of the runtime's locale data.
describe("formatDuration precision", () => {
  const rows: [seconds: number, pattern: RegExp][] = [
    // Hours keep one decimal; dropping it turns a 5.3 h wait into "5 h".
    [19080, /^5[.,]3\D/],
    // And only one: the raw quotient is 5.30555…
    [19100, /^5[.,]3\D/],
    // Whole hours do not grow a trailing ".0".
    [7200, /^2\D/],
    // Seconds and minutes are whole by rule, and stay whole through the formatter.
    [42.6, /^43\D/],
    [3599, /^60\D/],
  ];
  for (const [seconds, pattern] of rows) {
    test(`${seconds}s formats as ${pattern}`, () => {
      expect(formatDuration(seconds, "en-US") ?? "").toMatch(pattern);
    });
  }
  test("absence formats as absence, not as a zero", () => {
    expect(formatDuration(null, "en-US")).toBeNull();
  });
});
