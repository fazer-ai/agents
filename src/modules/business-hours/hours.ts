import { z } from "zod";

// Pure business-hours time logic (DST-correct via Intl; Temporal is unavailable in Bun). A schedule
// has two dimensions: a weekly grid of {day, start, end} windows, and date EXCEPTIONS that replace
// the grid on the dates they match. start/end are "HH:MM" local wall times in the configured IANA
// timezone. Used by the reactive availability gate, follow-ups, the console indicators and the
// bookable-slot filter — never embeds I/O, so it is deterministic and unit-testable with fixed
// instants (incl. DST boundaries).
//
// Every decision takes a whole `Schedule`, not a WindowSpec[]. That is deliberate: exceptions cannot
// travel inside an array of weekly windows, so an optional second argument would have compiled at all
// nine existing read sites and silently kept ignoring holidays — the exact failure this module exists
// to remove. Passing the schedule makes the compiler name every site that has to carry the new
// dimension.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A span of the local day. It carries no weekday: inside an exception the date already fixes one,
// and inside the weekly grid WindowSpec adds it.
export const timeRangeSchema = z.object({
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
});
export type TimeRange = z.infer<typeof timeRangeSchema>;

export const windowSpecSchema = z.object({
  day: z.number().int().min(0).max(6),
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
});
export type WindowSpec = z.infer<typeof windowSpecSchema>;

// `ranges: []` is the common case (closed all day: holiday, shutdown day). A non-empty `ranges`
// covers the half-day — Christmas Eve until noon — without a second concept.
// `recurring` compares month-day only, so the same entry serves every year; movable holidays
// (Carnival, Good Friday) are a different date each year and need a dated entry per year.
// `dateEnd` is inclusive; under `recurring` a dateEnd whose month-day precedes `date`'s wraps the
// year end, which is what a Dec 23 → Jan 2 shutdown needs.
export const scheduleExceptionSchema = z.object({
  date: z.string().regex(ISO_DATE),
  dateEnd: z.string().regex(ISO_DATE).optional(),
  recurring: z.boolean().optional(),
  label: z.string().optional(),
  ranges: z.array(timeRangeSchema),
});
export type ScheduleException = z.infer<typeof scheduleExceptionSchema>;

export interface Schedule {
  windows: WindowSpec[];
  exceptions: ScheduleException[];
  timezone: string;
}

// How many entries of each dimension a schedule may hold. Named rather than inline because a second
// place sizes itself from the window count: the audited prompt renders a schedule in full once per
// variable name, and the log debug mode's ceiling reserves room for that
// (`src/modules/flowlog/service.ts`, issue #58).
//
// Only ONE of the two is also enforced by the reader, and the asymmetry is the rule rather than an
// oversight, because truncation is not the same act on the two dimensions:
//
//   - a WINDOW is availability, so dropping one can only make the schedule narrower. Truncating at
//     the reader therefore fails in the safe direction, and it is what makes the allowance above a
//     bound instead of a margin: the rendering is linear in the count, ~13 characters per window
//     (measured through `formatWindowsSummary`: 2,639 at 200 windows and 65,039 at 5,000), and
//     `businessHoursCreateSchema` is not the only writer — the agent import takes both columns as
//     `z.array(z.unknown())`, so without this a hand-authored bundle would render past what the
//     ceiling reserved;
//   - an EXCEPTION is a closure, so dropping one makes the schedule WIDER. A dated holiday past the
//     cap would stop being honoured and the weekly grid would apply on it, which is the exact
//     always-open failure this module exists to prevent (measured: with Christmas at position 401
//     of 401, `isOutOfHoursNow` at noon on the 25th flips from true to false). Truncating there
//     would also do it SILENTLY and RETROACTIVELY, to rows already written. So the exceptions bound
//     is enforced where a person can be told about it — the import, which warns — and never here.
export const MAX_SCHEDULE_WINDOWS = 200;
export const MAX_SCHEDULE_EXCEPTIONS = 400;

// Shape-valid windows only, with dead ones dropped and the count bounded. Validated ENTRY BY ENTRY,
// like parseExceptions below, and for a sharper reason: the two failure directions are not symmetric
// here. An empty window list is not "closed", it is ALWAYS OPEN (see scheduleCanClose), so refusing
// the whole array over one unreadable element silently widens availability on every day of the week
// — the single direction this dimension must never fail in. Dropping that one element cannot: the
// schedule it leaves is a subset of the one the operator wrote.
//
// Dead windows (end <= start) go too. The half-open [start, end) test in isOpenAt can never match
// them, so they would only feed an impossible window to nextOpenAt. Writes reject them
// (assertValidWindows); this also heals rows persisted before that validation existed.
export function parseWindows(raw: unknown): WindowSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: WindowSpec[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SCHEDULE_WINDOWS) break;
    const parsed = windowSpecSchema.safeParse(item);
    if (!parsed.success || !isRangeOrdered(parsed.data)) continue;
    out.push(parsed.data);
  }
  return out;
}

// Shape-valid entries only, with dead ranges and impossible calendar dates dropped, so a hand-edited
// row can never widen availability. Validated ENTRY BY ENTRY, not as one array: a single malformed
// element would otherwise take every valid holiday with it and silently restore the weekly hours on
// all of them, which is the one direction this dimension must never fail in.
//
// Deliberately UNCAPPED, unlike parseWindows: dropping a closure widens availability, so a cap here
// would fail in that same forbidden direction, silently and on rows already written. The count is
// bounded at the writers instead (see MAX_SCHEDULE_EXCEPTIONS).
export function parseExceptions(raw: unknown): ScheduleException[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleException[] = [];
  for (const item of raw) {
    const parsed = scheduleExceptionSchema.safeParse(item);
    if (!parsed.success) continue;
    const e = parsed.data;
    if (!isRealDate(e.date) || (e.dateEnd && !isRealDate(e.dateEnd))) continue;
    out.push({ ...e, ranges: e.ranges.filter(isRangeOrdered) });
  }
  return out;
}

export function parseSchedule(row: {
  windows: unknown;
  exceptions?: unknown;
  timezone: string;
}): Schedule {
  return {
    windows: parseWindows(row.windows),
    exceptions: parseExceptions(row.exceptions),
    timezone: row.timezone,
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

// A range is well-formed only when its end is strictly after its start. The
// implementation does not model overnight ranges (end < start crossing
// midnight): express those as two, e.g. Tue 08:00–23:59 + Wed 00:00–02:00.
export function isRangeOrdered(w: TimeRange): boolean {
  return toMinutes(w.end) > toMinutes(w.start);
}

// "YYYY-MM-DD" is a real day on the proleptic Gregorian calendar. Guards against 2026-02-30 and
// 2026-13-01, which the regex accepts and Date.UTC silently rolls over.
export function isRealDate(ymd: string): boolean {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

interface LocalDate {
  y: number;
  mo: number; // 0-based, to match Date.UTC
  d: number;
  weekday: number; // 0=Sun..6=Sat
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// The local wall-clock date + weekday + minute-of-day for an instant in a timezone.
function zonedParts(at: Date, tz: string): LocalDate & { minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  let weekday = 0;
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(at)) {
    if (part.type === "weekday") weekday = WEEKDAY_INDEX[part.value] ?? 0;
    else if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return {
    y: p.year as number,
    mo: (p.month as number) - 1,
    d: p.day as number,
    weekday,
    minutes: ((p.hour as number) % 24) * 60 + (p.minute as number),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymdKey(date: LocalDate): string {
  return `${date.y}-${pad2(date.mo + 1)}-${pad2(date.d)}`;
}

// Does `key` fall in the exception's span? ISO keys compare lexicographically, so a plain string
// comparison is the date comparison. Under `recurring` the year is dropped from both sides, and a
// span whose end precedes its start wraps the year end (Dec 23 → Jan 2).
function exceptionCovers(e: ScheduleException, key: string): boolean {
  const from = e.recurring ? e.date.slice(5) : e.date;
  const to = e.dateEnd ? (e.recurring ? e.dateEnd.slice(5) : e.dateEnd) : from;
  const k = e.recurring ? key.slice(5) : key;
  // A span ending before it starts only means something under month-day comparison, where it wraps the
  // year end. On full dates it describes an empty span and covers nothing — the same answer
  // assertValidExceptions gives when one is written through the API, which the import path bypasses.
  if (to < from) return e.recurring === true && (k >= from || k <= to);
  return k >= from && k <= to;
}

// The ranges that actually govern a local date: the first matching exception's, or the weekly grid's
// windows for that weekday. A DATED exception outranks a recurring one so a single year can override
// the yearly rule ("closed every Dec 25" + "Dec 25 2026 we open until noon"); within the same kind,
// array order decides.
function findException(
  schedule: Schedule,
  date: LocalDate,
): ScheduleException | null {
  if (schedule.exceptions.length === 0) return null;
  const key = ymdKey(date);
  return (
    schedule.exceptions.find((e) => !e.recurring && exceptionCovers(e, key)) ??
    schedule.exceptions.find((e) => e.recurring && exceptionCovers(e, key)) ??
    null
  );
}

function rangesForLocalDate(schedule: Schedule, date: LocalDate): TimeRange[] {
  // Dead ranges (end <= start) are dropped HERE rather than at each caller. isOpenAt tolerates them
  // (its half-open [start, end) test simply never matches), but nextOpenAt keys off `start` alone and
  // would report a bogus opening instant for one. The parsers already drop them on the way out of the
  // database; this also covers a Schedule built in memory.
  const ordered = (rs: TimeRange[]) => rs.filter(isRangeOrdered);
  const hit = findException(schedule, date);
  if (hit) return ordered(hit.ranges);
  return ordered(schedule.windows.filter((w) => w.day === date.weekday));
}

// The local calendar date of an instant ("YYYY-MM-DD") in a timezone. Exported for the surfaces that
// need "is this the same day as that" without reimplementing the zone math — the away-message cadence
// compares the last notice's local day against today's, and a UTC comparison would roll the day over
// three hours early for America/Sao_Paulo.
export function localDateKey(at: Date, timezone: string): string {
  return ymdKey(zonedParts(at, timezone));
}

// The exception governing the local date of an instant, or null when the weekly grid decides. The
// operator-facing surfaces need the entry itself (its label is what makes the closure explainable),
// not just the ranges it resolves to.
export function exceptionInForceAt(
  schedule: Schedule,
  at: Date,
): ScheduleException | null {
  return findException(schedule, zonedParts(at, schedule.timezone));
}

// The ranges governing the local date of an instant. Exported for the surfaces that explain the
// schedule to a human (and for tests): everything else goes through the predicates below.
export function effectiveRangesAt(schedule: Schedule, at: Date): TimeRange[] {
  return rangesForLocalDate(schedule, zonedParts(at, schedule.timezone));
}

export function isOpenAt(schedule: Schedule, at: Date): boolean {
  const parts = zonedParts(at, schedule.timezone);
  return rangesForLocalDate(schedule, parts).some(
    (w) =>
      parts.minutes >= toMinutes(w.start) && parts.minutes < toMinutes(w.end),
  );
}

// Can this schedule ever close? A schedule that does not exist and one with no windows are the same
// answer — always open — and everything downstream of the reactive gate (the operator's private note,
// the customer's away message) therefore never runs for either.
//
// Named because two very different places need it and only one of them is the gate. The console has
// to say whether the away message an operator wrote can go out at all, and re-deriving "no windows
// means always open" over there is how a console starts describing a runtime it no longer matches.
//
// Typed as a guard rather than a boolean, so the gate that asks it keeps the narrowing its old inline
// null-check gave it. True is a stronger claim than the name promises — there IS a schedule, and it
// closes — which is exactly the pair every caller needs before doing anything with it.
export function scheduleCanClose(
  schedule: Schedule | null | undefined,
): schedule is Schedule {
  return !!schedule && schedule.windows.length > 0;
}

// "Is this schedule currently CLOSED?" — true only when an availability schedule is configured (≥1
// weekly window) AND `at` falls outside every range in force. No windows = always-on, so never out of
// hours: an exception alone cannot close an always-on agent, because there is no schedule to except
// from. Shared by the operator-facing "out of hours" badge (conversation header, lists) and the
// reactive gate.
export function isOutOfHoursNow(schedule: Schedule, at: Date): boolean {
  if (!scheduleCanClose(schedule)) return false;
  return !isOpenAt(schedule, at);
}

// Does the interval [start, end] fit ENTIRELY inside one of the ranges in force? True only when start
// and end fall on the same local date (no midnight crossing) and both land within a single range
// (start inclusive, end inclusive at its close). This is the slot-fit test the appointment-
// availability tool uses to keep candidate slots inside the service hours.
export function fitsWithinWindows(
  schedule: Schedule,
  start: Date,
  end: Date,
): boolean {
  const s = zonedParts(start, schedule.timezone);
  const e = zonedParts(end, schedule.timezone);
  if (s.weekday !== e.weekday) return false;
  if (e.minutes <= s.minutes) return false;
  return rangesForLocalDate(schedule, s).some(
    (w) => s.minutes >= toMinutes(w.start) && e.minutes <= toMinutes(w.end),
  );
}

// The tz offset (ms to ADD to UTC to get local wall time) at a given instant.
function tzOffsetMs(tz: string, instant: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    p.year as number,
    (p.month as number) - 1,
    p.day as number,
    (p.hour as number) % 24,
    p.minute as number,
    p.second as number,
  );
  return asUtc - instant.getTime();
}

// UTC instant for a local wall time (two-pass, DST-correct). Ambiguous/skipped wall times near a
// transition resolve to a deterministic neighboring instant — acceptable for scheduling.
function zonedTimeToUtc(
  tz: string,
  y: number,
  mo: number,
  d: number,
  minutes: number,
): Date {
  const guess = Date.UTC(y, mo, d, Math.floor(minutes / 60), minutes % 60);
  const off1 = tzOffsetMs(tz, new Date(guess));
  let utc = guess - off1;
  const off2 = tzOffsetMs(tz, new Date(utc));
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

// How far nextOpenAt looks ahead. A weekly grid alone repeats within 7 days, so 14 was always
// enough; a shutdown expressed as a date range is not bounded by the week, and a year-end closure
// routinely outlives two weeks. A full year plus a day also settles every recurring entry, and past
// that a schedule that never opens is better reported than scanned for.
export const NEXT_OPEN_SCAN_DAYS = 366;

// The next instant the business is open at or after `at`. Returns `at` itself when already open, or
// null when there are no windows or nothing opens within the horizon.
export function nextOpenAt(schedule: Schedule, at: Date): Date | null {
  if (schedule.windows.length === 0) return null;
  if (isOpenAt(schedule, at)) return at;

  const tz = schedule.timezone;
  const { y, mo, d } = zonedParts(at, tz);
  for (let offset = 0; offset <= NEXT_OPEN_SCAN_DAYS; offset++) {
    const dayDate = new Date(Date.UTC(y, mo, d + offset));
    const local: LocalDate = {
      y: dayDate.getUTCFullYear(),
      mo: dayDate.getUTCMonth(),
      d: dayDate.getUTCDate(),
      weekday: dayDate.getUTCDay(),
    };
    let best: number | null = null;
    for (const w of rangesForLocalDate(schedule, local)) {
      const start = zonedTimeToUtc(
        tz,
        local.y,
        local.mo,
        local.d,
        toMinutes(w.start),
      ).getTime();
      // Strictly after: `at` itself was already answered by the isOpenAt early return above (a range
      // is open AT its start), so the scan is only ever looking for a LATER opening. No input reaches
      // here with start === at, which is why relaxing this to >= changes nothing — and why it must
      // not be relaxed on the assumption that it would.
      if (start > at.getTime() && (best === null || start < best)) best = start;
    }
    if (best !== null) return new Date(best);
  }
  return null;
}
