import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { GOOGLE_CALENDAR_PROVIDER } from "@/modules/appointments/provider";
import {
  appointmentBooked,
  cancelAppointment,
} from "@/modules/appointments/reminders";
import type { SideEffectErrorReporter } from "@/modules/integrations/toolpacks/types";

// The two closures a TOOL calls to tell the platform that a booking now stands, or no longer does.
// Bound to one tenant and one conversation, handed to the Calendar toolpack and to any HTTP tool
// whose definition declares an appointment (issue #352).
//
// They exist as a unit for one reason: they are the boundary where a failure stops being an
// exception and becomes a LINE SOMEONE READS. The tool they were called from has already succeeded
// for the model — the booking is real, made in a system this platform does not own — so nothing here
// may throw back into the turn and nothing may change what the model was told. What is left to get
// right is the report, and the report has to name the right things:
//
//   - the TOOL, because the operator's fix lives in whatever definition made the call. Defaulting
//     every report to `google_calendar` (the toolpack FAMILY name, which is all the Calendar
//     toolpack can offer) pointed the operator of a broken HTTP declaration at an integration they
//     may not even have configured.
//   - the PHASE, because "the record was not written" and "the start was unreadable" have different
//     fixes and the Logs page and the alert channels key on it.
//
// The consequence of a swallowed failure, in both directions: the appointment exists and the
// platform does not know it, so the follow-up pause is off, the reminders never fire, the console
// indicator is blank and the agent's own prompt is missing the booking the customer is asking about.

export interface AppointmentBookedNotice {
  eventId: string;
  // WHO owns the booking, and WHICH tool is reporting it. Both absent means the Calendar toolpack,
  // which was the only caller before a tool definition could declare an appointment of its own.
  provider?: string;
  tool?: string;
  calendarId?: string | null;
  startISO: string;
  credentialRef: string | null;
  reminders: { offsetsHours: number[]; askConfirmationOnLast: boolean } | null;
  summary: string | null;
  calendarLabel: string | null;
}

export interface AppointmentSideEffectDeps {
  tenantId: bigint;
  // The per-conversation thread (`tenant:instance:convId`, the one runAgentNudge parses), never the
  // per-contact-inbox memory thread.
  threadId: string;
  base?: PrismaClient;
  // Absent (playground, tests) ⇒ the failure stays a stdout log.
  report?: SideEffectErrorReporter;
  // Injectable for the same reason the reminder enqueue is: a test of what the REPORT says when the
  // write fails cannot make a real write fail without a broken database.
  book?: typeof appointmentBooked;
  cancel?: typeof cancelAppointment;
}

export interface AppointmentSideEffects {
  booked: (a: AppointmentBookedNotice) => Promise<void>;
  cancel: (
    eventId: string,
    opts?: { provider?: string; tool?: string },
  ) => Promise<void>;
}

// The tool a report is filed against. `google_calendar` is the toolpack family name and the
// historical default; anything that can name itself does.
function reporter(tool: string | undefined): string {
  return tool ?? "google_calendar";
}

export function appointmentSideEffects(
  deps: AppointmentSideEffectDeps,
): AppointmentSideEffects {
  const book = deps.book ?? appointmentBooked;
  const drop = deps.cancel ?? cancelAppointment;
  return {
    async booked(a) {
      const tool = reporter(a.tool);
      try {
        const res = await book({
          tenantId: deps.tenantId,
          threadId: deps.threadId,
          provider: a.provider,
          eventId: a.eventId,
          startISO: a.startISO,
          summary: a.summary,
          calendarId: a.calendarId,
          calendarLabel: a.calendarLabel,
          credentialRef: a.credentialRef,
          reminders: a.reminders,
          base: deps.base,
        });
        // NOTE: The booking exists in the owning system and the platform cannot judge its start, so
        // it holds no record at all. Reported rather than thrown: the appointment is real and
        // already made, and the operator's fix is the start PATH, not the booking.
        if (res.record === "unreadable-start") {
          logger.warn(
            "appointment recorded with an unreadable start (event=%s start=%s)",
            a.eventId,
            a.startISO,
          );
          deps.report?.({
            tool,
            phase: "appointment_record",
            detail: { eventId: a.eventId },
            err: new Error(`unreadable appointment start: ${a.startISO}`),
          });
        }
      } catch (e) {
        logger.warn(
          "appointment booked handling failed: %s",
          e instanceof Error ? e.message : String(e),
        );
        deps.report?.({
          tool,
          phase: "appointment_booked",
          detail: { eventId: a.eventId },
          err: e,
        });
      }
    },
    async cancel(eventId, opts) {
      try {
        await drop(
          deps.tenantId,
          eventId,
          deps.base,
          opts?.provider ?? GOOGLE_CALENDAR_PROVIDER,
        );
      } catch (e) {
        logger.warn(
          "appointment cancel failed: %s",
          e instanceof Error ? e.message : String(e),
        );
        deps.report?.({
          tool: reporter(opts?.tool),
          phase: "appointment_cancel",
          detail: { eventId },
          err: e,
        });
      }
    },
  };
}
