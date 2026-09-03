// The windows the audit page's period control offers, and the arithmetic behind them.
//
// EVERYTHING HERE IS PURE, and `today` is an ARGUMENT rather than a clock read inside. That is what
// makes the presets testable at all: the suite runs at UTC (measured, see `localMidnight` in
// AuditPage), where a version that resolved "yesterday" against the wrong zone passes every test.
// The page reads the clock once, in one place, and hands the day down.
//
// A DATE KEY IS `YYYY-MM-DD` IN THE OPERATOR'S OWN CALENDAR, which is the same shape
// `<input type="date">` emits and `localDayBounds` turns into instants. The arithmetic below runs in
// UTC on that string — never by constructing a local `Date` and adding days — because a local
// construction crosses a DST boundary by an hour and lands on the wrong day twice a year.
//
// The preset list is a LOG's, not a dashboard's. `~/dev/bi` offers trailing months because it reads
// trends; a trail is read to answer "what happened today" and "what changed last month", so the
// calendar family is the long one here and the only trailing window is the 30 days everyone asks for.

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
 * Whether a `from`/`to` pair is a window worth committing.
 *
 * PURE, AND SEPARATE FROM THE CONTROL, because the rule it encodes is the one that is easy to get
 * wrong in place. `<input type="date">` reports "" while a date is being typed or cleared, so a
 * control that refuses to hold anything unusable snaps back and keyboard entry cannot progress. The
 * answer is a draft that holds anything and commits only a usable PAIR — and the pair is checked
 * together, never one field at a time: applied per field, moving a window forward is refused in both
 * orders (changing `from` first inverts it, changing `to` first inverts it too), so some windows
 * cannot be reached at all.
 */
export function isUsableRange(from: string, to: string): boolean {
  if (!DATE_KEY_RE.test(from) || !DATE_KEY_RE.test(to)) return false;
  // NOTE: String comparison is date comparison for this shape, which is the reason the shape is fixed.
  return from <= to;
}

/**
 * Whether a draft window is ready to be applied, GIVEN the one already applied.
 *
 * The pair rule and the one-sided rule are both here because neither is right on its own, and which
 * applies is decided by the committed window rather than by the draft.
 *
 * A `<input type="date">` reports "" while a date is being typed or cleared. So while a PAIR is
 * applied, only a usable pair commits: anything looser fires a request off a half-erased window in
 * the middle of an edit, and validating field by field makes some windows unreachable outright (to
 * move a long window forward, changing `from` first inverts the pair and changing `to` first inverts
 * it too, so both edits are refused).
 *
 * But a ONE-SIDED window — "since the 1st", with no end — is a filter this page recognises and a URL
 * can carry, and there the pair rule refuses every edit forever: the missing opposite bound makes
 * every candidate unusable, so the input showed the new date while the query kept the old one, with
 * no way out. When the applied window is not a pair, a single valid bound commits, and emptying the
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
 * How long until the local calendar day changes.
 *
 * A CONSOLE PAGE IS LEFT OPEN, and nothing on this one re-renders by itself: filtered to Today and
 * abandoned overnight, it goes on saying "Today" while its fixed bounds query yesterday. Every piece
 * of the correction already exists — the day is read per render, and `selectedPreset` drops a named
 * mode the moment its arithmetic stops yielding the bounds in hand — so what is missing is only a
 * render, and one timer is the whole of it.
 *
 * It takes THE DAY THE PAGE IS SHOWING rather than reading one, so the timer aims at the end of that
 * day and not at the end of whatever day the clock happens to be on — which is also what makes the
 * day a real dependency of the effect that arms it, instead of a re-arm trigger the linter is right
 * to call redundant. Built from LOCAL components, like everything else answering "what day is it"
 * here, so the boundary is the operator's midnight and not UTC's. The second of slack lands the
 * timer after the boundary rather than exactly on it, where a clock a millisecond behind reads the
 * old day and re-arms for nothing; the floor keeps a day already past from arming a zero.
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
 * Which row the period control shows as selected.
 *
 * TWO PRESETS CAN NAME THE SAME WINDOW, so the bounds alone do not answer this. On a Monday
 * `this-week` is the same two dates as `today`; so is `this-month` on the 1st, and `this-year` on
 * January 1. Deriving the selection therefore snapped "This week" back to "Today" the instant it was
 * picked. And `custom` is not a window at all, it is a MODE — "I am choosing the bounds myself" —
 * whose every possible window belongs to some preset: measured, the first version of the control
 * derived the selection, so picking Custom wrote a window, the next render read that window back as
 * "Today", and the two date inputs never appeared.
 *
 * So the mode travels beside the bounds, in the URL, and a link carries the choice that was actually
 * made. IT IS A HINT AND NOT AN ANSWER: a named mode is honoured only while its own arithmetic still
 * produces the bounds in hand, and that is what keeps it from going stale — `period=today` pasted
 * tomorrow no longer resolves to those dates, falls through to the derivation, and reads
 * "Yesterday", which is what the dates say.
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
