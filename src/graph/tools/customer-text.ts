import { HANDOFF_TOOL_NAME, OPEN_CASE_TOOL_NAME } from "./catalog";
import { customerLine } from "./customer-line";

// Where the model's text in a tool's argument goes:
//   `transfer`: the customer reads it, only when a transfer to a person happens with it;
//   `case`: the customer reads it as the opening message of a case in another inbox;
//   `customer`: the customer reads it by another channel (a caption, an email, a charge);
//   `internal`: nobody outside the team reads it (an id, a note, a label, a search).
export type ArgAudience = "transfer" | "case" | "customer" | "internal";

// Every argument of every tool the product builds. The turn review's rules read the `transfer`
// and `case` ones before the call runs, and in this version not the `customer` ones, listed so
// the inventory is whole (docs/turn-review.md, "What the rules read"). A tool or an argument
// missing here fails `tests/graph/customer-text-registry.test.ts`.
export const TOOL_ARG_AUDIENCE: Record<string, Record<string, ArgAudience>> = {
  [HANDOFF_TOOL_NAME]: {
    reason: "internal",
    assignTo: "internal",
    customerMessage: "transfer",
  },
  [OPEN_CASE_TOOL_NAME]: {
    reason: "internal",
    email: "internal",
    labels: "internal",
    // Rendered into the case's subject, which an email destination sends as the mail's subject.
    summary: "customer",
    // Sent to the customer in the destination inbox when the case opens.
    customer_message: "case",
    // Sent here when the case could not open and the conversation goes to a person.
    handoff_message: "transfer",
  },
  send_image: { url: "internal", caption: "customer" },
  private_note: { content: "internal" },
  set_custom_attribute: {
    key: "internal",
    value: "internal",
    scope: "internal",
    clear: "internal",
  },
  set_labels: { add: "internal", remove: "internal", scope: "internal" },
  resolve_conversation: {},
  kanban_move_card: { targetStep: "internal" },
  update_kanban_task: {
    title: "internal",
    description: "internal",
    priority: "internal",
    dueDate: "internal",
    startDate: "internal",
  },
  set_voice_preference: { preference: "internal" },
  // Posted on the customer's own message.
  react_to_message: { emoji: "customer" },
  skip_reply: { reason: "internal", detail: "internal" },
  calculator: { expression: "internal" },
  get_current_time: { roundToMinutes: "internal" },
  update_contact: {
    name: "internal",
    email: "internal",
    company_name: "internal",
    city: "internal",
    country: "internal",
    description: "internal",
  },
  // Asaas: the name and the description are printed on the charge the customer pays.
  asaas_payment_link_create: {
    value: "internal",
    description: "customer",
    name: "customer",
  },
  asaas_create_pix_charge: {
    value: "internal",
    customerName: "internal",
    cpfCnpj: "internal",
    mobilePhone: "internal",
    description: "customer",
    dueDate: "internal",
  },
  asaas_payment_status: { paymentId: "internal", paymentLinkId: "internal" },
  // Google Calendar: the customer is invited to the event, and reads its title and details.
  calendar_list_events: {
    timeMin: "internal",
    timeMax: "internal",
    maxResults: "internal",
  },
  calendar_check_availability: {
    timeMin: "internal",
    timeMax: "internal",
    slotDurationMinutes: "internal",
  },
  calendar_create_event: {
    summary: "customer",
    start: "internal",
    end: "internal",
    description: "customer",
  },
  calendar_update_event: {
    eventId: "internal",
    summary: "customer",
    start: "internal",
    end: "internal",
    description: "customer",
  },
  calendar_cancel_event: { eventId: "internal" },
  calendar_confirm_appointment: { eventId: "internal" },
  drive_find_file: { query: "internal", maxResults: "internal" },
  drive_send_file: { fileId: "internal", caption: "customer" },
  sheets_append_row: { values: "internal" },
  sheets_find_rows: {
    column: "internal",
    value: "internal",
    match: "internal",
    limit: "internal",
    offset: "internal",
  },
  sheets_update_row: {
    column: "internal",
    value: "internal",
    row: "internal",
    values: "internal",
  },
  resend_send_email: { to: "internal", subject: "customer", html: "customer" },
  resend_email_status: { emailId: "internal" },
};

export interface CustomerText {
  field: string;
  text: string;
  // Delivered only with a transfer to a person, which is what a rule on `handoff_to_human` asks.
  transfer: boolean;
}

// What a call would have the customer read in the arguments the rules read (`transfer`, `case`),
// argument by argument, as the handler delivers it: `customerLine` trims it and reads a
// placeholder such as "N/A" as nothing.
export function customerTextOf(call: {
  name: string;
  args: unknown;
}): CustomerText[] {
  const args =
    call.args && typeof call.args === "object"
      ? (call.args as Record<string, unknown>)
      : {};
  const out: CustomerText[] = [];
  for (const [field, who] of Object.entries(
    TOOL_ARG_AUDIENCE[call.name] ?? {},
  )) {
    if (who !== "transfer" && who !== "case") continue;
    const said = args[field];
    const text = typeof said === "string" ? customerLine(said) : "";
    if (text) out.push({ field, text, transfer: who === "transfer" });
  }
  return out;
}

// How the rules read the tool's arguments, if they read any: with a transfer, or as a case's
// opening message.
export function ruleReadAudiences(name: string): ("transfer" | "case")[] {
  return Object.values(TOOL_ARG_AUDIENCE[name] ?? {}).filter(
    (w) => w === "transfer" || w === "case",
  );
}

// The argument that carries a transfer's line for the customer, per tool that can transfer.
export const TRANSFER_LINE_ARG: Record<string, string | undefined> =
  Object.fromEntries(
    Object.entries(TOOL_ARG_AUDIENCE).flatMap(([tool, args]) =>
      Object.entries(args)
        .filter(([, who]) => who === "transfer")
        .map(([field]) => [tool, field]),
    ),
  );
