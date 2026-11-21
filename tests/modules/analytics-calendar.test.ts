import { describe, expect, test } from "bun:test";
import {
  CALENDAR_PRESETS,
  type CalendarUnit,
  presetDays,
  previousStop,
  shiftUnits,
  unitStart,
} from "@/modules/analytics/calendar";

// THE CALENDAR ARITHMETIC ON LOCAL DAYS, as a table. No instant is involved, so the answer is the
// same in every zone the console or the server reads in.

describe("the first day of a unit", () => {
  const table: [string, CalendarUnit, string][] = [
    // 2026-11-16 is a Monday, 2026-11-15 a Sunday.
    ["2026-11-16", "week", "2026-11-16"],
    ["2026-11-15", "week", "2026-11-09"],
    ["2026-11-18", "week", "2026-11-16"],
    ["2027-01-01", "week", "2026-12-28"],
    ["2026-04-10", "month", "2026-04-01"],
    ["2026-03-31", "quarter", "2026-01-01"],
    ["2026-04-01", "quarter", "2026-04-01"],
    ["2026-12-31", "quarter", "2026-10-01"],
    ["2026-08-15", "year", "2026-01-01"],
    ["2026-08-15", "day", "2026-08-15"],
  ];
  for (const [day, unit, want] of table)
    test(`${unit} of ${day}`, () => expect(unitStart(day, unit)).toBe(want));
});

describe("the same day some units away", () => {
  const table: [string, CalendarUnit, number, string | null][] = [
    ["2026-03-01", "day", -1, "2026-02-28"],
    ["2026-01-05", "week", -1, "2025-12-29"],
    ["2026-04-10", "month", -1, "2026-03-10"],
    ["2026-01-31", "month", -1, "2025-12-31"],
    ["2026-03-31", "month", -1, null],
    ["2026-03-29", "month", -1, null],
    ["2026-03-28", "month", -1, "2026-02-28"],
    ["2024-03-29", "month", -1, "2024-02-29"],
    ["2026-01-15", "quarter", -1, "2025-10-15"],
    ["2026-05-31", "quarter", -1, null],
    ["2026-10-01", "quarter", 1, "2027-01-01"],
    ["2024-02-29", "year", -1, null],
    ["2026-04-10", "year", -1, "2025-04-10"],
  ];
  for (const [day, unit, n, want] of table)
    test(`${day} ${n} ${unit}`, () =>
      expect(shiftUnits(day, unit, n)).toBe(want));
});

describe("the days a preset covers on a given day", () => {
  test("every preset on Friday 10 April 2026", () => {
    const out = Object.fromEntries(
      CALENDAR_PRESETS.map((p) => [p, presetDays(p, "2026-04-10")]),
    );
    expect(out).toEqual({
      today: { first: "2026-04-10", end: "2026-04-11" },
      yesterday: { first: "2026-04-09", end: "2026-04-10" },
      "this-week": { first: "2026-04-06", end: "2026-04-13" },
      "last-week": { first: "2026-03-30", end: "2026-04-06" },
      "this-month": { first: "2026-04-01", end: "2026-05-01" },
      "last-month": { first: "2026-03-01", end: "2026-04-01" },
      "this-quarter": { first: "2026-04-01", end: "2026-07-01" },
      "last-quarter": { first: "2026-01-01", end: "2026-04-01" },
      "this-year": { first: "2026-01-01", end: "2027-01-01" },
    });
  });
});

describe("where the previous period stops", () => {
  test("a closed period's ends where it starts", () =>
    expect(previousStop("2026-03-01", "month", null)).toEqual({
      first: "2026-02-01",
      stop: { day: "2026-03-01", at: "start" },
    }));

  test("a running one's at the same day of the unit before", () =>
    expect(
      previousStop("2026-04-01", "month", { today: "2026-04-10" }),
    ).toEqual({
      first: "2026-03-01",
      stop: { day: "2026-03-10", at: "time" },
    }));

  test("a running one whose day the unit before lacks takes all of it", () =>
    expect(
      previousStop("2026-03-01", "month", { today: "2026-03-31" }),
    ).toEqual({
      first: "2026-02-01",
      stop: { day: "2026-03-01", at: "start" },
    }));
});
