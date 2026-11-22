import { describe, expect, test } from "bun:test";
import {
  type DashboardFilters,
  DEFAULT_FILTERS,
  daysRead,
  type NarrowingFilter,
  narrowingFilters,
  periodProgress,
  previousWindow,
  type Range,
  windowOf,
} from "@/client/pages/dashboard/filters";
import { shortDaysLabel } from "@/client/pages/dashboard/period";

// THE DASHBOARD'S FILTER BAND, AS DECISIONS. Which filters are chips, how far a running calendar
// period has gone, which days the comparison is named by, and the short form of a stretch of days.

const f = (patch: Partial<DashboardFilters>): DashboardFilters => ({
  ...DEFAULT_FILTERS,
  ...patch,
});

describe("a filter is a chip only when it narrows the view", () => {
  const cases: [string, Partial<DashboardFilters>, NarrowingFilter[]][] = [
    ["the default view", {}, []],
    ["every source", { source: "all" }, []],
    ["the real segment, the default", { source: "inbox" }, []],
    ["an audience outside the client segment", { audience: "anonymous" }, []],
    ["a period alone", { range: "this-month" }, []],
    ["an agent", { agentId: "7" }, ["agent"]],
    ["an inbox", { inboxId: "3" }, ["inbox"]],
    ["the playground", { source: "playground" }, ["source"]],
    ["the client segment", { source: "client" }, ["source"]],
    [
      "the client segment and an audience",
      { source: "client", audience: "identified" },
      ["source", "audience"],
    ],
    [
      "everything, in the band's order",
      {
        source: "client",
        audience: "anonymous",
        inboxId: "3",
        agentId: "7",
      },
      ["agent", "inbox", "source", "audience"],
    ],
  ];
  for (const [name, patch, chips] of cases)
    test(name, () => expect(narrowingFilters(f(patch))).toEqual(chips));
});

describe("how far a running calendar period has gone", () => {
  const at = new Date(2026, 3, 10, 6, 0);
  test("this month on April 10 at 06:00 is day 10 of 30", () => {
    const p = periodProgress("this-month", at);
    expect(p?.day).toBe(10);
    expect(p?.total).toBe(30);
    expect(p?.fraction).toBeCloseTo((9 + 0.25) / 30, 6);
  });
  test("this week starts on Monday: a Friday is day 5 of 7", () => {
    expect(periodProgress("this-week", at)).toMatchObject({ day: 5, total: 7 });
  });
  test("this quarter and this year count their own days", () => {
    expect(periodProgress("this-quarter", at)).toMatchObject({
      day: 10,
      total: 91,
    });
    expect(periodProgress("this-year", at)).toMatchObject({
      day: 100,
      total: 365,
    });
  });
  test("today is day 1 of 1, a quarter past at 06:00", () => {
    const p = periodProgress("today", at);
    expect(p).toMatchObject({ day: 1, total: 1 });
    expect(p?.fraction).toBeCloseTo(0.25, 6);
  });
  const closed: Range[] = [
    "yesterday",
    "last-week",
    "last-month",
    "last-quarter",
    "7d",
    "30d",
    "all",
    "custom",
  ];
  for (const range of closed)
    test(`${range} does not run`, () =>
      expect(periodProgress(range, at)).toBeNull());
});

describe("the days the comparison is named by", () => {
  const now = new Date(2026, 3, 10, 10, 0);
  const of = (patch: Partial<DashboardFilters>) =>
    daysRead(previousWindow(windowOf(f(patch), now), now));
  test("a closed month: the whole month before, ending on its last day", () => {
    expect(of({ range: "last-month" })).toEqual({
      first: "2026-02-01",
      last: "2026-02-28",
      partial: false,
    });
  });
  test("a running month: the same days of the month before, cut inside its last day", () => {
    expect(of({ range: "this-month" })).toEqual({
      first: "2026-03-01",
      last: "2026-03-10",
      partial: true,
    });
  });
  test("a trailing window: the same number of days before, up to the read's time of day", () => {
    expect(of({ range: "7d" })).toEqual({
      first: "2026-03-28",
      last: "2026-04-03",
      partial: true,
    });
  });
  test("all time, and the first instant of today, name no days", () => {
    expect(of({ range: "all" })).toBeNull();
    const midnight = new Date(2026, 3, 10, 0, 0);
    expect(
      daysRead(
        previousWindow(windowOf(f({ range: "today" }), midnight), midnight),
      ),
    ).toBeNull();
  });
});

describe("a stretch of days in short", () => {
  test("drops the year inside one year, in both languages", () => {
    expect(shortDaysLabel("en", "2026-04-01", "2026-04-10")).toBe(
      "Apr 1 to 10",
    );
    expect(shortDaysLabel("pt-BR", "2026-04-01", "2026-04-10", "a")).toBe(
      "1 a 10 de abr.",
    );
    expect(shortDaysLabel("en", "2026-04-10", "2026-04-10")).toBe("Apr 10");
  });
  test("keeps it when the stretch spans two", () => {
    expect(shortDaysLabel("en", "2025-12-29", "2026-01-04")).toBe(
      "Dec 29, 2025 to Jan 4, 2026",
    );
  });
});
