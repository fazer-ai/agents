import { describe, expect, test } from "bun:test";
import type { Window } from "@/client/pages/dashboard/filters";
import {
  dayState,
  flowLogCoverage,
  hasNoData,
} from "@/client/pages/dashboard/useMetrics";

// A flow-log block's days before the day the retention cutoff falls in have no lines left: they read
// as no data, never as zero. The cutoff's own day is partly swept and is read as the reader reads it.

const win = (firstDay: string, lastDay: string): Window => ({
  since: new Date(`${firstDay}T00:00:00`),
  until: new Date(`${lastDay}T23:59:59`),
  firstDay,
  lastDay,
  days: null,
});

const openedAt = new Date("2026-09-30T12:00:00");

describe("a flow-log block's coverage", () => {
  test("marks the days before the cutoff's day, and only those", () => {
    // 30 days of retention from noon on Sep 30: the cutoff is noon on Aug 31.
    const c = flowLogCoverage(win("2026-08-27", "2026-09-30"), openedAt, 30);
    expect(c).toEqual({
      total: 35,
      noData: 4,
      none: [["2026-08-27", "2026-08-30"]],
    });
    expect(dayState(c, "2026-08-30")).toBe("noData");
    expect(dayState(c, "2026-08-31")).toBe("ready");
    expect(hasNoData(c)).toBe(true);
  });

  test("has nothing to mark in a window inside the retention", () => {
    const c = flowLogCoverage(win("2026-09-01", "2026-09-30"), openedAt, 30);
    expect(c?.noData).toBe(0);
    expect(c?.none).toEqual([]);
    expect(hasNoData(c)).toBe(false);
  });

  test("is unknown until the retention is known, and then marks nothing", () => {
    const c = flowLogCoverage(win("2026-01-01", "2026-09-30"), openedAt, null);
    expect(c).toBeNull();
    expect(dayState(c, "2026-01-01")).toBe("ready");
    expect(hasNoData(c)).toBe(false);
  });
});
