// LOCAL DAYS IN A ZONE, the unit the kept figures are stored in. A day is `YYYY-MM-DD` in the zone the
// dashboard asks for, and its bounds are the two local midnights around it, which are 23 or 25 hours
// apart across a daylight-saving change.

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallClock(instant: number, tz: string) {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(instant))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

// The zone's offset from UTC at `instant`, in milliseconds (wall clock minus UTC).
function offsetAt(instant: number, tz: string): number {
  const w = wallClock(instant, tz);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

export function localDay(instant: Date | number, tz: string): string {
  const w = wallClock(
    typeof instant === "number" ? instant : instant.getTime(),
    tz,
  );
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

function ymd(day: string): [number, number, number] {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m, d];
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// The first instant of `day` in `tz`: its local midnight, or, where a daylight-saving change skips
// midnight, the instant the clock jumps to. Two offset corrections settle every zone but that one; a
// result that is not the first instant of the day is searched for, to the minute, in the hours around.
export function dayStart(day: string, tz: string): Date {
  const [y, m, d] = ymd(day);
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - offsetAt(wall, tz);
  t = wall - offsetAt(t, tz);
  if (localDay(t, tz) === day && localDay(t - 60_000, tz) < day)
    return new Date(t);
  let lo = Math.floor((wall - 16 * 3_600_000) / 60_000);
  let hi = Math.floor((wall + 16 * 3_600_000) / 60_000);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDay(mid * 60_000, tz) >= day) hi = mid;
    else lo = mid + 1;
  }
  return new Date(lo * 60_000);
}

// How many days from `first` to `last`, both inclusive, without listing them.
export function dayCount(first: string, last: string): number {
  if (first > last) return 0;
  const [y1, m1, d1] = ymd(first);
  const [y2, m2, d2] = ymd(last);
  return (
    Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS) +
    1
  );
}

// Every day from `first` to `last`, both inclusive, in order.
export function daysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

// Runs of consecutive days in a list of distinct days, as inclusive [first, last] pairs, ascending.
export function runsOf(days: string[]): [string, string][] {
  const runs: [string, string][] = [];
  for (const d of [...days].sort()) {
    const last = runs[runs.length - 1];
    if (last && addDays(last[1], 1) === d) last[1] = d;
    else runs.push([d, d]);
  }
  return runs;
}
