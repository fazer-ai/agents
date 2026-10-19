import { REMINDER_OFFSET_RANGE } from "@/modules/integrations/calendar-config-ranges";

// Per-agent appointment-reminder configuration from agent.settings.appointmentReminders.
// Same reader/default/clamp pattern as debounce/serviceWindow/followUp.
//
// When the agent books an appointment (calendar_create_event), it DETERMINISTICALLY schedules a
// reminder nudge at each configured offset BEFORE the appointment start (e.g. [24, 1] ⇒ 24h and 1h
// before). The last (closest) reminder may also ask the customer to CONFIRM attendance — the agent
// then marks the event with calendar_confirm_appointment. No polling: reminders are scheduler jobs
// enqueued at booking time and cancelled / re-armed when the appointment is cancelled / rescheduled.

export interface AppointmentReminderConfig {
  enabled: boolean;
  // Hours BEFORE the appointment start to send a reminder, sorted DESCENDING (e.g. [24, 1] = 24h then
  // 1h before). Always 1..MAX_OFFSETS entries after a read.
  offsetsHours: number[];
  // On the LAST (closest) reminder, ask the customer to confirm attendance.
  askConfirmationOnLast: boolean;
}

export const APPOINTMENT_REMINDER_MAX_OFFSETS = 5;
const OFFSET_MIN_HOURS = REMINDER_OFFSET_RANGE.min;
const OFFSET_MAX_HOURS = REMINDER_OFFSET_RANGE.max;

export const APPOINTMENT_REMINDER_DEFAULTS: AppointmentReminderConfig = {
  enabled: false,
  offsetsHours: [24, 1],
  askConfirmationOnLast: true,
};

function cloneDefaults(): AppointmentReminderConfig {
  return {
    enabled: false,
    offsetsHours: [...APPOINTMENT_REMINDER_DEFAULTS.offsetsHours],
    askConfirmationOnLast: true,
  };
}

// Clamp + sanitize an offsets array: keep finite numbers in [1, 8760], round, de-dup, sort DESCENDING
// (reminders fire far→near, so the SMALLEST offset is the "last" one), cap the count.
export function normalizeOffsets(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of arr) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const h = Math.min(
      Math.max(Math.round(v), OFFSET_MIN_HOURS),
      OFFSET_MAX_HOURS,
    );
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  out.sort((a, b) => b - a);
  return out.slice(0, APPOINTMENT_REMINDER_MAX_OFFSETS);
}

export function readAppointmentReminderConfig(
  settings: unknown,
): AppointmentReminderConfig {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).appointmentReminders
      : undefined;
  if (!raw || typeof raw !== "object") return cloneDefaults();
  const bag = raw as Record<string, unknown>;
  const offsets = normalizeOffsets(bag.offsetsHours);
  return {
    enabled: typeof bag.enabled === "boolean" ? bag.enabled : false,
    // An enabled config with no valid offsets falls back to the defaults so reminders still fire.
    offsetsHours:
      offsets.length > 0
        ? offsets
        : [...APPOINTMENT_REMINDER_DEFAULTS.offsetsHours],
    askConfirmationOnLast:
      typeof bag.askConfirmationOnLast === "boolean"
        ? bag.askConfirmationOnLast
        : true,
  };
}
