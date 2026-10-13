import { describe, expect, test } from "bun:test";
import {
  type DayStore,
  mergeFollowUps,
  mergeHealth,
} from "@/modules/analytics/rollup/merge";
import type {
  FollowupsDay,
  ProblemsDay,
  Section,
} from "@/modules/analytics/rollup/sections";

// A CONVERSATION SEEN BEFORE ON A DAY NOBODY CAN READ ANY MORE COUNTS WHERE IT IS STILL SEEN. A kept
// day records, for each occurrence, the day the conversation was last seen before it. When that day is
// in the window but the store holds nothing for it (a flow-log day the retention sweep emptied before
// it was kept), the occurrence is the only one left: it counts, instead of being left to a day that
// adds nothing.

function storeOf(rows: Partial<Record<Section, Record<string, unknown>>>) {
  return {
    get: (section: Section, day: string) => rows[section]?.[day],
    cells: async () => new Map(),
  } satisfies DayStore;
}

const days = ["2026-09-01", "2026-09-02", "2026-09-03"];

describe("a predecessor day the store does not hold", () => {
  test("leaves the follow-up's conversation counted on the day it is still seen", () => {
    const later: FollowupsDay = { s: 1, p: { "2026-09-01": [1, 0, 0] } };
    const f = mergeFollowUps(
      storeOf({ "log.followups": { "2026-09-03": later } }),
      { days },
    );
    expect(f.stepsSent).toBe(1);
    expect(f.conversations).toBe(1);
  });

  test("still counts a conversation once when the day it was seen before is held", () => {
    const first: FollowupsDay = { s: 1, p: { "": [1, 0, 0] } };
    const later: FollowupsDay = { s: 1, p: { "2026-09-01": [1, 0, 0] } };
    const f = mergeFollowUps(
      storeOf({
        "log.followups": { "2026-09-01": first, "2026-09-03": later },
      }),
      { days },
    );
    expect(f.stepsSent).toBe(2);
    expect(f.conversations).toBe(1);
  });

  test("leaves a problem's conversation counted on the day it is still seen", async () => {
    const later: ProblemsDay = {
      "warn\u0000x": { n: 2, p: { "2026-09-02": 1 } },
    };
    const h = await mergeHealth(
      storeOf({ "log.problems": { "2026-09-03": later } }),
      { days },
    );
    expect(h.problems?.[0]?.conversations).toBe(1);
  });
});
