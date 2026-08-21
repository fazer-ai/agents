import {
  isOutOfHoursNow,
  localDateKey,
  nextOpenAt,
  type Schedule,
  type WindowSpec,
} from "./hours";

// What a schedule says about ITSELF, for the surfaces that describe it to a person: is it open, when
// does it open next, and what is the weekly grid. Deliberately structural — the wording and its
// language belong to whoever is speaking (a prompt variable in pt-BR, an English one, a console
// label), so nothing here returns prose except the grid, whose shape IS the answer.
//
// Every predicate below routes through `isOutOfHoursNow`, never through `isOpenAt` directly. That is
// the whole point of the file: an agent with NO Availability configured and an agent whose schedule
// has no windows are the SAME always-on state to the gate, and a description derived any other way
// starts contradicting the gate it exists to describe.

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

// NOTE: Intl gives the localized weekday name so we don't need per-language i18n keys.
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

// Weekday AND date, in both languages. A bare weekday reads fine for "closed for the night" and is
// ambiguous for exactly the closures #148 added: a year-end shutdown answers "Saturday", which is the
// Saturday eleven days out. One format that is never ambiguous beats two that are each right half the
// time. `hourCycle: "h23"` keeps midnight at 00:00 instead of the 24:00 some ICU builds render.
//
// The year joins it only when the promise crosses into a different one, which is the same argument
// one notch further out: `nextOpenAt` scans NEXT_OPEN_SCAN_DAYS ahead, so a schedule closed for
// nearly a year answers with a date that reads as this week's ("01/01") and means the next year's.
// Printing it always would tax every ordinary "back tomorrow" for a case almost nothing reaches.
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
