// Time helpers shared by the get_current_time native tool and the {{hora_atual}} prompt variable.
// Rounding DOWN to a slot (default 30 min) keeps the injected time stable within the slot, which
// helps prompt caching: the system prompt does not change on every request, only every slot.

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

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
// as flooring the epoch wherever the zone's offset is not a whole multiple of
// the slot. Measured in Asia/Kathmandu (+05:45), rounding to the half hour: 00:05 on the 18th floors
// to 23:45 on the 17th, so a caller that renders the result as "the current moment" states YESTERDAY
// and anything reasoning from it is a day off (round 6 of the review on issue #685).
//
// The DATE is what makes this load-bearing: the rounding exists to keep a value stable inside a slot
// for the prompt cache, and moving the local date to buy that is trading the answer for the cache.
// The local wall clock of `date` in `timezone`, floored to a `minutes`-wide slot counted from local
// midnight. It returns PARTS, and that is the design rather than a detail: every earlier version of
// this returned an instant, and each of rounds 7, 8 and 10 of the review found a different defect in
// the arithmetic that produced it — a floor that moved forward, a floor 75 minutes behind on a
// 30-minute slot, a floor that reported yesterday's date. All three came from the same place, doing
// arithmetic on instants and then asking a timezone what wall clock they landed on, across a
// transition where that question has two answers.
//
// Floored parts have no such question. The date is the date `partsInTimezone` already read, so it is
// right by construction; the time is integer arithmetic on the minutes since local midnight, so it is
// always a slot boundary and never later than the clock it was read from; and two instants inside one
// local slot produce the same parts, which is the prompt-cache stability this exists for. What it
// gives up is the one case an instant could have answered better: on a day whose clocks SKIPPED the
// boundary (America/Santiago's 6 September 2026 begins at 01:00, so 00:00 never happens there), the
// floor names that missing wall clock. The error is bounded by the slot and the date stays right,
// which is the trade this function is here to make — a wrong DATE is the defect, a time floored into a
// skipped hour is a coarse answer.
export function flooredLocalParts(
  date: Date,
  timezone: string,
  minutes: number,
): TimeParts {
  const p = partsInTimezone(date, timezone);
  if (!Number.isFinite(minutes) || minutes <= 0) return p;
  // MINUTES SINCE LOCAL MIDNIGHT, not the minute field: a slot of 120 flooring only the minutes would
  // reset every hour and behave like 60, and 45 would mean something different in each hour
  // (`get_current_time` takes any positive integer here).
  const sinceMidnight = Number(p.HH) * 60 + Number(p.mm);
  if (!Number.isFinite(sinceMidnight)) return p;
  const floored = Math.floor(sinceMidnight / minutes) * minutes;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    ...p,
    HH: pad(Math.floor(floored / 60)),
    mm: pad(floored % 60),
    ss: "00",
  };
}

// Renders already-read parts, so a caller that floored them does not have to turn them back into an
// instant to say them out loud. `formatWithPattern` is this over a fresh read.
export function formatParts(p: TimeParts, pattern: string): string {
  return pattern
    .replace(/YYYY/g, p.YYYY)
    .replace(/DD/g, p.DD)
    .replace(/MM/g, p.MM)
    .replace(/HH/g, p.HH)
    .replace(/mm/g, p.mm)
    .replace(/ss/g, p.ss);
}

// The human sentence for already-read parts. The instant is rebuilt in UTC purely to hand `Intl` the
// numbers: it is formatted in UTC as well, so nothing here is a claim about which instant those parts
// name, and the weekday and month names come out of the local date that was read.
export function formatPartsHuman(p: TimeParts, locale = "pt-BR"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    dateStyle: "full",
    timeStyle: "short",
  }).format(
    new Date(
      Date.UTC(
        Number(p.YYYY),
        Number(p.MM) - 1,
        Number(p.DD),
        Number(p.HH),
        Number(p.mm),
        Number(p.ss),
      ),
    ),
  );
}

export function formatWithPattern(
  date: Date,
  timezone: string,
  pattern: string,
): string {
  return formatParts(partsInTimezone(date, timezone), pattern);
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
