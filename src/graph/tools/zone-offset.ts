// The one piece of timezone knowledge the code sandbox needs from the host: a zone's UTC offset at
// an instant. Intl lives here (Bun ships ICU; the interpreter has none), and the same function
// serves the host-side `NOW_LOCAL` string and the interpreter's `Date`, so the two cannot disagree.

export function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// The zone if Intl knows it, else UTC: the snippet always has a clock, and a misspelt zone in an
// agent's settings is a UTC clock rather than no tool.
export function resolveTimezone(timezone: string): string {
  try {
    zoneFormatter(timezone);
    return timezone;
  } catch {
    return "UTC";
  }
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// The wall clock of an instant in the formatter's zone. Throws on an instant Intl cannot format.
export function wallClock(
  fmt: Intl.DateTimeFormat,
  instantMs: number,
): WallClock {
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

// East-positive minutes: wall time = instant + offset. Compared on whole seconds, because the wall
// clock has no fraction to compare against. An instant Intl cannot place (NaN, out of range) is
// reported as UTC rather than thrown, since the caller is `Date` arithmetic that never throws.
export function zoneOffsetMinutes(
  fmt: Intl.DateTimeFormat,
  instantMs: number,
): number {
  if (!Number.isFinite(instantMs)) return 0;
  let w: WallClock;
  try {
    w = wallClock(fmt, instantMs);
  } catch {
    return 0;
  }
  // NOTE: Not `Date.UTC`: it reads a year of 0–99 as 1900–1999, and the offset for a date in that
  // range came out as sixteen million hours (PR #485, round 8). `setUTCFullYear` takes the year
  // as written.
  const wall = new Date(0);
  wall.setUTCFullYear(w.year, w.month - 1, w.day);
  wall.setUTCHours(w.hour, w.minute, w.second, 0);
  const wallAsUtc = wall.getTime();
  const wholeSecondMs = Math.floor(instantMs / 1000) * 1000;
  const minutes = Math.round((wallAsUtc - wholeSecondMs) / 60_000);
  return Number.isFinite(minutes) ? minutes : 0;
}
