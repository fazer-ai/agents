import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FILTERS,
  periodsOf,
  trendPointHref,
  type Window,
} from "@/client/pages/dashboard/filters";
import {
  groupOf,
  lastDayOf,
  periodDays,
  periodLabels,
  periodWindow,
} from "@/client/pages/dashboard/period";
import { dayState } from "@/client/pages/dashboard/useMetrics";

// A LONG WINDOW'S POINTS ARE WEEKS OR MONTHS, and the console names them as such: the axis, the
// tooltip and the detail say which days a point covers, an edge group only the window's own days,
// and a click on a point opens exactly those days' conversations.

const local = (day: string) => new Date(`${day}T00:00:00`);

function win(first: string, last: string): Window {
  const until = local(last);
  until.setDate(until.getDate() + 1);
  return {
    since: local(first),
    until,
    firstDay: first,
    lastDay: last,
    days: null,
  };
}

describe("the groups of a window", () => {
  test("a week starts on Monday and a month on its first day", () => {
    expect(groupOf("2026-03-15", "week")).toBe("2026-03-09");
    expect(groupOf("2026-03-16", "week")).toBe("2026-03-16");
    expect(groupOf("2026-01-01", "week")).toBe("2025-12-29");
    expect(groupOf("2026-02-28", "month")).toBe("2026-02-01");
    expect(lastDayOf("2026-03-09", "week")).toBe("2026-03-15");
    expect(lastDayOf("2024-02-01", "month")).toBe("2024-02-29");
    expect(lastDayOf("2026-12-01", "month")).toBe("2026-12-31");
  });

  test("a window starting on a Wednesday has a first week of its own days", () => {
    const w = win("2026-03-11", "2026-03-25");
    expect(periodsOf(w, "week")).toEqual([
      "2026-03-09",
      "2026-03-16",
      "2026-03-23",
    ]);
    const bounds = { first: w.firstDay, last: w.lastDay };
    expect(periodDays("2026-03-09", "week", bounds)).toEqual({
      first: "2026-03-11",
      last: "2026-03-15",
    });
    expect(periodDays("2026-03-23", "week", bounds)).toEqual({
      first: "2026-03-23",
      last: "2026-03-25",
    });
    expect(periodsOf(win("2025-11-20", "2026-03-18"), "month")).toEqual([
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });

  test("the labels name the days a week covers in the window, and the month", () => {
    const bounds = { first: "2026-03-11", last: "2026-03-25" };
    const week = periodLabels("en-US", "week", bounds, "to");
    expect(week.long("2026-03-16")).toBe("Mar 16 to 22");
    // A week across two months names both, and no label carries a dash.
    expect(week.long("2026-03-23")).toBe("Mar 23 to 25");
    expect(periodLabels("en-US", "week").long("2026-03-30")).toBe(
      "Mar 30 to Apr 5",
    );
    expect(periodLabels("pt-BR", "week", bounds, "a").long("2026-03-16")).toBe(
      "16 a 22 de mar.",
    );
    expect(week.long("2026-03-09")).toBe("Mar 11 to 15");
    expect(week.tick("2026-03-09")).toBe("Mar 11");
    const month = periodLabels("en-US", "month", bounds);
    expect(month.long("2026-03-01")).toBe("March 2026");
    expect(month.tick("2026-03-01")).toBe("Mar 26");
    expect(periodLabels("en-US", "day").long("2026-03-09")).toBe("Mar 9");
  });

  test("a point of a weekly chart opens the conversations of its days in the window", () => {
    const bounds = { first: "2026-03-11", last: "2026-03-25" };
    const w = periodWindow("2026-03-09", "week", bounds);
    expect(w.since.getTime()).toBe(local("2026-03-11").getTime());
    expect(w.until.getTime()).toBe(local("2026-03-16").getTime());
    const href = new URL(
      trendPointHref(
        DEFAULT_FILTERS,
        "2026-03-09",
        "none",
        "resolution",
        undefined,
        {
          grain: "week",
          bounds,
        },
      ),
      "http://x",
    );
    expect(href.searchParams.get("createdSince")).toBe(
      local("2026-03-11").toISOString(),
    );
    expect(href.searchParams.get("createdUntil")).toBe(
      local("2026-03-16").toISOString(),
    );
    const day = new URL(
      trendPointHref(DEFAULT_FILTERS, "2026-03-11", "none", "resolution"),
      "http://x",
    );
    expect(day.searchParams.get("createdUntil")).toBe(
      local("2026-03-12").toISOString(),
    );
  });

  test("a week is no data only when its last day is past the flow log's cutoff", () => {
    // The days before Wednesday 2026-03-11 were cleared.
    const coverage = {
      total: 30,
      noData: 9,
      none: [["2026-03-02", "2026-03-10"]] as [string, string][],
    };
    expect(dayState(coverage, "2026-03-02", "week")).toBe("noData");
    // The week of the cutoff has the days after it.
    expect(dayState(coverage, "2026-03-09", "week")).toBe("ready");
    expect(dayState(coverage, "2026-03-09")).toBe("noData");
    expect(dayState(coverage, "2026-03-01", "month")).toBe("ready");
  });

  test("a week cut by the window's end is judged by the window's last day", () => {
    // A window from 2026-01-01 to Wednesday 2026-04-08, every day of it cleared.
    const coverage = {
      total: 98,
      noData: 98,
      none: [["2026-01-01", "2026-04-08"]] as [string, string][],
    };
    const bounds = { first: "2026-01-01", last: "2026-04-08" };
    expect(dayState(coverage, "2026-04-06", "week", bounds)).toBe("noData");
    expect(dayState(coverage, "2026-04-01", "month", bounds)).toBe("noData");
    // Without the window, its Sunday is past the cleared days.
    expect(dayState(coverage, "2026-04-06", "week")).toBe("ready");
  });
});
