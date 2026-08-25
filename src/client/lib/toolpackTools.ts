import type { TFunction } from "i18next";
import {
  CalendarCheck,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CalendarX2,
  FileSearch,
  Link,
  type LucideIcon,
  QrCode,
  Receipt,
  Send,
  Wrench,
} from "lucide-react";

// Display metadata for toolpack (integration) tools: icon + friendly label + one-line description,
// keyed by the internal tool name. Mirrors nativeTools.ts (the mold). The INTERNAL name is never
// shown prominently in the UI; this projection is what the integration modal and the agent's Tools
// tab render. Args (with descriptions) come from the backend (zod-derived) alongside each tool.

export const TOOLPACK_TOOL_ICONS: Record<string, LucideIcon> = {
  asaas_payment_link_create: Link,
  asaas_create_pix_charge: QrCode,
  asaas_payment_status: Receipt,
  calendar_list_events: CalendarDays,
  calendar_check_availability: CalendarClock,
  calendar_create_event: CalendarPlus,
  calendar_update_event: CalendarCheck,
  calendar_cancel_event: CalendarX2,
  calendar_confirm_appointment: CalendarCheck2,
  drive_find_file: FileSearch,
  drive_send_file: Send,
};

// An operator-only note about one ARGUMENT, shown on that argument's pill in the console.
//
// It lives here rather than in the tool's zod `.describe()` because the two audiences want opposite
// things from that field: the model reads it on EVERY turn the tool is bound, and the operator reads
// it once, in a list the console builds from the STATIC schema. `calendarId` is the case that made
// the difference concrete (issue #118): `calendarArgSchema` removes the argument whenever the
// integration has exactly one calendar, so the only context in which a model can read "this arg only
// appears when there are several" is the one where it is already true — tokens spent every turn to
// state a condition guaranteed by the fact that it can be read at all. The console shows the
// argument regardless (it is keyed by catalogType, not by instance), so without this note an
// operator has no way to know why their agent never receives an argument they can see documented.
export function toolpackArgNote(
  toolName: string,
  argName: string,
  t: TFunction,
): string | null {
  if (argName === "calendarId" && toolName.startsWith("calendar_")) {
    return t(
      "toolpackTools.argNote.calendarId",
      "The agent only receives this argument when the integration allows several calendars; with a single one it is used automatically.",
    );
  }
  // Same shape as calendarId: `slotDurationArgSchema` removes the argument whenever the appointment
  // length is fixed, so the note is the only place the operator learns that "Let the AI choose" is
  // what puts it back.
  if (
    argName === "slotDurationMinutes" &&
    toolName === "calendar_check_availability"
  ) {
    return t(
      "toolpackTools.argNote.slotDurationMinutes",
      'The agent only receives this argument when the appointment length is set to "Let the AI choose"; a fixed length always applies and cannot be changed per conversation.',
    );
  }
  return null;
}

// The backend's arg list (zod-derived) with the operator notes above folded into the description the
// pill shows on hover. Every place that renders toolpack args goes through this, so a note is never
// half-applied.
export function withToolpackArgNotes<
  A extends { name: string; description?: string | null },
>(toolName: string, args: A[], t: TFunction): A[] {
  return args.map((a) => {
    const note = toolpackArgNote(toolName, a.name, t);
    if (!note) return a;
    return {
      ...a,
      description: a.description ? `${a.description} ${note}` : note,
    };
  });
}

export interface ToolpackToolMeta {
  label: string;
  description: string;
  icon: LucideIcon;
}

// Static t() calls (one per tool) so the i18n extractor + the no-dynamic-i18n-key lint are happy.
export function toolpackToolMeta(name: string, t: TFunction): ToolpackToolMeta {
  const icon = TOOLPACK_TOOL_ICONS[name] ?? Wrench;
  switch (name) {
    case "asaas_payment_link_create":
      return {
        icon,
        label: t(
          "toolpackTools.asaas_payment_link_create.label",
          "Payment link",
        ),
        description: t(
          "toolpackTools.asaas_payment_link_create.desc",
          "Create an Asaas payment link to send to the customer.",
        ),
      };
    case "asaas_create_pix_charge":
      return {
        icon,
        label: t("toolpackTools.asaas_create_pix_charge.label", "PIX charge"),
        description: t(
          "toolpackTools.asaas_create_pix_charge.desc",
          "Open a PIX charge and return the copy-and-paste code plus the payment page.",
        ),
      };
    case "asaas_payment_status":
      return {
        icon,
        label: t("toolpackTools.asaas_payment_status.label", "Check payment"),
        description: t(
          "toolpackTools.asaas_payment_status.desc",
          "Check the status of an Asaas charge (PIX) or payment link.",
        ),
      };
    case "calendar_list_events":
      return {
        icon,
        label: t(
          "toolpackTools.calendar_list_events.label",
          "Customer appointments",
        ),
        description: t(
          "toolpackTools.calendar_list_events.desc",
          "List this customer's own appointments within a time range (each customer only sees their own; holidays and closures never appear here).",
        ),
      };
    case "calendar_check_availability":
      return {
        icon,
        label: t(
          "toolpackTools.calendar_check_availability.label",
          "Available times",
        ),
        description: t(
          "toolpackTools.calendar_check_availability.desc",
          "List bookable appointment times within a range, honoring the service hours, existing bookings and any blocking calendars (holidays, closures).",
        ),
      };
    case "calendar_create_event":
      return {
        icon,
        label: t("toolpackTools.calendar_create_event.label", "Create event"),
        description: t(
          "toolpackTools.calendar_create_event.desc",
          "Create an event on the connected Google Calendar.",
        ),
      };
    case "calendar_update_event":
      return {
        icon,
        label: t("toolpackTools.calendar_update_event.label", "Update event"),
        description: t(
          "toolpackTools.calendar_update_event.desc",
          "Update an existing Google Calendar event.",
        ),
      };
    case "calendar_cancel_event":
      return {
        icon,
        label: t("toolpackTools.calendar_cancel_event.label", "Cancel event"),
        description: t(
          "toolpackTools.calendar_cancel_event.desc",
          "Cancel this customer's appointment on the Google Calendar.",
        ),
      };
    case "calendar_confirm_appointment":
      return {
        icon,
        label: t(
          "toolpackTools.calendar_confirm_appointment.label",
          "Confirm appointment",
        ),
        description: t(
          "toolpackTools.calendar_confirm_appointment.desc",
          "Mark this customer's appointment as confirmed after they confirm attendance.",
        ),
      };
    case "drive_find_file":
      return {
        icon,
        label: t("toolpackTools.drive_find_file.label", "Find file"),
        description: t(
          "toolpackTools.drive_find_file.desc",
          "Search Google Drive for files by name.",
        ),
      };
    case "drive_send_file":
      return {
        icon,
        label: t("toolpackTools.drive_send_file.label", "Send file"),
        description: t(
          "toolpackTools.drive_send_file.desc",
          "Send a Drive file to the customer as an attachment.",
        ),
      };
    default:
      return { icon, label: name, description: "" };
  }
}
