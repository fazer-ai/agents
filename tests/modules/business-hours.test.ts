import { describe, expect, test } from "bun:test";
import {
  effectiveRangesAt,
  fitsWithinWindows,
  isOpenAt,
  isOutOfHoursNow,
  nextOpenAt,
  parseExceptions,
  parseWindows,
  type Schedule,
  type ScheduleException,
  type WindowSpec,
} from "@/modules/business-hours/hours";

const SP = "America/Sao_Paulo"; // UTC-3, no DST since 2019
const NY = "America/New_York"; // EST (UTC-5) / EDT (UTC-4)

// Mon–Fri 09:00–18:00 in the given tz.
const weekdayWindows = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: "09:00",
  end: "18:00",
}));
const everyDay = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  start: "09:00",
  end: "17:00",
}));

function sched(
  windows: WindowSpec[],
  timezone = SP,
  exceptions: ScheduleException[] = [],
): Schedule {
  return { windows, exceptions, timezone };
}

describe("parseWindows", () => {
  test("validates shape; drops invalid", () => {
    expect(
      parseWindows([{ day: 1, start: "09:00", end: "18:00" }]),
    ).toHaveLength(1);
    expect(parseWindows([{ day: 9, start: "09:00", end: "18:00" }])).toEqual(
      [],
    );
    expect(parseWindows([{ day: 1, start: "9:00", end: "18:00" }])).toEqual([]);
    expect(parseWindows("nope")).toEqual([]);
  });

  test("drops dead windows (end <= start) but keeps valid siblings", () => {
    // end before start (would-be overnight) and a zero-length window are no-ops:
    // isOpenAt can never match them, so parseWindows must not surface them.
    expect(
      parseWindows([
        { day: 2, start: "08:00", end: "02:00" },
        { day: 3, start: "09:00", end: "09:00" },
        { day: 4, start: "09:00", end: "18:00" },
      ]),
    ).toEqual([{ day: 4, start: "09:00", end: "18:00" }]);
  });

  test("a dead window is never open and never reported as next-open", () => {
    const dead = sched([{ day: 2, start: "08:00", end: "02:00" }]);
    // Tue 12:00 SP would be inside 08:00–02:00 only if it wrapped; it must not.
    expect(isOpenAt(dead, new Date("2026-06-02T15:00:00Z"))).toBe(false);
    expect(nextOpenAt(dead, new Date("2026-06-01T12:00:00Z"))).toBeNull();
  });
});

describe("parseExceptions", () => {
  test("validates shape; drops invalid", () => {
    expect(parseExceptions([{ date: "2026-09-07", ranges: [] }])).toHaveLength(
      1,
    );
    expect(parseExceptions([{ date: "07/09/2026", ranges: [] }])).toEqual([]);
    expect(parseExceptions([{ date: "2026-09-07" }])).toEqual([]);
    expect(parseExceptions("nope")).toEqual([]);
    expect(parseExceptions(undefined)).toEqual([]);
  });

  test("drops impossible calendar dates on both ends of a span", () => {
    // The regex accepts these and Date.UTC would silently roll them over into a real (wrong) day.
    expect(parseExceptions([{ date: "2026-02-30", ranges: [] }])).toEqual([]);
    expect(parseExceptions([{ date: "2026-13-01", ranges: [] }])).toEqual([]);
    expect(
      parseExceptions([
        { date: "2026-12-23", dateEnd: "2027-02-30", ranges: [] },
      ]),
    ).toEqual([]);
  });

  test("drops dead ranges inside an entry, keeping the entry itself", () => {
    expect(
      parseExceptions([
        {
          date: "2026-12-24",
          ranges: [
            { start: "13:00", end: "09:00" },
            { start: "08:00", end: "12:00" },
          ],
        },
      ]),
    ).toEqual([
      { date: "2026-12-24", ranges: [{ start: "08:00", end: "12:00" }] },
    ]);
  });

  test("one malformed entry does not take the valid ones with it", () => {
    // Validated per entry, not as one array. The array-wide failure would return [] and silently
    // restore the weekly hours on every holiday — the schedule would read as OPEN on all of them.
    // Reachable because the agent-import path writes the column as raw JSON.
    expect(
      parseExceptions([
        { date: "2026-09-07", label: "Independência", ranges: [] },
        { nonsense: true },
        { date: "2026-12-25", ranges: [] },
      ]),
    ).toEqual([
      { date: "2026-09-07", label: "Independência", ranges: [] },
      { date: "2026-12-25", ranges: [] },
    ]);
  });

  test("an empty ranges array survives — closed all day is the common case", () => {
    expect(
      parseExceptions([
        { date: "2026-09-07", label: "Independência", ranges: [] },
      ]),
    ).toEqual([{ date: "2026-09-07", label: "Independência", ranges: [] }]);
  });
});

describe("isOpenAt (São Paulo, UTC-3)", () => {
  test("Monday 12:00 local is open", () => {
    // 2026-06-01T15:00Z = Mon 12:00 in SP
    expect(
      isOpenAt(sched(weekdayWindows), new Date("2026-06-01T15:00:00Z")),
    ).toBe(true);
  });
  test("Sunday is closed", () => {
    expect(
      isOpenAt(sched(weekdayWindows), new Date("2026-05-31T15:00:00Z")),
    ).toBe(false);
  });
  test("before opening is closed", () => {
    // 2026-06-01T11:00Z = Mon 08:00 SP (before 09:00)
    expect(
      isOpenAt(sched(weekdayWindows), new Date("2026-06-01T11:00:00Z")),
    ).toBe(false);
  });
});

// ── date exceptions (issue #129) ──
//
// 2026-09-07 (Brazilian Independence Day) falls on a Monday, which is the scenario the issue reports:
// every weekday check says "open" and the agent works the holiday as an ordinary Monday.
const SEP7_0914 = new Date("2026-09-07T12:14:00Z"); // Mon 09:14 SP
const SEP8_0914 = new Date("2026-09-08T12:14:00Z"); // Tue 09:14 SP
const holiday: ScheduleException = {
  date: "2026-09-07",
  label: "Independência",
  ranges: [],
};

describe("exceptions replace the weekly grid for the dates they match", () => {
  test("a closed-all-day exception shuts a day the grid calls open", () => {
    expect(isOpenAt(sched(weekdayWindows), SEP7_0914)).toBe(true);
    expect(isOpenAt(sched(weekdayWindows, SP, [holiday]), SEP7_0914)).toBe(
      false,
    );
  });

  test("neighbouring dates are untouched", () => {
    const s = sched(weekdayWindows, SP, [holiday]);
    expect(isOpenAt(s, SEP8_0914)).toBe(true);
    expect(isOpenAt(s, new Date("2026-09-04T12:14:00Z"))).toBe(true); // Fri
  });

  test("a half-day exception replaces the day's hours rather than clearing them", () => {
    const s = sched(weekdayWindows, SP, [
      { date: "2026-12-24", ranges: [{ start: "08:00", end: "12:00" }] },
    ]);
    // 2026-12-24 is a Thursday: the grid says 09:00–18:00.
    expect(isOpenAt(s, new Date("2026-12-24T11:00:00Z"))).toBe(true); // 08:00 SP
    expect(isOpenAt(s, new Date("2026-12-24T17:00:00Z"))).toBe(false); // 14:00 SP
    expect(effectiveRangesAt(s, new Date("2026-12-24T17:00:00Z"))).toEqual([
      { start: "08:00", end: "12:00" },
    ]);
  });

  test("an exception can OPEN a day the grid leaves closed", () => {
    const s = sched(weekdayWindows, SP, [
      { date: "2026-06-06", ranges: [{ start: "09:00", end: "13:00" }] },
    ]);
    // 2026-06-06 is a Saturday, which the Mon–Fri grid never opens.
    expect(isOpenAt(s, new Date("2026-06-06T13:00:00Z"))).toBe(true); // 10:00 SP
    expect(isOpenAt(s, new Date("2026-06-06T17:00:00Z"))).toBe(false); // 14:00 SP
  });

  test("a span closes every date from date to dateEnd, inclusive", () => {
    const s = sched(everyDay, SP, [
      {
        date: "2026-12-23",
        dateEnd: "2027-01-02",
        label: "Recesso",
        ranges: [],
      },
    ]);
    const noon = (ymd: string) => new Date(`${ymd}T15:00:00Z`); // 12:00 SP
    expect(isOpenAt(s, noon("2026-12-22"))).toBe(true);
    expect(isOpenAt(s, noon("2026-12-23"))).toBe(false); // first day
    expect(isOpenAt(s, noon("2026-12-31"))).toBe(false);
    expect(isOpenAt(s, noon("2027-01-02"))).toBe(false); // last day
    expect(isOpenAt(s, noon("2027-01-03"))).toBe(true);
  });

  test("recurring matches the same month-day in any year", () => {
    const s = sched(everyDay, SP, [
      { date: "2026-12-25", recurring: true, ranges: [] },
    ]);
    expect(isOpenAt(s, new Date("2029-12-25T15:00:00Z"))).toBe(false);
    expect(isOpenAt(s, new Date("2029-12-26T15:00:00Z"))).toBe(true);
  });

  test("a recurring span whose end precedes its start wraps the year end", () => {
    const s = sched(everyDay, SP, [
      {
        date: "2026-12-23",
        dateEnd: "2027-01-02",
        recurring: true,
        ranges: [],
      },
    ]);
    const noon = (ymd: string) => new Date(`${ymd}T15:00:00Z`);
    expect(isOpenAt(s, noon("2030-12-24"))).toBe(false);
    expect(isOpenAt(s, noon("2031-01-01"))).toBe(false);
    expect(isOpenAt(s, noon("2031-01-03"))).toBe(true);
    expect(isOpenAt(s, noon("2030-12-22"))).toBe(true);
  });

  test("a DATED span that runs backwards covers nothing", () => {
    // Only month-day comparison can wrap the year end. On full dates the span is empty, and reading it
    // as a wrap would close Dec 25–31 plus Jan 1–Dec 20 — almost the whole year. The API rejects such
    // a span on write; the resolver has to agree, because agent import writes the column unvalidated.
    const s = sched(everyDay, SP, [
      { date: "2026-12-25", dateEnd: "2026-12-20", ranges: [] },
    ]);
    const noon = (ymd: string) => new Date(`${ymd}T15:00:00Z`);
    expect(isOpenAt(s, noon("2026-12-26"))).toBe(true);
    expect(isOpenAt(s, noon("2026-12-25"))).toBe(true);
    expect(isOpenAt(s, noon("2026-06-15"))).toBe(true);
  });

  test("a dated exception outranks a recurring one for that year", () => {
    // "closed every Dec 25" as a standing rule, "this year we open until noon" as an override.
    const s = sched(everyDay, SP, [
      { date: "2026-12-25", recurring: true, ranges: [] },
      { date: "2026-12-25", ranges: [{ start: "09:00", end: "12:00" }] },
    ]);
    expect(isOpenAt(s, new Date("2026-12-25T13:00:00Z"))).toBe(true); // 10:00 SP
    expect(isOpenAt(s, new Date("2026-12-25T16:00:00Z"))).toBe(false); // 13:00 SP
    // The standing rule still governs every other year.
    expect(isOpenAt(s, new Date("2027-12-25T13:00:00Z"))).toBe(false);
  });

  test("among exceptions of the same kind, array order decides", () => {
    const s = sched(everyDay, SP, [
      { date: "2026-09-07", ranges: [{ start: "10:00", end: "11:00" }] },
      { date: "2026-09-07", ranges: [] },
    ]);
    expect(isOpenAt(s, new Date("2026-09-07T13:30:00Z"))).toBe(true); // 10:30 SP
  });

  test("a recurring Feb 29 matches only on leap years", () => {
    const s = sched(everyDay, SP, [
      { date: "2024-02-29", recurring: true, ranges: [] },
    ]);
    expect(isOpenAt(s, new Date("2028-02-29T15:00:00Z"))).toBe(false);
    expect(isOpenAt(s, new Date("2027-02-28T15:00:00Z"))).toBe(true);
  });

  test("an exception matches on the schedule's LOCAL date, not the UTC one", () => {
    const s = sched(everyDay, NY, [{ date: "2026-11-01", ranges: [] }]);
    // 2026-11-01T03:00Z is still Oct 31, 23:00 in New York (EDT, UTC-4).
    expect(effectiveRangesAt(s, new Date("2026-11-01T03:00:00Z"))).toHaveLength(
      1,
    );
    // 2026-11-01T14:00Z is Nov 1, 09:00 local (EST after the DST end at 06:00Z).
    expect(effectiveRangesAt(s, new Date("2026-11-01T14:00:00Z"))).toEqual([]);
  });

  test("an exception cannot close an always-on agent (no weekly windows)", () => {
    // No windows means "no availability schedule configured", which is always-on. There is no
    // schedule to except from, so the reactive gate must never silence such an agent.
    const s = sched([], SP, [holiday]);
    expect(isOutOfHoursNow(s, SEP7_0914)).toBe(false);
  });

  test("isOutOfHoursNow reports the holiday as closed for the operator badge", () => {
    expect(isOutOfHoursNow(sched(weekdayWindows), SEP7_0914)).toBe(false);
    expect(
      isOutOfHoursNow(sched(weekdayWindows, SP, [holiday]), SEP7_0914),
    ).toBe(true);
  });
});

describe("fitsWithinWindows (bookable slots)", () => {
  const slot = (fromZ: string, minutes: number) => {
    const s = new Date(fromZ);
    return [s, new Date(s.getTime() + minutes * 60_000)] as const;
  };

  test("a slot the grid allows does not fit on a holiday", () => {
    const [s, e] = slot("2026-09-07T13:00:00Z", 60); // Mon 10:00–11:00 SP
    expect(fitsWithinWindows(sched(weekdayWindows), s, e)).toBe(true);
    expect(fitsWithinWindows(sched(weekdayWindows, SP, [holiday]), s, e)).toBe(
      false,
    );
  });

  test("a half-day admits slots inside its range and refuses the ones after it", () => {
    const s = sched(weekdayWindows, SP, [
      { date: "2026-12-24", ranges: [{ start: "08:00", end: "12:00" }] },
    ]);
    const [a1, a2] = slot("2026-12-24T13:00:00Z", 60); // 10:00–11:00 SP
    const [b1, b2] = slot("2026-12-24T17:00:00Z", 60); // 14:00–15:00 SP
    expect(fitsWithinWindows(s, a1, a2)).toBe(true);
    expect(fitsWithinWindows(s, b1, b2)).toBe(false);
  });
});

describe("nextOpenAt", () => {
  test("returns the instant itself when already open", () => {
    const at = new Date("2026-06-01T15:00:00Z");
    expect(nextOpenAt(sched(weekdayWindows), at)?.toISOString()).toBe(
      at.toISOString(),
    );
  });

  test("from a Sunday → Monday 09:00 SP (12:00Z)", () => {
    const at = new Date("2026-05-31T10:00:00Z"); // Sun 07:00 SP
    expect(nextOpenAt(sched(weekdayWindows), at)?.toISOString()).toBe(
      "2026-06-01T12:00:00.000Z",
    );
  });

  test("no windows → null", () => {
    expect(nextOpenAt(sched([]), new Date())).toBeNull();
  });

  test("DST: 09:00 New York maps to a different UTC hour in winter vs summer", () => {
    // Winter (EST, UTC-5): closed at 07:00 EST → next open 09:00 EST = 14:00Z
    const winter = nextOpenAt(
      sched(everyDay, NY),
      new Date("2026-01-10T12:00:00Z"),
    );
    expect(winter?.toISOString()).toBe("2026-01-10T14:00:00.000Z");
    // Summer (EDT, UTC-4): closed at 08:00 EDT → next open 09:00 EDT = 13:00Z
    const summer = nextOpenAt(
      sched(everyDay, NY),
      new Date("2026-07-10T12:00:00Z"),
    );
    expect(summer?.toISOString()).toBe("2026-07-10T13:00:00.000Z");
  });

  test("the returned instant is itself open (round-trip)", () => {
    const at = new Date("2026-05-31T10:00:00Z");
    const s = sched(weekdayWindows);
    const next = nextOpenAt(s, at);
    expect(next).not.toBeNull();
    expect(isOpenAt(s, next as Date)).toBe(true);
  });

  test("skips a holiday and lands on the next working day", () => {
    const s = sched(weekdayWindows, SP, [holiday]);
    // Sun 2026-09-06 07:00 SP → Monday is the holiday → Tuesday 09:00 SP = 12:00Z.
    const next = nextOpenAt(s, new Date("2026-09-06T10:00:00Z"));
    expect(next?.toISOString()).toBe("2026-09-08T12:00:00.000Z");
  });

  test("lands on the half-day's own opening, not the grid's", () => {
    const s = sched(weekdayWindows, SP, [
      { date: "2026-12-24", ranges: [{ start: "07:00", end: "12:00" }] },
    ]);
    // Wed 2026-12-23 20:00 SP (after close) → Thursday opens at 07:00 SP = 10:00Z, not 09:00.
    const next = nextOpenAt(s, new Date("2026-12-23T23:00:00Z"));
    expect(next?.toISOString()).toBe("2026-12-24T10:00:00.000Z");
  });

  test("clears a shutdown longer than the two weeks the old horizon scanned", () => {
    // 19 days closed. A 14-day scan returned null here, and the follow-up handler reads null as
    // "end the sequence" — the nudge would be dropped instead of deferred.
    const s = sched(everyDay, SP, [
      {
        date: "2026-12-23",
        dateEnd: "2027-01-10",
        label: "Recesso",
        ranges: [],
      },
    ]);
    const next = nextOpenAt(s, new Date("2026-12-24T15:00:00Z"));
    expect(next?.toISOString()).toBe("2027-01-11T12:00:00.000Z");
  });

  test("null when nothing opens within the horizon", () => {
    // A recurring span covering every month-day: the schedule never opens again, and the scan has to
    // terminate rather than run forever.
    const s = sched(everyDay, SP, [
      {
        date: "2026-01-01",
        dateEnd: "2026-12-31",
        recurring: true,
        ranges: [],
      },
    ]);
    expect(nextOpenAt(s, new Date("2026-06-01T15:00:00Z"))).toBeNull();
  });
});
