import { describe, expect, test } from "bun:test";
import { formatWindowsSummary } from "@/modules/business-hours/announce";
import {
  isOutOfHoursNow,
  MAX_SCHEDULE_EXCEPTIONS,
  MAX_SCHEDULE_WINDOWS,
  nextOpenAt,
  parseExceptions,
  parseWindows,
  type ScheduleException,
  scheduleCanClose,
  type WindowSpec,
} from "@/modules/business-hours/hours";

// Issue #346. A schedule is read back from a JSON column, and the reader is the last place that
// decides what a stored row MEANS — rows written before this change included, which is why the fix
// lives here and not only at the import that produced them. For this dimension the two failure
// directions are not symmetric: an empty window list is not "closed", it is ALWAYS OPEN
// (`scheduleCanClose`). Refusing the whole array over one bad element therefore fails in the single
// direction this module must never fail in, which is exactly what `parseExceptions` was already
// written entry-by-entry to avoid.

const TZ = "America/Sao_Paulo";
const WEEK: WindowSpec[] = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: "09:00",
  end: "18:00",
}));
// Thu 2026-08-27, 03:00 in São Paulo: outside every window above.
const NIGHT = new Date("2026-08-27T06:00:00Z");

const sched = (windows: unknown, exceptions: unknown = []) => ({
  windows: parseWindows(windows),
  exceptions: parseExceptions(exceptions),
  timezone: TZ,
});

describe("one malformed window does not take the whole schedule with it", () => {
  // Four spellings of "an element this version cannot read". The first is the one a hand-edited
  // bundle produces; the others are what a field rename, an older export and a truncated write look
  // like. All four have to leave the FIVE valid windows standing.
  const broken: [string, unknown][] = [
    ["misspelled field", { day: 6, start: "10:00", ends: "14:00" }],
    ["missing field", { day: 6, start: "10:00" }],
    ["weekday out of range", { day: 9, start: "10:00", end: "14:00" }],
    ["time not HH:MM", { day: 6, start: "10h", end: "14:00" }],
  ];

  for (const [label, bad] of broken) {
    test(`keeps the valid windows next to a ${label}`, () => {
      expect(parseWindows([...WEEK, bad])).toEqual(WEEK);
    });
  }

  test("the agent that was closed at 03:00 is still closed at 03:00", () => {
    const clean = sched(WEEK);
    const dirty = sched([...WEEK, { day: 6, start: "10:00", ends: "14:00" }]);
    // The whole point: the two schedules must answer the gate identically. Before the fix `dirty`
    // parsed to zero windows, and zero windows is the widest answer this module has.
    expect(scheduleCanClose(dirty)).toBe(scheduleCanClose(clean));
    expect(isOutOfHoursNow(dirty, NIGHT)).toBe(true);
    expect(nextOpenAt(dirty, NIGHT)).toEqual(nextOpenAt(clean, NIGHT));
  });

  test("all-malformed still reads as no schedule, which is the honest answer", () => {
    // Not a regression: with nothing readable there IS no grid, and always-on is what a schedule
    // with no windows has always meant. The fix narrows WHEN that answer is reached, not what it is.
    expect(parseWindows([{ day: 9, start: "x", end: "y" }])).toEqual([]);
    expect(scheduleCanClose(sched("not an array"))).toBe(false);
  });

  test("a dead window is still dropped, and still takes no sibling with it", () => {
    expect(
      parseWindows([...WEEK, { day: 6, start: "14:00", end: "09:00" }]),
    ).toEqual(WEEK);
  });
});

describe("a stored schedule cannot be larger than a written one", () => {
  // The write path caps windows and exceptions, and the import does not go through it. The cap is
  // asked again HERE because the reader is what every consumer shares: the rendered weekly summary
  // goes into the agent's system prompt once per variable name, and it grows linearly with the
  // count (measured: 2,639 chars at 200 windows, 65,039 at 5,000).
  const many = (n: number): WindowSpec[] =>
    Array.from({ length: n }, (_, i) => {
      const hh = String(i % 23).padStart(2, "0");
      return { day: i % 7, start: `${hh}:00`, end: `${hh}:59` };
    });
  const manyExceptions = (n: number): ScheduleException[] =>
    Array.from({ length: n }, (_, i) => ({
      date: `20${26 + Math.floor(i / 300)}-01-01`,
      ranges: [],
    }));

  test("windows past the cap are not surfaced", () => {
    expect(parseWindows(many(MAX_SCHEDULE_WINDOWS + 50))).toHaveLength(
      MAX_SCHEDULE_WINDOWS,
    );
    expect(parseWindows(many(MAX_SCHEDULE_WINDOWS))).toHaveLength(
      MAX_SCHEDULE_WINDOWS,
    );
  });

  // Review round 2, and it is the inverse of the window rule above. Truncating EXCEPTIONS widens
  // availability instead of narrowing it, so the reader must not do it: a dated closure past the cap
  // would stop being honoured and the weekly grid would apply on that day, silently and on a row
  // already written. Measured before the fix: Christmas at position 401 of 401 flipped
  // `isOutOfHoursNow` at noon on the 25th from true to false. The bound is the writers' job.
  test("exceptions are NOT truncated by the reader, however many there are", () => {
    expect(
      parseExceptions(manyExceptions(MAX_SCHEDULE_EXCEPTIONS + 50)),
    ).toHaveLength(MAX_SCHEDULE_EXCEPTIONS + 50);
  });

  test("a closure past the cap still closes the day", () => {
    const filler = Array.from({ length: MAX_SCHEDULE_EXCEPTIONS }, () => ({
      date: "2026-01-01",
      ranges: [{ start: "09:00", end: "10:00" }],
    }));
    // 2026-12-25 is a Friday, which the weekly grid above opens 09:00-18:00.
    const christmas = { date: "2026-12-25", label: "Natal", ranges: [] };
    const noon = new Date("2026-12-25T15:00:00Z");
    expect(isOutOfHoursNow(sched(WEEK, [...filler, christmas]), noon)).toBe(
      true,
    );
  });

  test("the cap bounds what the prompt renders", () => {
    const rendered = formatWindowsSummary(
      parseWindows(many(5000)),
      "-",
      "pt-BR",
    );
    // 5,000 windows render 65,039 characters when nothing bounds them.
    expect(rendered.length).toBeLessThan(4000);
  });

  test("the cap keeps the windows the operator wrote FIRST", () => {
    // Truncation direction matters: a schedule read from its tail is a different schedule.
    const kept = parseWindows(many(MAX_SCHEDULE_WINDOWS + 10));
    expect(kept[0]).toEqual(many(1)[0] as WindowSpec);
  });
});
