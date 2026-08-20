import { describe, expect, test } from "bun:test";
import type {
  Schedule,
  ScheduleException,
  WindowSpec,
} from "@/modules/business-hours/hours";
import {
  computeAggregatedSlots,
  computeAvailableSlots,
} from "@/modules/integrations/toolpacks/calendar-slots";

// America/Sao_Paulo is a fixed UTC-3 (no DST since 2019), so -03:00 ISO offsets are stable here.
const TZ = "America/Sao_Paulo";
const WD: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
function spWeekday(iso: string): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(new Date(iso));
  return WD[s] ?? 0;
}
// The local HH:MM of an ISO instant in São Paulo — for readable assertions on slot starts.
function localHM(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
// 2026-06-22 wall time in São Paulo.
const iso = (hhmm: string) => `2026-06-22T${hhmm}:00-03:00`;
const DAY = spWeekday(iso("12:00"));
const farPast = new Date("2026-06-01T00:00:00-03:00");

const base = {
  now: farPast,
  busy: [] as { start: string; end: string }[],
  slotMinutes: 30,
  granularityMinutes: 30,
  minLeadMinutes: 0,
};
const officeHours: WindowSpec[] = [{ day: DAY, start: "08:00", end: "18:00" }];
const sch = (
  windows: WindowSpec[],
  exceptions: ScheduleException[] = [],
): Schedule => ({ windows, exceptions, timezone: TZ });

describe("computeAvailableSlots", () => {
  test("granularity < duration produces overlapping starts (09:00 and 09:15)", () => {
    const slots = computeAvailableSlots({
      ...base,
      timeMin: iso("09:00"),
      timeMax: iso("12:00"),
      schedule: sch(officeHours),
      granularityMinutes: 15,
    });
    const starts = slots.map((s) => localHM(s.start));
    expect(starts).toContain("09:00");
    expect(starts).toContain("09:15");
    // last slot that still ends by 12:00 is 11:30 (11:30+30=12:00); 11:45 would overrun.
    expect(starts).toContain("11:30");
    expect(starts).not.toContain("11:45");
    // label carries the local HH:MM.
    expect(slots[0]?.label).toContain("09:00");
  });

  test("business hours bound the slots (nothing before 08:00)", () => {
    const slots = computeAvailableSlots({
      ...base,
      timeMin: iso("07:00"),
      timeMax: iso("09:00"),
      schedule: sch(officeHours),
    });
    const starts = slots.map((s) => localHM(s.start));
    expect(starts).toEqual(["08:00", "08:30"]);
  });

  test("a lunch break (two windows) is respected", () => {
    const slots = computeAvailableSlots({
      ...base,
      timeMin: iso("11:00"),
      timeMax: iso("15:00"),
      slotMinutes: 60,
      granularityMinutes: 60,
      schedule: sch([
        { day: DAY, start: "08:00", end: "12:00" },
        { day: DAY, start: "14:00", end: "18:00" },
      ]),
    });
    const starts = slots.map((s) => localHM(s.start));
    expect(starts).toContain("11:00");
    expect(starts).toContain("14:00");
    expect(starts).not.toContain("12:00");
    expect(starts).not.toContain("13:00");
  });

  test("a day with no window yields nothing", () => {
    const otherDay: WindowSpec[] = [
      { day: (DAY + 1) % 7, start: "08:00", end: "18:00" },
    ];
    const slots = computeAvailableSlots({
      ...base,
      timeMin: iso("09:00"),
      timeMax: iso("18:00"),
      schedule: sch(otherDay),
    });
    expect(slots).toEqual([]);
  });

  test("busy intervals remove overlapping slots, edge-touching stays", () => {
    const slots = computeAvailableSlots({
      ...base,
      timeMin: iso("09:00"),
      timeMax: iso("11:00"),
      schedule: sch(officeHours),
      busy: [{ start: iso("10:00"), end: iso("10:30") }],
    });
    const starts = slots.map((s) => localHM(s.start));
    // 10:00-10:30 overlaps; 09:30-10:00 and 10:30-11:00 only touch the edges → kept.
    expect(starts).toEqual(["09:00", "09:30", "10:30"]);
  });

  test("past slots are dropped (minLead from now)", () => {
    const slots = computeAvailableSlots({
      ...base,
      now: new Date(iso("10:00")),
      timeMin: iso("09:00"),
      timeMax: iso("12:00"),
      schedule: sch(officeHours),
    });
    const starts = slots.map((s) => localHM(s.start));
    expect(starts).toEqual(["10:00", "10:30", "11:00", "11:30"]);
  });

  test("an unaligned `now` still yields grid-aligned slots (regression: the 09:01/09:16 bug)", () => {
    // Real trace: now 00:16:31.660 with a 15-min grain produced slots at 09:01, 09:16, … with
    // :31.660Z seconds, because stepping started at `now`+lead instead of snapping to the grid. Here
    // now is 09:07:31.660 local: the first bookable slot must snap UP to 09:15, and every slot must
    // sit on the :00/:15/:30/:45 grid with no stray seconds.
    const slots = computeAvailableSlots({
      ...base,
      now: new Date("2026-06-22T09:07:31.660-03:00"),
      timeMin: iso("00:00"),
      timeMax: iso("12:00"),
      schedule: sch(officeHours),
      granularityMinutes: 15,
    });
    const starts = slots.map((s) => localHM(s.start));
    expect(starts[0]).toBe("09:15");
    for (const s of slots) {
      expect(["00", "15", "30", "45"]).toContain(localHM(s.start).slice(3));
      expect(new Date(s.start).getUTCSeconds()).toBe(0);
      expect(new Date(s.start).getUTCMilliseconds()).toBe(0);
    }
  });

  test("no business hours ⇒ no time-of-day filter (only busy/past apply)", () => {
    const slots = computeAvailableSlots({
      ...base,
      timeMin: iso("09:00"),
      timeMax: iso("11:00"),
      schedule: sch([]),
    });
    const starts = slots.map((s) => localHM(s.start));
    expect(starts).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });

  test("returns EVERY bookable slot in range, chronological, with no sampling", () => {
    const slots = computeAvailableSlots({
      ...base,
      timeMin: iso("09:00"),
      timeMax: iso("18:00"),
      schedule: sch(officeHours),
    });
    const starts = slots.map((s) => localHM(s.start));
    // 09:00 → 17:30 in 30-min steps: all 18 slots present, in order (last is 17:30+30=18:00).
    expect(starts).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
      "12:00",
      "12:30",
      "13:00",
      "13:30",
      "14:00",
      "14:30",
      "15:00",
      "15:30",
      "16:00",
      "16:30",
      "17:00",
      "17:30",
    ]);
  });

  test("an inverted or empty range yields nothing", () => {
    expect(
      computeAvailableSlots({
        ...base,
        timeMin: iso("12:00"),
        timeMax: iso("09:00"),
        schedule: sch(officeHours),
      }),
    ).toEqual([]);
  });
});

// Issue #100: several allowed calendars are INDEPENDENT sources of availability (one per
// professional/resource), not one pooled calendar. The decision this table pins is which slots
// survive and in what order, because that is what the customer is offered when they ask "who can
// see me first?".
describe("computeAggregatedSlots", () => {
  const ANA = { calendarId: "ana@x", calendarLabel: "Dra. Ana" };
  const PAULO = { calendarId: "paulo@x", calendarLabel: "Dr. Paulo" };
  const aggFull = (over: Record<string, unknown>) =>
    computeAggregatedSlots({
      ...base,
      timeMin: iso("09:00"),
      timeMax: iso("11:00"),
      schedule: sch(officeHours),
      sources: [],
      maxSlots: 1000,
      ...over,
    });
  const agg = (over: Record<string, unknown>) => aggFull(over).slots;

  test("a slot busy on one calendar survives on the other, tagged with its own", () => {
    const slots = agg({
      sources: [
        { ...ANA, busy: [{ start: iso("09:00"), end: iso("10:00") }] },
        { ...PAULO, busy: [] },
      ],
    });
    const at9 = slots.filter((s) => localHM(s.start) === "09:00");
    expect(at9.map((s) => s.calendarId)).toEqual(["paulo@x"]);
    expect(at9[0]?.calendarLabel).toBe("Dr. Paulo");
  });

  test("busy intervals are NOT pooled across calendars", () => {
    // Pooling would intersect the two and leave 09:00 free for nobody.
    const slots = agg({
      sources: [
        { ...ANA, busy: [{ start: iso("09:00"), end: iso("09:30") }] },
        { ...PAULO, busy: [{ start: iso("09:30"), end: iso("10:00") }] },
      ],
    });
    const starts = slots.map((s) => `${localHM(s.start)}/${s.calendarId}`);
    expect(starts).toContain("09:00/paulo@x");
    expect(starts).toContain("09:30/ana@x");
  });

  test("the merged list is chronological, ties broken by the configured order", () => {
    const slots = agg({
      sources: [
        { ...ANA, busy: [] },
        { ...PAULO, busy: [] },
      ],
    });
    const times = slots.map((s) => Date.parse(s.start));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const first = slots.filter((s) => localHM(s.start) === "09:00");
    expect(first.map((s) => s.calendarId)).toEqual(["ana@x", "paulo@x"]);
  });

  test("the WHOLE range survives for every calendar, never just its head", () => {
    // A per-calendar bound here (an earlier revision kept the first eight starts) turns "all bookable
    // slots" into "the first couple of hours", and an afternoon request comes back unavailable while
    // the afternoon is free.
    const slots = agg({
      timeMin: iso("09:00"),
      timeMax: iso("17:00"),
      sources: [
        { ...ANA, busy: [] },
        { ...PAULO, busy: [] },
      ],
    });
    const ana = slots.filter((s) => s.calendarId === "ana@x");
    expect(localHM(ana[0]?.start as string)).toBe("09:00");
    expect(localHM(ana[ana.length - 1]?.start as string)).toBe("16:30");
    expect(ana).toHaveLength(16);
  });

  test("a calendar with nothing free contributes nothing and breaks nothing", () => {
    const slots = agg({
      sources: [
        { ...ANA, busy: [{ start: iso("00:00"), end: iso("23:59") }] },
        { ...PAULO, busy: [] },
      ],
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.calendarId === "paulo@x")).toBe(true);
  });

  test("the ceiling drops WHOLE start times and says where it stopped", () => {
    // Trimming which calendars a time offers would tell the customer a professional is busy when they
    // are free, so the unit dropped is the time, never part of one.
    const r = aggFull({
      sources: [
        { ...ANA, busy: [] },
        { ...PAULO, busy: [] },
      ],
      maxSlots: 3,
    });
    expect(r.slots.map((s) => `${localHM(s.start)}/${s.calendarId}`)).toEqual([
      "09:00/ana@x",
      "09:00/paulo@x",
    ]);
    expect(localHM(r.coveredUntil as string)).toBe("09:30");
  });

  test("a range that fits reports no continuation point", () => {
    const r = aggFull({
      sources: [
        { ...ANA, busy: [] },
        { ...PAULO, busy: [] },
      ],
    });
    expect(r.coveredUntil).toBeUndefined();
  });

  test("the first start time is kept even when it alone exceeds the ceiling", () => {
    // Returning nothing because one instant had many free calendars is a worse answer than a
    // slightly oversized one.
    const r = aggFull({
      sources: [
        { ...ANA, busy: [] },
        { ...PAULO, busy: [] },
      ],
      maxSlots: 1,
    });
    expect(r.slots).toHaveLength(2);
    expect(localHM(r.coveredUntil as string)).toBe("09:30");
  });
});
