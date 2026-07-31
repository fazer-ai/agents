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
          "Check the status of an Asaas payment link.",
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
