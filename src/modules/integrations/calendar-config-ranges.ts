import { inRange, intRange, type NumberRange } from "@/lib/number-range";

// The Google Calendar config numbers, declared once for the toolpack's readers, the write check in
// assertIntegrationWritable and the console's fields. The config is a free-form record,
// so no schema walk sees these: the write check below is what refuses them. Browser-safe.
export const CALENDAR_CONFIG_RANGES = {
  // Null (or absent) is "let the AI choose", not a length.
  slotDurationMinutes: intRange(5, 480),
  slotGranularityMinutes: intRange(5, 240),
  minLeadMinutes: intRange(0, 100_000),
} as const satisfies Record<string, NumberRange>;

// Hours before the appointment start; a year at most.
export const REMINDER_OFFSET_RANGE = intRange(1, 8760);

export interface ConfigRangeProblem {
  path: string;
  range: NumberRange;
  got: unknown;
}

const isNumberLike = (v: unknown) => v !== null && v !== undefined;

// The first number the write INTRODUCES or CHANGES outside its range, or null. A value equal to the
// stored one passes, so a config saved before the refusal existed still saves when re-sent intact.
export function calendarConfigRangeProblem(
  config: Record<string, unknown>,
  stored: Record<string, unknown> = {},
): ConfigRangeProblem | null {
  for (const [key, range] of Object.entries(CALENDAR_CONFIG_RANGES)) {
    const got = config[key];
    if (!isNumberLike(got) || Object.is(got, stored[key])) continue;
    if (typeof got !== "number" || !inRange(got, range))
      return { path: `config.${key}`, range, got };
  }
  const reminders = config.appointmentReminders;
  const offsets =
    reminders && typeof reminders === "object"
      ? (reminders as Record<string, unknown>).offsetsHours
      : undefined;
  if (Array.isArray(offsets)) {
    const storedReminders = stored.appointmentReminders;
    const storedOffsets =
      storedReminders && typeof storedReminders === "object"
        ? (storedReminders as Record<string, unknown>).offsetsHours
        : undefined;
    const before = new Set(Array.isArray(storedOffsets) ? storedOffsets : []);
    for (const [i, got] of offsets.entries()) {
      if (before.has(got)) continue;
      if (typeof got !== "number" || !inRange(got, REMINDER_OFFSET_RANGE))
        return {
          path: `config.appointmentReminders.offsetsHours[${i}]`,
          range: REMINDER_OFFSET_RANGE,
          got,
        };
    }
  }
  return null;
}
