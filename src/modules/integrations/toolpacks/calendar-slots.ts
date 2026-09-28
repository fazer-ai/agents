import {
  fitsWithinWindows,
  localDateKey,
  type Schedule,
} from "@/modules/business-hours/hours";

// Pure appointment-slot generator: a time range + business hours + the calendar's busy intervals
// become the BOOKABLE start times, server-side, so the model never does date arithmetic.
//   1. step from the range start by `granularityMinutes`, each candidate `slotMinutes` long,
//      dropping any that overrun the range;
//   2. keep only candidates ENTIRELY inside a business-hours window (none configured: always on);
//   3. drop candidates overlapping a busy interval, and any already in the past.
// Returns every slot in chronological order (the caller bounds the range to <= 24h). `now` is
// injected, so it is testable with fixed instants (incl. DST).

export interface SlotInput {
  timeMin: string;
  timeMax: string;
  now: Date;
  // The service hours a slot must fit inside. Empty `windows` ⇒ no business-hours restriction
  // ("always on"); date exceptions ride along, so a holiday removes that day's slots. Its timezone is
  // the one the windows are expressed in AND the label is rendered in.
  schedule: Schedule;
  busy: { start: string; end: string }[];
  slotMinutes: number;
  granularityMinutes: number;
  minLeadMinutes: number;
}

export interface Slot {
  start: string;
  end: string;
  label: string;
}

// Backstop for a pathological range (e.g. a year at 5-minute grain): bound the candidates scanned.
const MAX_CANDIDATES = 5000;

export function computeAvailableSlots(input: SlotInput): Slot[] {
  const min = Date.parse(input.timeMin);
  const max = Date.parse(input.timeMax);
  if (Number.isNaN(min) || Number.isNaN(max) || max <= min) return [];
  const slotMs = input.slotMinutes * 60_000;
  const stepMs = input.granularityMinutes * 60_000;
  if (slotMs <= 0 || stepMs <= 0) return [];
  const lead = input.now.getTime() + Math.max(0, input.minLeadMinutes) * 60_000;
  // Align the first candidate UP to the granularity grid so slots land on clean wall-clock times
  // (09:00, 09:15…). Without this, stepping starts at `now`+lead and inherits its odd minute and
  // seconds — e.g. now 00:16:31.660 with a 15-min grain yields 09:01, 09:16, … :31.660Z. stepMs is a
  // whole number of minutes and real tz offsets are multiples of it, so aligning on the epoch grid
  // produces clean LOCAL times (and zeroes the sub-minute component).
  const startFrom = Math.ceil(Math.max(min, lead) / stepMs) * stepMs;
  const busy = input.busy
    .map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) }))
    .filter((b) => !Number.isNaN(b.s) && !Number.isNaN(b.e) && b.e > b.s);

  const out: Slot[] = [];
  let scanned = 0;
  for (let t = startFrom; t + slotMs <= max; t += stepMs) {
    if (++scanned > MAX_CANDIDATES) break;
    const slotStart = new Date(t);
    const slotEnd = new Date(t + slotMs);
    if (
      input.schedule.windows.length > 0 &&
      !fitsWithinWindows(input.schedule, slotStart, slotEnd)
    ) {
      continue;
    }
    const slotEndMs = t + slotMs;
    const overlapsBusy = busy.some((b) => t < b.e && slotEndMs > b.s);
    if (overlapsBusy) continue;
    out.push({
      start: slotStart.toISOString(),
      end: slotEnd.toISOString(),
      label: formatLabel(slotStart, input.schedule.timezone),
    });
  }

  return out;
}

// A human-friendly local label (e.g. "ter 24/06 09:00") to anchor the model's phrasing, rendered in
// the schedule's timezone. The ISO start/end remain the source of truth.
function formatLabel(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday").replace(/\.$/, "");
  return `${weekday} ${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

// One calendar as a SOURCE of availability: every busy window that applies to IT (its own bookings
// plus whichever operator blocking calendars apply to it), and how to name it back to the customer.
// `calendarLabel` is null when the operator never named it (the raw id is then the only handle the
// model has). The busy list arrives complete: which blocking calendar applies to which source is the
// caller's call, because a calendar can legitimately be an operable calendar for one query and a
// blocker for its siblings.
export interface CalendarSource {
  calendarId: string;
  calendarLabel: string | null;
  busy: { start: string; end: string }[];
}

export interface AggregatedSlot extends Slot {
  calendarId: string;
  calendarLabel?: string;
}

export interface AggregateInput extends Omit<SlotInput, "busy"> {
  sources: CalendarSource[];
  // Ceiling on the number of slot entries returned. See the truncation rule below.
  maxSlots: number;
}

export interface AggregateResult {
  slots: AggregatedSlot[];
  // The first start time the search did NOT cover, when the ceiling cut the list short. Absent when
  // the whole range fits. Feed it back as the next `timeMin` to continue.
  coveredUntil?: string;
}

// Availability across several calendars (one per professional: "who can see me first?"). Each is
// computed SEPARATELY and merged; pooling busy intervals would answer when EVERY professional is
// free. Chronological, ties in the operator's calendar order. The ceiling is on the total and drops
// WHOLE start times (a half-listed time would call a free professional busy), and where it stopped
// is REPORTED so the caller can continue. The first time is always kept, which is safe only because
// the caller bounds the source count (MAX_AGGREGATE_CALENDARS in google-calendar.ts).
export function computeAggregatedSlots(input: AggregateInput): AggregateResult {
  const { sources, maxSlots, ...slotInput } = input;
  const decorated: Array<{ order: number; at: number; slot: AggregatedSlot }> =
    [];
  sources.forEach((src, order) => {
    for (const s of computeAvailableSlots({ ...slotInput, busy: src.busy })) {
      decorated.push({
        order,
        at: Date.parse(s.start),
        slot: {
          ...s,
          calendarId: src.calendarId,
          ...(src.calendarLabel ? { calendarLabel: src.calendarLabel } : {}),
        },
      });
    }
  });
  decorated.sort((a, b) => a.at - b.at || a.order - b.order);

  const slots: AggregatedSlot[] = [];
  let i = 0;
  while (i < decorated.length) {
    const at = (decorated[i] as (typeof decorated)[number]).at;
    let j = i;
    while (j < decorated.length && decorated[j]?.at === at) j++;
    const group = decorated.slice(i, j);
    if (slots.length > 0 && slots.length + group.length > maxSlots) {
      return {
        slots,
        coveredUntil: (group[0] as (typeof decorated)[number]).slot.start,
      };
    }
    for (const d of group) slots.push(d.slot);
    i = j;
  }
  return { slots };
}

// The UTC offset of an instant in an IANA timezone, in ms (positive east of UTC). Lives here rather
// than at the call site because both the blocking-calendar reader and the booking rule below need
// "local midnight of a date", and two copies of zone math is one copy too many.
function tzOffsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - at;
}

// The UTC instant a LOCAL wall clock names in an IANA timezone, and whether that wall clock EXISTS.
// One refinement pass is DST-correct except in the hour a spring-forward skips, where `ms` is the
// instant the shift landed on. Reported rather than decided here: a day boundary takes that
// instant, while an appointment at a time that does not exist must be refused.
export function zonedWallClock(
  local: string,
  tz: string,
): { ms: number; exists: boolean } {
  const utcGuess = Date.parse(`${local}Z`);
  if (Number.isNaN(utcGuess)) return { ms: Number.NaN, exists: false };
  const first = utcGuess - tzOffsetMs(utcGuess, tz);
  const ms = utcGuess - tzOffsetMs(first, tz);
  // Round trip: read `ms` back as a wall clock. A skipped hour comes back as a different one.
  return { ms, exists: ms + tzOffsetMs(ms, tz) === utcGuess };
}

// The UTC instant of local midnight for a YYYY-MM-DD in an IANA timezone.
export function zonedMidnightMs(date: string, tz: string): number {
  return zonedWallClock(`${date}T00:00:00`, tz).ms;
}

// How many bookable times a refusal offers back. Enough for the model to propose a real choice,
// small enough that the refusal stays a sentence and not a listing.
const MAX_ALTERNATIVES = 6;

export interface BookingInput extends Omit<SlotInput, "timeMin" | "timeMax"> {
  // The requested appointment as INSTANTS, already resolved by the caller. Not the strings it
  // received: an offset-less `dateTime` is a wall clock in the calendar's timezone, and re-parsing
  // it here would read it in the server's instead — which is exactly the divergence the caller
  // resolved it to avoid. One parse, at the boundary.
  startMs: number;
  endMs: number;
}

export interface BookingVerdict {
  bookable: boolean;
  // Bookable times in the same local day, nearest to the request first. Empty when the day is full
  // or closed; that is a real answer, not a failure.
  alternatives: Slot[];
}

// The local day containing an instant, as the range the availability read has to cover. The END is
// widened by one SLOT, so a booking that runs past local midnight is still judged whole instead of
// being cut by the window that was supposed to hold it. The start needs no such guard: local
// midnight of the day holding an instant is never after it.
//
// One slot, not the requested span: the span is a model argument and nothing bounds it, so widening
// by it would let a `end` years after `start` turn a one-day freeBusy query into a decades-long one
// before anything had a chance to refuse it. A request longer than a slot is not a slot either way.
export function bookingWindow(
  startMs: number,
  slotMs: number,
  timezone: string,
): { timeMin: string; timeMax: string } {
  const dayStart = zonedMidnightMs(
    localDateKey(new Date(startMs), timezone),
    timezone,
  );
  // 36h from local midnight lands inside the next local day whether it is 23, 24 or 25 hours long.
  const dayEnd = zonedMidnightMs(
    localDateKey(new Date(dayStart + 36 * 3_600_000), timezone),
    timezone,
  );
  return {
    timeMin: new Date(dayStart).toISOString(),
    timeMax: new Date(Math.max(dayEnd, startMs + slotMs)).toISOString(),
  };
}

// The rule the write path enforces: an appointment may only be written on a (start, end) pair that
// `calendar_check_availability` would have returned for that day. Expressed as membership in the
// generated list, never a second copy of the conditions, so the two paths cannot drift; the same
// list is the refusal's content, so the agent can offer times that work.
export function judgeBooking(input: BookingInput): BookingVerdict {
  const { startMs, endMs, ...slotInput } = input;
  const window = bookingWindow(
    startMs,
    input.slotMinutes * 60_000,
    input.schedule.timezone,
  );
  const offered = computeAvailableSlots({ ...slotInput, ...window });
  const bookable = offered.some(
    (s) => Date.parse(s.start) === startMs && Date.parse(s.end) === endMs,
  );
  if (bookable) return { bookable: true, alternatives: [] };
  const alternatives = offered
    .map((s) => ({ s, d: Math.abs(Date.parse(s.start) - startMs) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_ALTERNATIVES)
    .map((x) => x.s)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { bookable: false, alternatives };
}

// Removes one interval from a busy list, splitting any interval that strictly contains it. For the
// reschedule: the appointment being moved is itself busy, and freeBusy MERGES adjacent blocks, so
// an equality test would leave a fused block standing. Apply it to the calendar's OWN bookings
// only, or it punches a hole through an operator closure. freeBusy carries no event identity, so an
// event that genuinely overlaps the moved one loses coverage over the overlap; reading events
// instead would put other customers' appointments in reach.
export function subtractWindow(
  busy: { start: string; end: string }[],
  cut: { start: string; end: string } | null,
): { start: string; end: string }[] {
  if (!cut) return busy;
  const cs = Date.parse(cut.start);
  const ce = Date.parse(cut.end);
  if (Number.isNaN(cs) || Number.isNaN(ce) || ce <= cs) return busy;
  const out: { start: string; end: string }[] = [];
  for (const b of busy) {
    const bs = Date.parse(b.start);
    const be = Date.parse(b.end);
    if (Number.isNaN(bs) || Number.isNaN(be) || be <= bs) continue;
    if (ce <= bs || cs >= be) {
      out.push(b);
      continue;
    }
    if (bs < cs) out.push({ start: b.start, end: new Date(cs).toISOString() });
    if (ce < be) out.push({ start: new Date(ce).toISOString(), end: b.end });
  }
  return out;
}
