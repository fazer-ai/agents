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
// whose definition declares an appointment. This is where a failure becomes a REPORT: the tool call
// already succeeded for the model, so nothing here throws back into the turn. The report names the
// TOOL (the operator's fix lives in the definition that made the call) and the PHASE (record not
// written and start unreadable have different fixes, and the Logs page and alerts key on it).

export interface AppointmentBookedNotice {
  eventId: string;
  // WHO owns the booking, and WHICH tool is reporting it. Both absent means the Calendar toolpack.
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
  // Absent (playground, tests): the failure stays a stdout log.
  report?: SideEffectErrorReporter;
  // Injectable so a test can make the write fail and check what the REPORT says.
  book?: typeof appointmentBooked;
  cancel?: typeof cancelAppointment;
  // WHETHER A BOOKING MADE ON THIS TURN MAY TOUCH CUSTOMER REMINDERS. Default true (every reactive
  // turn). False for an OBSERVATION: a reminder is a later job with its own client, so the turn's
  // mute never reaches it. The record is kept; reminders are left alone, neither armed nor cancelled.
  armReminders?: boolean;
}

export interface AppointmentSideEffects {
  booked: (a: AppointmentBookedNotice) => Promise<void>;
  cancel: (
    eventId: string,
    opts?: { provider?: string; tool?: string },
  ) => Promise<void>;
}

// The tool a report is filed against. `google_calendar` is the toolpack family name and the
// default; anything that can name itself does.
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
          // NOTE: NOT `reminders: null`, which means "the policy was switched off, retire what is
          // armed" and would have an observation cancelling the responder's reminders.
          ...(deps.armReminders === false ? { recordOnly: true } : {}),
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
