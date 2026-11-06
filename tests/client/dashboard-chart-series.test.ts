import { describe, expect, test } from "bun:test";
import {
  foldStacked,
  OTHER_KEY,
  tooltipRows,
} from "@/client/pages/dashboard/chart-series";

const series = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `s${i}`, label: `S${i}` }));

describe("foldStacked", () => {
  test("a chart within the palette draws every series as given", () => {
    const rows = [{ day: "d1", s0: 1, s1: 2 }];
    const out = foldStacked(rows, series(2), 8, "Other");
    expect(out.series).toEqual(series(2));
    expect(out.rows).toBe(rows);
    expect(out.folded).toEqual([]);
  });

  test("exactly as many series as colours folds nothing", () => {
    const rows = [Object.fromEntries(series(8).map((s) => [s.key, 1]))];
    expect(foldStacked(rows, series(8), 8, "Other").folded).toEqual([]);
  });

  test("past the palette, the smallest series by window total fold into Other, and the rest keep their order", () => {
    // s0 is the largest on the first day and among the smallest over the window.
    const totals = [10, 3, 40, 50, 60, 70, 80, 90, 100, 1, 2];
    const rows = [
      Object.fromEntries(series(11).map((s, i) => [s.key, i === 0 ? 10 : 0])),
      Object.fromEntries(
        series(11).map((s, i) => [s.key, i === 0 ? 0 : totals[i]]),
      ),
    ];
    const out = foldStacked(rows, series(11), 8, "Other");
    expect(out.folded.map((s) => s.key)).toEqual(["s0", "s1", "s9", "s10"]);
    expect(out.series.map((s) => s.key)).toEqual([
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
      "s8",
      OTHER_KEY,
    ]);
    expect(out.series.at(-1)?.label).toBe("Other");
    expect(out.rows[0]?.[OTHER_KEY]).toBe(10);
    expect(out.rows[1]?.[OTHER_KEY]).toBe(3 + 1 + 2);
  });

  test("one series over the palette still folds two, so Other never renames a single series", () => {
    const rows = [
      Object.fromEntries(series(9).map((s, i) => [s.key, 100 - i])),
    ];
    const out = foldStacked(rows, series(9), 8, "Other");
    expect(out.folded.map((s) => s.key)).toEqual(["s7", "s8"]);
    expect(out.series).toHaveLength(8);
  });

  test("a day where every folded series is null keeps Other null, so a band day stays blank", () => {
    const rows = [
      Object.fromEntries(series(10).map((s) => [s.key, null])),
      Object.fromEntries(series(10).map((s, i) => [s.key, i])),
    ];
    const out = foldStacked(rows, series(10), 8, "Other");
    expect(out.rows[0]?.[OTHER_KEY]).toBeNull();
    expect(out.rows[1]?.[OTHER_KEY]).toBe(0 + 1 + 2);
  });

  test("a tie in window totals keeps the earlier series", () => {
    const rows = [Object.fromEntries(series(9).map((s) => [s.key, 1]))];
    const out = foldStacked(rows, series(9), 8, "Other");
    expect(out.folded.map((s) => s.key)).toEqual(["s7", "s8"]);
  });
});

describe("tooltipRows", () => {
  const item = (key: string, value: unknown) => ({
    key,
    label: key.toUpperCase(),
    color: "#000",
    value,
  });

  test("lists the series with a value, largest first, and leaves zero and null out", () => {
    const out = tooltipRows(
      [item("a", 1), item("b", 0), item("c", null), item("d", 5), item("e", 3)],
      6,
    );
    expect(out.rows.map((r) => r.key)).toEqual(["d", "e", "a"]);
    expect(out.rest).toEqual({ count: 0, sum: 0 });
  });

  test("past the limit, the last slot becomes the count and sum of the rest", () => {
    const items = Array.from({ length: 11 }, (_, i) => item(`k${i}`, i + 1));
    const out = tooltipRows(items, 6);
    expect(out.rows.map((r) => r.value)).toEqual([11, 10, 9, 8, 7]);
    expect(out.rest).toEqual({ count: 6, sum: 1 + 2 + 3 + 4 + 5 + 6 });
  });

  test("exactly the limit lists every row with nothing left over", () => {
    const items = Array.from({ length: 6 }, (_, i) => item(`k${i}`, i + 1));
    const out = tooltipRows(items, 6);
    expect(out.rows).toHaveLength(6);
    expect(out.rest.count).toBe(0);
  });

  test("equal values keep the series order", () => {
    const out = tooltipRows([item("a", 2), item("b", 2), item("c", 3)], 6);
    expect(out.rows.map((r) => r.key)).toEqual(["c", "a", "b"]);
  });
});
