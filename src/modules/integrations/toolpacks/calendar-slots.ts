import {
  fitsWithinWindows,
  type WindowSpec,
} from "@/modules/business-hours/hours";

// Pure appointment-slot generator (n8n secretária v3 parity). Turns a time range + the professional's
// business hours + the calendar's busy intervals into a list of BOOKABLE start times, server-side and
// deterministic — the model never does the date arithmetic (which it does badly). The v3 recipe:
//   1. step from the range start by `granularityMinutes` (the overlap grain: 15min ⇒ 09:00 and 09:15
//      are both valid starts), each candidate `slotMinutes` long, dropping any that overrun the range;
//   2. keep only candidates that fit ENTIRELY inside a business-hours window (same day, no midnight
//      crossing) — when no windows are configured the schedule is "always on" and this is skipped;
//   3. drop candidates overlapping any busy interval (freeBusy), and any already in the past.
// Returns EVERY bookable slot in the range, in chronological order (no sampling) — the caller bounds the
// range to <= 24h so the list stays small. No I/O, no Date.now() — `now` is injected, so it is
// unit-testable with fixed instants (incl. DST).

export interface SlotInput {
  timeMin: string;
  timeMax: string;
  now: Date;
  // Empty ⇒ no business-hours restriction ("always on"); otherwise the slot must fit inside a window.
  scheduleWindows: WindowSpec[];
  // Timezone the windows are expressed in AND the label is rendered in.
  scheduleTz: string;
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
      input.scheduleWindows.length > 0 &&
      !fitsWithinWindows(
        input.scheduleWindows,
        input.scheduleTz,
        slotStart,
        slotEnd,
      )
    ) {
      continue;
    }
    const slotEndMs = t + slotMs;
    const overlapsBusy = busy.some((b) => t < b.e && slotEndMs > b.s);
    if (overlapsBusy) continue;
    out.push({
      start: slotStart.toISOString(),
      end: slotEnd.toISOString(),
      label: formatLabel(slotStart, input.scheduleTz),
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
}

// Availability across several calendars at once (issue #100): a clinic with one calendar per
// professional, asked "who can see me first?".
//
// Each calendar is computed SEPARATELY and the results are merged. Pooling the busy intervals into a
// single computeAvailableSlots call would answer a different question, when EVERY professional is
// free simultaneously, which is the intersection and is what you want for a meeting room, not for
// interchangeable providers. That distinction is the whole point of the issue, so it is pinned by a
// decision table rather than left to the reader.
//
// Ordering is chronological because the question is "first available"; ties (two professionals free
// at 09:00) keep the operator's configured calendar order, so the same query answers the same way
// twice and the operator can predict who gets offered first.
//
// NOTE: no bound on the result. An earlier revision kept each calendar's first N starts to hold the
// response down, which quietly turned "all bookable slots" into "the first couple of hours": at the
// default 15-minute grain, eight starts is under two hours, so an afternoon request came back as
// unavailable while the afternoon was in fact free. The range is already bounded to 24h and by
// business hours, and any bound that survives has to preserve the whole range, not its head.
export function computeAggregatedSlots(
  input: AggregateInput,
): AggregatedSlot[] {
  const { sources, ...slotInput } = input;
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
  return decorated.map((d) => d.slot);
}
