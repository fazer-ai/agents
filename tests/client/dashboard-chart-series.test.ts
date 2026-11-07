import { describe, expect, test } from "bun:test";
import {
  arrangeSeries,
  assignSlots,
  lineSummary,
  OTHER_KEY,
  stackDetail,
  stackSummary,
} from "@/client/pages/dashboard/chart-series";

const series = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `s${i}`, label: `S${i}` }));

const item = (key: string, value: unknown) => ({
  key,
  label: key.toUpperCase(),
  color: `c-${key}`,
  value,
});

describe("arrangeSeries", () => {
  test("within the palette, every series is kept, largest window total first, colours by caller order", () => {
    const rows = [
      { day: "d1", s0: 1, s1: 5, s2: 3 },
      { day: "d2", s0: 1, s1: 0, s2: 3 },
    ];
    const out = arrangeSeries(rows, series(3), 8, true);
    expect(out.kept.map((s) => s.key)).toEqual(["s2", "s1", "s0"]);
    expect(out.folded).toEqual([]);
    expect([...out.slot]).toEqual([
      ["s0", 0],
      ["s1", 1],
      ["s2", 2],
    ]);
    // Nothing to sum, so the rows are the caller's.
    expect(out.rows).toBe(rows);
  });

  test("a tie keeps the caller's order", () => {
    const rows = [{ s0: 2, s1: 2, s2: 2 }];
    expect(
      arrangeSeries(rows, series(3), 8, false).kept.map((s) => s.key),
    ).toEqual(["s0", "s1", "s2"]);
  });

  test("exactly as many series as colours folds nothing", () => {
    const rows = [Object.fromEntries(series(8).map((s) => [s.key, 1]))];
    expect(arrangeSeries(rows, series(8), 8, true).folded).toEqual([]);
  });

  test("past the palette, the smallest by window total form the group, largest first, and the rows carry its sum", () => {
    // s0 is the largest on the first day and among the smallest over the window.
    const totals = [10, 3, 40, 50, 60, 70, 80, 90, 100, 1, 2];
    const rows = [
      Object.fromEntries(series(11).map((s, i) => [s.key, i === 0 ? 10 : 0])),
      Object.fromEntries(
        series(11).map((s, i) => [s.key, i === 0 ? 0 : totals[i]]),
      ),
    ];
    const out = arrangeSeries(rows, series(11), 8, true);
    expect(out.kept.map((s) => s.key)).toEqual([
      "s8",
      "s7",
      "s6",
      "s5",
      "s4",
      "s3",
      "s2",
    ]);
    expect(out.folded.map((s) => s.key)).toEqual(["s0", "s1", "s10", "s9"]);
    // Colour follows the caller's order among the kept, not the rank.
    expect(out.slot.get("s2")).toBe(0);
    expect(out.slot.get("s8")).toBe(6);
    expect(out.rows.map((r) => r[OTHER_KEY])).toEqual([10, 6]);
  });

  test("a day where no folded series has a value sums to null, not zero", () => {
    const rows = [
      Object.fromEntries(series(9).map((s, i) => [s.key, i < 7 ? 5 : null])),
      Object.fromEntries(series(9).map((s) => [s.key, 1])),
    ];
    const out = arrangeSeries(rows, series(9), 8, true);
    expect(out.rows[0]?.[OTHER_KEY]).toBeNull();
    expect(out.rows[1]?.[OTHER_KEY]).toBe(2);
  });

  test("a line chart is not summed", () => {
    const rows = [Object.fromEntries(series(9).map((s) => [s.key, 1]))];
    const out = arrangeSeries(rows, series(9), 8, false);
    expect(out.folded).toHaveLength(2);
    expect(out.rows).toBe(rows);
  });
});

describe("assignSlots", () => {
  test("a first render gives the slots in the caller's order", () => {
    expect([...assignSlots(["a", "b", "c"], new Map(), 8)]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  test("a series that stays kept keeps its slot when another leaves, and a newcomer takes the free one", () => {
    const before = assignSlots(["s0", "s1", "s2"], new Map(), 3);
    const after = assignSlots(["s1", "s2", "s3"], before, 3);
    expect(after.get("s1")).toBe(1);
    expect(after.get("s2")).toBe(2);
    expect(after.get("s3")).toBe(0);
  });

  test("a remembered slot past the palette is dropped", () => {
    expect(assignSlots(["a"], new Map([["a", 9]]), 8).get("a")).toBe(0);
  });
});

describe("arrangeSeries across renders", () => {
  test("a series leaving the kept set moves no other series' colour", () => {
    const rows = [Object.fromEntries(series(9).map((s, i) => [s.key, 10 - i]))];
    const first = arrangeSeries(rows, series(9), 8, true);
    // s0 falls to the bottom of the window; s7 enters the kept set.
    const next = [{ ...rows[0], s0: 0 }];
    const second = arrangeSeries(next, series(9), 8, true, first.slot);
    for (const key of ["s1", "s2", "s3", "s4", "s5", "s6"])
      expect(second.slot.get(key)).toBe(first.slot.get(key));
    expect(second.slot.get("s7")).toBe(first.slot.get("s0"));
  });
});

describe("stackSummary", () => {
  test("reads the stack top to bottom: the group first, then the kept from the top layer to the base", () => {
    const out = stackSummary([item("a", 9), item("b", 5), item("c", 2)], {
      count: 3,
      value: 1.5,
    });
    expect(out.rows.map((r) => r.key)).toEqual(["c", "b", "a"]);
    expect(out.other).toEqual({ count: 3, value: 1.5 });
  });

  test("a series at zero or with no value that day is not listed", () => {
    const out = stackSummary(
      [item("a", 9), item("b", 0), item("c", null)],
      null,
    );
    expect(out.rows.map((r) => r.key)).toEqual(["a"]);
    expect(out.other).toBeNull();
  });

  test("a group at zero that day is not shown", () => {
    expect(stackSummary([item("a", 1)], { count: 2, value: 0 }).other).toBe(
      null,
    );
  });

  test("lists every legend series on a line of its own and the group with the legend's count, however many there are", () => {
    const kept = [6, 5, 4, 3, 2, 1, 0.5].map((v, i) => item(`k${i}`, v));
    const out = stackSummary(kept, { count: 4, value: 0.25 });
    expect(out.rows.map((r) => r.key)).toEqual([
      "k6",
      "k5",
      "k4",
      "k3",
      "k2",
      "k1",
      "k0",
    ]);
    expect(out.other).toEqual({ count: 4, value: 0.25 });
  });

  test("with no group, nothing forms one", () => {
    const kept = [6, 5, 4, 3, 2, 1, 0.5].map((v, i) => item(`k${i}`, v));
    expect(stackSummary(kept, null).other).toBeNull();
  });
});

describe("lineSummary", () => {
  test("reads the lines top to bottom on that day: the highest value first, a zero kept", () => {
    const out = lineSummary(
      [item("a", 0.2), item("b", 0.9), item("c", 0), item("d", null)],
      0,
    );
    expect(out.rows.map((r) => r.key)).toEqual(["b", "a", "c"]);
    expect(out.other).toBeNull();
  });

  test("a line with no value that day keeps its row only when it has a previous value to show, under the lines that have one", () => {
    const out = lineSummary(
      [{ ...item("a", null), compared: true }, item("b", 0.4), item("c", null)],
      0,
    );
    expect(out.rows.map((r) => [r.key, r.value])).toEqual([
      ["b", 0.4],
      ["a", null],
    ]);
  });

  test("a tie keeps the legend's order", () => {
    expect(
      lineSummary([item("a", 1), item("b", 1)], 0).rows.map((r) => r.key),
    ).toEqual(["a", "b"]);
  });

  test("every kept line has its row, and the group closes the list with the legend's count and no value", () => {
    const kept = [1, 2, 3, 4, 5, 6, 7].map((v, i) => item(`k${i}`, v));
    const out = lineSummary(kept, 3);
    expect(out.rows).toHaveLength(7);
    expect(out.other).toEqual({ count: 3, value: null });
  });
});

describe("stackDetail", () => {
  test("lists every series top to bottom, the group's members under its line, with shares of the day", () => {
    const row = { a: 6, b: 3, x: 0.5, y: 0.5, z: null };
    const out = stackDetail(
      row,
      [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
      [
        { key: "x", label: "X" },
        { key: "y", label: "Y" },
        { key: "z", label: "Z" },
      ],
    );
    expect(out.total).toBe(10);
    expect(out.group).toMatchObject({ key: OTHER_KEY, value: 1, share: 0.1 });
    expect(out.rows.map((r) => [r.key, r.value, r.share, r.member])).toEqual([
      ["z", 0, 0, true],
      ["y", 0.5, 0.05, true],
      ["x", 0.5, 0.05, true],
      ["b", 3, 0.3, false],
      ["a", 6, 0.6, false],
    ]);
  });

  test("a day at zero has no shares", () => {
    const out = stackDetail({ a: 0 }, [{ key: "a", label: "A" }], []);
    expect(out.total).toBe(0);
    expect(out.group).toBeNull();
    expect(out.rows[0]?.share).toBeNull();
  });
});
