// The windows the audit page's period control offers, and the arithmetic behind them. EVERYTHING
// HERE IS PURE, with `today` an ARGUMENT: the suite runs at UTC, where a wrong-zone "yesterday"
// passes every test, so the page reads the clock once and hands the day down. A DATE KEY IS
// `YYYY-MM-DD` IN THE OPERATOR'S CALENDAR (what `<input type="date">` emits), and the arithmetic
// runs in UTC on that string, never on a local `Date` plus days, which crosses DST by an hour and
// lands on the wrong day twice a year. The presets are a LOG's, not a dashboard's: the calendar
// family is the long one, and the only trailing window is 30 days.

export type DateKey = string;

export const AUDIT_PERIOD_PRESETS = [
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "this-month",
  "last-month",
  "30d",
  "this-year",
  "last-year",
  "custom",
] as const;

export type AuditPeriodPreset = (typeof AUDIT_PERIOD_PRESETS)[number];

// THE YEAR FLOOR IS NOT DECORATION. `0202-08-01` is what a date input holds halfway through typing a
// year, and it round-trips through `Date.UTC` perfectly well — so a pattern of four bare digits
// accepts it, commits it to the URL, and every request from the page comes back filtered by the
// third century. The month and day ranges are here for the same reason: this value travels in a URL
// somebody can paste.
export const DATE_KEY_RE = /^[1-9]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function toUtc(key: DateKey): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function keyOf(date: Date): DateKey {
  return date.toISOString().slice(0, 10);
}

/** `key` moved by `days`, in the calendar rather than in elapsed time. */
export function shiftDays(key: DateKey, days: number): DateKey {
  const at = toUtc(key);
  at.setUTCDate(at.getUTCDate() + days);
  return keyOf(at);
}

// The Monday on or before a date key.
//
// MONDAY, and it is a decision rather than a default. A trail is read against a working week, and
// "last week" that opens on Sunday puts Saturday's incident in the window the operator calls "this
// week" on Monday morning — the one day they are most likely to be asking about it.
export function mondayOf(key: DateKey): DateKey {
  const weekday = toUtc(key).getUTCDay();
  return shiftDays(key, -((weekday + 6) % 7));
}

function firstOfMonth(key: DateKey): DateKey {
  return `${key.slice(0, 7)}-01`;
}

function firstOfYear(key: DateKey): DateKey {
  return `${key.slice(0, 4)}-01-01`;
}

function shiftMonths(key: DateKey, months: number): DateKey {
  const at = toUtc(firstOfMonth(key));
  at.setUTCMonth(at.getUTCMonth() + months);
  return keyOf(at);
}

/**
 * The window a preset resolves to on the day `today`.
 *
 * A CLOSED period ends in the past and does not move while it is read; an open one ends today and
 * is still filling. Both are here on purpose, and the distinction is the reason the calendar
 * presets exist beside the trailing one: "last month" is what an operator reports on, "last 30 days"
 * is what they watch.
 */
export function auditPresetRange(
  preset: Exclude<AuditPeriodPreset, "custom">,
  today: DateKey,
): { from: DateKey; to: DateKey } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const day = shiftDays(today, -1);
      return { from: day, to: day };
    }
    case "this-week":
      return { from: mondayOf(today), to: today };
    case "last-week": {
      const monday = shiftDays(mondayOf(today), -7);
      return { from: monday, to: shiftDays(monday, 6) };
    }
    case "this-month":
      return { from: firstOfMonth(today), to: today };
    case "last-month":
      // NOTE: The last day of the previous month is the day before this one opens, which needs no
      // month-length table and no leap-year case.
      return {
        from: shiftMonths(today, -1),
        to: shiftDays(firstOfMonth(today), -1),
      };
    case "30d":
      // NOTE: Thirty days INCLUDING today, so the window is thirty and not thirty-one.
      return { from: shiftDays(today, -29), to: today };
    case "this-year":
      return { from: firstOfYear(today), to: today };
    default: {
      const lastYear = String(Number(today.slice(0, 4)) - 1);
      return { from: `${lastYear}-01-01`, to: `${lastYear}-12-31` };
    }
  }
}

/**
 * Which preset a `from`/`to` pair IS, so a pasted URL selects the right row instead of falling to
 * "custom" with the same two dates in it.
 *
 * Answered by resolving each preset and comparing, rather than by reasoning about the pair: the two
 * can only disagree if the arithmetic above is wrong, and then it is wrong in one place.
 */
export function auditPresetOf(
  from: string,
  to: string,
  today: DateKey,
): AuditPeriodPreset {
  if (!DATE_KEY_RE.test(from) || !DATE_KEY_RE.test(to)) return "custom";
  for (const preset of AUDIT_PERIOD_PRESETS) {
    if (preset === "custom") continue;
    const range = auditPresetRange(preset, today);
    if (range.from === from && range.to === to) return preset;
  }
  return "custom";
}

/**
 * Whether a `from`/`to` pair is a window worth committing. PURE AND SEPARATE FROM THE CONTROL:
 * `<input type="date">` reports "" mid-typing, so a control refusing anything unusable snaps back
 * and blocks keyboard entry. A draft holds anything and commits only a usable PAIR, checked
 * together: checked per field, moving a window forward is refused in both orders, so some windows
 * cannot be reached at all.
 */
export function isUsableRange(from: string, to: string): boolean {
  if (!DATE_KEY_RE.test(from) || !DATE_KEY_RE.test(to)) return false;
  // NOTE: String comparison is date comparison for this shape, which is the reason the shape is fixed.
  return from <= to;
}

/**
 * Whether a draft window is ready to be applied, GIVEN the one already applied. While a PAIR is
 * applied, only a usable pair commits (see `isUsableRange`): anything looser fires a request off a
 * half-erased window. A ONE-SIDED window ("since the 1st") is a filter a URL can carry, and there the
 * pair rule would refuse every edit forever, the input showing a new date while the query keeps the
 * old one. So when the applied window is not a pair, a single valid bound commits, and emptying the
 * last one removes the filter.
 */
export function isCommittableRange(
  draft: { from: string; to: string },
  applied: { from: string; to: string },
): boolean {
  if (draft.from && draft.to) return isUsableRange(draft.from, draft.to);
  if (applied.from && applied.to) return false;
  if (!draft.from && !draft.to) return true;
  return DATE_KEY_RE.test(draft.from || draft.to);
}

/**
 * How long until the local calendar day changes. A page filtered to Today and left open overnight
 * would keep saying "Today" while querying yesterday; the day is read per render and `selectedPreset`
 * drops a stale mode, so one timer is the whole correction. It takes THE DAY THE PAGE SHOWS, so it
 * aims at that day's end and the day is a real dependency of the effect. Local components, so the
 * boundary is the operator's midnight; a second of slack lands past it (a clock a millisecond behind
 * would re-arm for nothing), and the floor keeps a past day from arming a zero.
 */
export function msUntilNextLocalMidnight(
  day: DateKey,
  now: Date = new Date(),
): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const next = new Date(y, m - 1, d + 1);
  return Math.max(1000, next.getTime() - now.getTime() + 1000);
}

/**
 * The calendar day, here, now.
 *
 * The ONE place this module reads a clock, and it is not called by anything above: every function
 * here takes the day as an argument so it can be tested at a boundary. This exists so the page has a
 * single spelling of "what day is it" rather than four.
 */
export function todayKey(now: Date = new Date()): DateKey {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Whether a string that came off a URL names a WINDOW.
 *
 * `custom` is excluded, and by the type rather than by a caller remembering to: it is the one entry
 * in the list that has no arithmetic of its own, so it is exactly the value `auditPresetRange`
 * refuses.
 */
export function isNamedPeriodPreset(
  value: string,
): value is Exclude<AuditPeriodPreset, "custom"> {
  return (
    value !== "custom" &&
    (AUDIT_PERIOD_PRESETS as readonly string[]).includes(value)
  );
}

/**
 * Which row the period control shows as selected. TWO PRESETS CAN NAME THE SAME WINDOW (on a Monday
 * `this-week` equals `today`, as does `this-month` on the 1st), and `custom` is a MODE whose every
 * window belongs to some preset, so deriving from the bounds alone would snap a pick back to "Today".
 * The mode travels beside the bounds, in the URL. IT IS A HINT: a named mode is honoured only while
 * its arithmetic still yields the bounds in hand, so `period=today` pasted tomorrow reads "Yesterday".
 */
export function selectedPreset(
  mode: string,
  from: string,
  to: string,
  today: DateKey,
): AuditPeriodPreset | "" {
  if (mode === "custom") return "custom";
  // NOTE: BOTH bounds empty, never either. A single bound is still a filter — "since the 1st" with no end
  // — and answering "" there shows the control as unfiltered while the page is filtered, which is
  // the one reading that cannot be recovered from. A half pair reaches `auditPresetOf`, which names
  // no preset and says custom, so the inputs open with the bound that exists.
  if (!from && !to) return "";
  if (isNamedPeriodPreset(mode)) {
    const range = auditPresetRange(mode, today);
    if (range.from === from && range.to === to) return mode;
  }
  return auditPresetOf(from, to, today);
}
