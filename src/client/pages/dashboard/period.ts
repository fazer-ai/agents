// THE GROUPS OF A LONG WINDOW, as the API answers them (`grain`, docs/dashboard.md): a point per local
// day, per local week starting on Monday, or per local month, keyed by the group's first local day.
// The console never picks the grouping: it reads it from the answer, so it draws what the API and the
// MCP tools return. A group at either edge of the window holds only the window's days, and its label
// says so.

export type Grain = "day" | "week" | "month";

function utc(day: string): Date {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function key(d: Date): string {
  return d.toISOString().split("T")[0] as string;
}

function plusDays(day: string, n: number): string {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return key(d);
}

// The group a local day falls in, by its first day.
export function groupOf(day: string, grain: Grain): string {
  if (grain === "month") {
    const [y, m] = day.split("-");
    return `${y}-${m}-01`;
  }
  if (grain === "week") return plusDays(day, -((utc(day).getUTCDay() + 6) % 7));
  return day;
}

// The last local day of the group that starts on `first`.
export function lastDayOf(first: string, grain: Grain): string {
  if (grain === "week") return plusDays(first, 6);
  if (grain === "month") {
    const d = utc(first);
    return key(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  }
  return first;
}

// The local days of a group that are inside the window, first and last inclusive.
export function periodDays(
  first: string,
  grain: Grain,
  bounds?: { first: string | null; last: string } | null,
): { first: string; last: string } {
  const last = lastDayOf(first, grain);
  return {
    first: bounds?.first && bounds.first > first ? bounds.first : first,
    last: bounds && bounds.last < last ? bounds.last : last,
  };
}

function local(day: string): Date {
  return new Date(`${day}T00:00:00`);
}

// A group as a window of instants, for the drill-down of a point: its days inside the window.
export function periodWindow(
  first: string,
  grain: Grain,
  bounds?: { first: string | null; last: string } | null,
): { since: Date; until: Date } {
  const days = periodDays(first, grain, bounds);
  const until = local(days.last);
  until.setDate(until.getDate() + 1);
  return { since: local(days.first), until };
}

// Two days as one range, with the locale's word between them ("Mar 9 to 15", "9 a 15 de mar.") in
// place of the dash `formatRange` puts there: the parts the two ends share are written once.
function dayRange(
  f: Intl.DateTimeFormat,
  from: Date,
  to: Date,
  word: string,
): string {
  return f
    .formatRangeToParts(from, to)
    .map((p) =>
      p.type === "literal" &&
      p.source === "shared" &&
      /[\u2013\u2014-]/.test(p.value)
        ? ` ${word} `
        : p.value,
    )
    .join("");
}

// How a group is written: `tick` on the axis, `long` in the tooltip, the detail and the keyboard
// label. A week reads as the days it covers in the window ("Mar 9 to 15", with `to` the locale's word
// for a range), a month as its name.
export function periodLabels(
  lang: string,
  grain: Grain,
  bounds?: { first: string | null; last: string } | null,
  to = "to",
): { tick: (key: string) => string; long: (key: string) => string } {
  const day = new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" });
  if (grain === "month") {
    const short = new Intl.DateTimeFormat(lang, {
      month: "short",
      year: "2-digit",
    });
    const full = new Intl.DateTimeFormat(lang, {
      month: "long",
      year: "numeric",
    });
    return {
      tick: (k) => short.format(local(k)),
      long: (k) => full.format(local(k)),
    };
  }
  if (grain === "week") {
    return {
      tick: (k) => day.format(local(periodDays(k, grain, bounds).first)),
      long: (k) => {
        const d = periodDays(k, grain, bounds);
        return d.first === d.last
          ? day.format(local(d.first))
          : dayRange(day, local(d.first), local(d.last), to);
      },
    };
  }
  const f = (k: string) => day.format(local(k));
  return { tick: f, long: f };
}
