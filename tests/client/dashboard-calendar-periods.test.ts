import { afterAll, describe, expect, test } from "bun:test";
import {
  type DashboardFilters,
  DEFAULT_FILTERS,
  previousWindow,
  type Range,
  rangeRunning,
  readFilters,
  readUpTo,
  windowOf,
  writeFilters,
} from "@/client/pages/dashboard/filters";

// CALENDAR PERIODS ON THE OPERATOR'S DASHBOARD. "Last month" is a link that keeps meaning last month,
// its days are cut at the viewer's own midnights (here São Paulo, three hours behind UTC, where the
// evening of the 30th is already December in UTC), and its previous period is the calendar period
// before: whole when it is over, up to the same day and time of day while it runs.

// Set before the describe blocks build their instants, which happens before any hook runs.
const zone = process.env.TZ;
process.env.TZ = "America/Sao_Paulo";
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const at = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi);
const filters = (range: Range): DashboardFilters => ({
  ...DEFAULT_FILTERS,
  range,
});

// The window the API is asked for, and the previous period's, as local wall-clock strings.
function read(range: Range, now: Date) {
  const w = windowOf(filters(range), now);
  const cur = readUpTo(w, now);
  const prev = previousWindow(w, now);
  const fmt = (d: Date | null | undefined) =>
    d
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      : null;
  return {
    current: [fmt(cur.since), fmt(cur.until)],
    previous: prev ? [fmt(prev.since), fmt(prev.until)] : null,
    days: [w.firstDay, w.lastDay, w.days],
    prevDays: prev ? [prev.firstDay, prev.lastDay, prev.days] : null,
  };
}

describe("a calendar preset as a window, in the viewer's zone", () => {
  const now = at(2026, 4, 10, 10);
  const table: [Range, string[], string[] | null][] = [
    [
      "today",
      ["2026-04-10 00:00", "2026-04-10 10:00"],
      ["2026-04-09 00:00", "2026-04-09 10:00"],
    ],
    [
      "yesterday",
      ["2026-04-09 00:00", "2026-04-10 00:00"],
      ["2026-04-08 00:00", "2026-04-09 00:00"],
    ],
    // 10 April 2026 is a Friday; its week starts on Monday the 6th.
    [
      "this-week",
      ["2026-04-06 00:00", "2026-04-10 10:00"],
      ["2026-03-30 00:00", "2026-04-03 10:00"],
    ],
    [
      "last-week",
      ["2026-03-30 00:00", "2026-04-06 00:00"],
      ["2026-03-23 00:00", "2026-03-30 00:00"],
    ],
    [
      "this-month",
      ["2026-04-01 00:00", "2026-04-10 10:00"],
      ["2026-03-01 00:00", "2026-03-10 10:00"],
    ],
    [
      "last-month",
      ["2026-03-01 00:00", "2026-04-01 00:00"],
      ["2026-02-01 00:00", "2026-03-01 00:00"],
    ],
    [
      "this-quarter",
      ["2026-04-01 00:00", "2026-04-10 10:00"],
      ["2026-01-01 00:00", "2026-01-10 10:00"],
    ],
    [
      "last-quarter",
      ["2026-01-01 00:00", "2026-04-01 00:00"],
      ["2025-10-01 00:00", "2026-01-01 00:00"],
    ],
    [
      "this-year",
      ["2026-01-01 00:00", "2026-04-10 10:00"],
      ["2025-01-01 00:00", "2025-04-10 10:00"],
    ],
  ];
  for (const [range, current, previous] of table)
    test(`${range} on Friday 10 April 2026 at 10:00`, () => {
      const r = read(range, now);
      expect([range, r.current]).toEqual([range, current]);
      expect([range, r.previous]).toEqual([range, previous]);
    });

  test("a closed month is compared with the whole month before, whatever its length", () => {
    const r = read("last-month", now);
    expect(r.days).toEqual(["2026-03-01", "2026-03-31", 31]);
    expect(r.prevDays).toEqual(["2026-02-01", "2026-02-28", 28]);
  });

  test("a running period covers the days up to today, and its comparison as many", () => {
    const r = read("this-month", now);
    expect(r.days).toEqual(["2026-04-01", "2026-04-10", 10]);
    expect(r.prevDays).toEqual(["2026-03-01", "2026-03-10", 10]);
  });

  test("a running month whose day the month before does not have compares with all of it", () => {
    const r = read("this-month", at(2026, 3, 31, 15));
    expect(r.current).toEqual(["2026-03-01 00:00", "2026-03-31 15:00"]);
    expect(r.previous).toEqual(["2026-02-01 00:00", "2026-03-01 00:00"]);
    expect(r.prevDays).toEqual(["2026-02-01", "2026-02-28", 28]);
  });

  test("the week starts on Monday: a Sunday night is still the week begun six days before", () => {
    const sunday = read("this-week", at(2026, 11, 15, 23));
    expect(sunday.current).toEqual(["2026-11-09 00:00", "2026-11-15 23:00"]);
    const monday = read("this-week", at(2026, 11, 16, 9));
    expect(monday.current).toEqual(["2026-11-16 00:00", "2026-11-16 09:00"]);
    expect(read("last-week", at(2026, 11, 16, 9)).current).toEqual([
      "2026-11-09 00:00",
      "2026-11-16 00:00",
    ]);
  });

  test("the month turns at the local midnight, not at UTC's", () => {
    // 22:00 on 30 November in São Paulo is 01:00 on 1 December in UTC.
    const evening = at(2026, 11, 30, 22);
    expect(evening.toISOString()).toBe("2026-12-01T01:00:00.000Z");
    expect(read("this-month", evening).current).toEqual([
      "2026-11-01 00:00",
      "2026-11-30 22:00",
    ]);
    expect(read("yesterday", evening).current).toEqual([
      "2026-11-29 00:00",
      "2026-11-30 00:00",
    ]);
    const afterMidnight = at(2026, 12, 1, 0, 15);
    expect(read("this-month", afterMidnight).current).toEqual([
      "2026-12-01 00:00",
      "2026-12-01 00:15",
    ]);
    expect(read("yesterday", afterMidnight).current).toEqual([
      "2026-11-30 00:00",
      "2026-12-01 00:00",
    ]);
  });

  test("the quarter before the first one is the last of the year before", () => {
    const r = read("last-quarter", at(2026, 1, 15, 10));
    expect(r.current).toEqual(["2025-10-01 00:00", "2026-01-01 00:00"]);
    expect(r.previous).toEqual(["2025-07-01 00:00", "2025-10-01 00:00"]);
  });

  test("a trailing window keeps its rule: the same days before, at the same time of day", () => {
    const r = read("7d", now);
    expect(r.current).toEqual(["2026-04-04 00:00", "2026-04-10 10:00"]);
    expect(r.previous).toEqual(["2026-03-28 00:00", "2026-04-03 10:00"]);
  });

  test("only the presets of the current unit say they are running", () => {
    const running = (
      [
        "today",
        "yesterday",
        "this-week",
        "last-week",
        "this-month",
        "last-month",
        "this-quarter",
        "last-quarter",
        "this-year",
        "7d",
        "all",
        "custom",
      ] as Range[]
    ).filter(rangeRunning);
    expect(running).toEqual([
      "today",
      "this-week",
      "this-month",
      "this-quarter",
      "this-year",
    ]);
  });
});

describe("the preset is what the link carries", () => {
  test("a calendar preset round-trips by its name, with no dates", () => {
    const p = writeFilters(filters("last-month"));
    expect(p.toString()).toBe("range=last-month");
    expect(readFilters(p).range).toBe("last-month");
  });

  test("the same link resolves to the month before the day it is opened", () => {
    const f = readFilters(new URLSearchParams("range=last-month"));
    expect(read(f.range, at(2026, 4, 10, 10)).current).toEqual([
      "2026-03-01 00:00",
      "2026-04-01 00:00",
    ]);
    expect(read(f.range, at(2026, 5, 10, 10)).current).toEqual([
      "2026-04-01 00:00",
      "2026-05-01 00:00",
    ]);
  });

  test("dates beside a preset are ignored, and the old links still read", () => {
    expect(
      readFilters(
        new URLSearchParams("range=this-week&from=2026-01-01&to=2026-01-02"),
      ),
    ).toMatchObject({ range: "this-week", from: null, to: null });
    for (const r of ["7d", "30d", "90d", "12m", "all"] as const)
      expect(readFilters(new URLSearchParams(`range=${r}`)).range).toBe(r);
    expect(
      readFilters(
        new URLSearchParams("range=custom&from=2026-02-27&to=2026-03-01"),
      ),
    ).toMatchObject({ range: "custom", from: "2026-02-27", to: "2026-03-01" });
  });

  test("a name that is not a preset opens on the default view", () => {
    for (const q of [
      "range=last-decade",
      "range=this-week ",
      "range=Last-Month",
    ])
      expect(readFilters(new URLSearchParams(q)).range).toBe(
        DEFAULT_FILTERS.range,
      );
  });
});
