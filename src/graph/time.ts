// Time helpers shared by the get_current_time native tool and the {{hora_atual}} prompt variable.
// Rounding DOWN to a slot (default 30 min) keeps the injected time stable within the slot, which
// helps prompt caching: the system prompt does not change on every request, only every slot.

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

// Floors the epoch to a `minutes`-wide slot. For whole/half-hour timezone offsets (the common case,
// incl. the default America/Sao_Paulo) this lands on local :00/:30; exotic :45 offsets may differ.
export function roundDownToMinutes(date: Date, minutes: number): Date {
  if (!Number.isFinite(minutes) || minutes <= 0) return date;
  const ms = minutes * 60_000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

export interface TimeParts {
  YYYY: string;
  MM: string;
  DD: string;
  HH: string;
  mm: string;
  ss: string;
  weekday: string;
}

// Extracts the wall-clock parts of `date` AS SEEN in `timezone` (h23 so midnight is "00", not "24").
export function partsInTimezone(
  date: Date,
  timezone: string,
  locale = "pt-BR",
): TimeParts {
  const dtf = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
  });
  const parts = dtf.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    YYYY: get("year"),
    MM: get("month"),
    DD: get("day"),
    HH: get("hour"),
    mm: get("minute"),
    ss: get("second"),
    weekday: get("weekday"),
  };
}

// Floors to a `minutes`-wide slot ON THE LOCAL WALL CLOCK of `timezone`, which is not the same thing
// as flooring the epoch (`roundDownToMinutes`) wherever the zone's offset is not a whole multiple of
// the slot. Measured in Asia/Kathmandu (+05:45), rounding to the half hour: 00:05 on the 18th floors
// to 23:45 on the 17th, so a caller that renders the result as "the current moment" states YESTERDAY
// and anything reasoning from it is a day off (round 6 of the review on issue #685).
//
// The DATE is what makes this load-bearing: the rounding exists to keep a value stable inside a slot
// for the prompt cache, and moving the local date to buy that is trading the answer for the cache.
export function roundDownLocalMinutes(
  date: Date,
  timezone: string,
  minutes: number,
): Date {
  if (!Number.isFinite(minutes) || minutes <= 0) return date;
  const p = partsInTimezone(date, timezone);
  const minute = Number(p.mm);
  if (!Number.isFinite(minute)) return date;
  const floored = Math.floor(minute / minutes) * minutes;
  const wall = `${p.YYYY}-${p.MM}-${p.DD}T${p.HH}:${String(floored).padStart(2, "0")}:00`;
  // Null only for a wall clock the zone does not have, which flooring a minute inside an existing
  // hour cannot produce; the unrounded instant is the honest fallback either way.
  return zonedWallClockToInstant(wall, timezone) ?? date;
}

// Substitutes the supported tokens (YYYY/MM/DD/HH/mm/ss) in a custom pattern. Tokens are distinct
// and case-sensitive (MM = month, mm = minute), so a flat sequence of replaces is unambiguous.
export function formatWithPattern(
  date: Date,
  timezone: string,
  pattern: string,
): string {
  const p = partsInTimezone(date, timezone);
  return pattern
    .replace(/YYYY/g, p.YYYY)
    .replace(/DD/g, p.DD)
    .replace(/MM/g, p.MM)
    .replace(/HH/g, p.HH)
    .replace(/mm/g, p.mm)
    .replace(/ss/g, p.ss);
}

// Converts an offset-less wall-clock "YYYY-MM-DDTHH:mm[:ss]" into the absolute instant that, formatted
// back in `timezone`, reads as that same wall-clock. Used by the playground to simulate "the current
// time" in the agent's OWN timezone (so {{hora_atual}} shows exactly what the operator typed, no
// matter the browser's tz). Single-pass offset correction; the rare DST-transition ambiguity (a
// wall-clock that occurs zero or twice) resolves to one best-effort instant. Returns null if
// unparseable, so a bad value falls back to the real now.
export function zonedWallClockToInstant(
  wall: string,
  timezone: string,
): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    wall.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
  );
  if (!Number.isFinite(asUtc)) return null;
  const p = partsInTimezone(new Date(asUtc), timezone);
  const formattedUtc = Date.UTC(+p.YYYY, +p.MM - 1, +p.DD, +p.HH, +p.mm, +p.ss);
  return new Date(asUtc - (formattedUtc - asUtc));
}

// Human-readable date+time in a timezone (for the get_current_time tool output and previews).
export function formatHumanDateTime(
  date: Date,
  timezone: string,
  locale = "pt-BR",
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(date);
}
