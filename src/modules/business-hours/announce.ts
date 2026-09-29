import {
  isOutOfHoursNow,
  localDateKey,
  nextOpenAt,
  type Schedule,
  type WindowSpec,
} from "./hours";

// What a schedule says about ITSELF (open now, next opening, weekly grid), structurally: the wording
// and its language belong to whoever is speaking, so only the grid is prose. Every predicate routes
// through `isOutOfHoursNow`, never `isOpenAt`: no Availability and a schedule with no windows are the
// SAME always-on state to the gate, and a description derived otherwise would contradict the gate.

export type NextOpening =
  // Open right now — including the always-on shapes, where "next" is not a future event.
  | { kind: "now" }
  | { kind: "at"; when: Date }
  // Closed, and nothing opens within nextOpenAt's horizon (a year-long closure, or a grid every one
  // of whose windows an exception cancels).
  | { kind: "never" };

// null schedule = the agent has no Availability configured, which the gate treats as always on.
export function isOpenNow(schedule: Schedule | null, at: Date): boolean {
  return schedule === null || !isOutOfHoursNow(schedule, at);
}

export function nextOpening(schedule: Schedule | null, at: Date): NextOpening {
  if (isOpenNow(schedule, at)) return { kind: "now" };
  // Not reachable with a null schedule: isOpenNow already answered that above.
  const when = nextOpenAt(schedule as Schedule, at);
  return when === null ? { kind: "never" } : { kind: "at", when };
}

// Intl gives the localized weekday name so we don't need per-language i18n keys.
// 2024-01-07 is a Sunday, so day index 0..6 maps directly.
function dayName(day: number, locale: string): string {
  const ref = new Date(2024, 0, 7 + day);
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(ref);
}

// Groups consecutive days sharing the same set of windows into a compact summary like
// "Seg–Sex 09:00–18:00 · Sáb 09:00–13:00". A day may have multiple windows
// ("Seg–Sex 09:00–12:00, 14:00–18:00"); days without windows are omitted; empty input
// returns the `noWindows` fallback.
export function formatWindowsSummary(
  windows: WindowSpec[],
  noWindows: string,
  locale: string,
): string {
  if (!windows.length) return noWindows;

  const byDay = new Map<number, string[]>();
  for (const w of windows) {
    const slots = byDay.get(w.day) ?? [];
    slots.push(`${w.start}–${w.end}`);
    byDay.set(w.day, slots);
  }
  for (const slots of byDay.values()) slots.sort();

  type Run = { days: number[]; key: string; label: string };
  const runs: Run[] = [];
  for (let d = 0; d <= 6; d++) {
    const slots = byDay.get(d);
    if (!slots) continue;
    const key = slots.join("|");
    const last = runs[runs.length - 1];
    if (last && last.key === key && last.days[last.days.length - 1] === d - 1) {
      last.days.push(d);
    } else {
      runs.push({ days: [d], key, label: slots.join(", ") });
    }
  }

  return runs
    .map(({ days, label }) => {
      const first = dayName(days[0] as number, locale);
      const last =
        days.length > 1
          ? dayName(days[days.length - 1] as number, locale)
          : null;
      const dayPart = last ? `${first}–${last}` : first;
      return `${dayPart} ${label}`;
    })
    .join(" · ");
}

// Weekday AND date, in both languages: a bare weekday is ambiguous for closures (a year-end shutdown
// answering "Saturday" means the one eleven days out). `hourCycle: "h23"` keeps midnight at 00:00
// instead of the 24:00 some ICU builds render. The year joins only when the opening falls in a
// different one (`nextOpenAt` scans NEXT_OPEN_SCAN_DAYS ahead), so ordinary "back tomorrow" stays short.
export function formatNextOpen(
  at: Date,
  now: Date,
  timezone: string,
  locale: string,
): string {
  const year =
    localDateKey(at, timezone).slice(0, 4) ===
    localDateKey(now, timezone).slice(0, 4)
      ? {}
      : ({ year: "numeric" } as const);
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    ...year,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}
