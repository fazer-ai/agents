// CALENDAR PERIODS, ON LOCAL DAYS. "This month" or "last week" as `YYYY-MM-DD` days of the zone the
// caller reads in: the console turns a day into an instant with the browser's clock, the server with
// `dayStart(day, tz)` (./days.ts), so a screen and its request share one arithmetic. A week starts on
// Monday (ISO 8601), as in ./grain.ts. A closed preset is compared with the whole unit before (March
// against all of February), a running one with the same stretch of the unit before, up to the same day
// and time of day. docs/dashboard.md, "Calendar periods".

export const CALENDAR_PRESETS = [
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "this-month",
  "last-month",
  "this-quarter",
  "last-quarter",
  "this-year",
] as const;
export type CalendarPreset = (typeof CALENDAR_PRESETS)[number];

export const CALENDAR_UNITS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;
export type CalendarUnit = (typeof CALENDAR_UNITS)[number];

const PRESETS: Record<CalendarPreset, { unit: CalendarUnit; back: 0 | 1 }> = {
  today: { unit: "day", back: 0 },
  yesterday: { unit: "day", back: 1 },
  "this-week": { unit: "week", back: 0 },
  "last-week": { unit: "week", back: 1 },
  "this-month": { unit: "month", back: 0 },
  "last-month": { unit: "month", back: 1 },
  "this-quarter": { unit: "quarter", back: 0 },
  "last-quarter": { unit: "quarter", back: 1 },
  "this-year": { unit: "year", back: 0 },
};

export function isCalendarPreset(
  s: string | null | undefined,
): s is CalendarPreset {
  return (CALENDAR_PRESETS as readonly string[]).includes(s ?? "");
}

export function presetUnit(p: CalendarPreset): CalendarUnit {
  return PRESETS[p].unit;
}

// Still running on the day it is read: it ends at the moment of the read, not at a midnight.
export function presetRunning(p: CalendarPreset): boolean {
  return PRESETS[p].back === 0;
}

const MONTHS: Partial<Record<CalendarUnit, number>> = {
  month: 1,
  quarter: 3,
  year: 12,
};

function ymd(day: string): [number, number, number] {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m, d];
}

function key(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().split("T")[0] as string;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// The first day of the unit that holds `day`: itself, its Monday, the 1st of its month, of its
// quarter (January, April, July, October) or of its year.
export function unitStart(day: string, unit: CalendarUnit): string {
  const [y, m, d] = ymd(day);
  switch (unit) {
    case "day":
      return day;
    case "week": {
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      return key(y, m, d - ((weekday + 6) % 7));
    }
    case "month":
      return key(y, m, 1);
    case "quarter":
      return key(y, m - ((m - 1) % 3), 1);
    case "year":
      return key(y, 1, 1);
  }
}

// The same day `n` units away (`n` negative goes back): a day or a week moves by its days, a month,
// a quarter or a year keeps the day of the month. Null when that day does not exist there (March 31
// one month back): the unit before ended before reaching it.
export function shiftUnits(
  day: string,
  unit: CalendarUnit,
  n: number,
): string | null {
  const [y, m, d] = ymd(day);
  if (unit === "day") return key(y, m, d + n);
  if (unit === "week") return key(y, m, d + 7 * n);
  const months = m - 1 + n * (MONTHS[unit] ?? 0);
  const ty = y + Math.floor(months / 12);
  const tm = (((months % 12) + 12) % 12) + 1;
  return d > daysInMonth(ty, tm) ? null : key(ty, tm, d);
}

// The local days a preset covers on `today`: its first day and the day after its last. A running
// preset's unit is the one holding today, and it is read up to the moment of the read; a closed one is
// the whole unit before.
export function presetDays(
  p: CalendarPreset,
  today: string,
): { first: string; end: string } {
  const { unit, back } = PRESETS[p];
  const current = unitStart(today, unit);
  // A unit's first day exists in every unit, so shifting it never runs off the end.
  const first = back ? (shiftUnits(current, unit, -1) as string) : current;
  return { first, end: shiftUnits(first, unit, 1) as string };
}

// Where the previous period of a calendar window stops, as a local day and whether it is the end of
// that period. A closed window's previous period ends where the window starts. A running one stops on
// the same day of the unit before, at the read's time of day (`at: "time"`), unless that day does not
// exist there, in which case the whole unit before is the comparison.
export function previousStop(
  first: string,
  unit: CalendarUnit,
  running: { today: string } | null,
): {
  first: string;
  stop: { day: string; at: "time" | "start" };
} {
  const prevFirst = shiftUnits(first, unit, -1) as string;
  if (!running) return { first: prevFirst, stop: { day: first, at: "start" } };
  const day = shiftUnits(running.today, unit, -1);
  return day
    ? { first: prevFirst, stop: { day, at: "time" } }
    : { first: prevFirst, stop: { day: first, at: "start" } };
}
