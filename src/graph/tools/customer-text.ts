import { HANDOFF_TOOL_NAME, OPEN_CASE_TOOL_NAME } from "./catalog";

// Every argument of every tool the product builds, classified by where the model's text goes:
//   `customer`: the customer reads it (a caption, an email, an invitation, a charge's description);
//   `transfer`: the customer reads it, and only when a transfer to a person happens with it;
//   `internal`: nobody outside the team reads it (an id, a note, a label, a search).
// One place, because a reply the turn review's rules refuse must not reach the customer by
// another door: the rules read every `customer` and `transfer` argument before the call runs
// (docs/turn-review.md). `tests/graph/customer-text-registry.test.ts` fails for a tool, or an
// argument, that is not listed here, so a new one has to pick a side.
export type ArgAudience = "customer" | "transfer" | "internal";

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
    summary: "internal",
    // Sent to the customer in the destination inbox when the case opens.
    customer_message: "customer",
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
  react_to_message: { emoji: "internal" },
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

// Every string a value holds, however nested: a document's line items carry their own text.
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(stringsIn);
  return [];
}

// What a call would have the customer read, argument by argument. A document tool (named by the
// operator's template, so known only to the caller) issues a document to the customer from every
// value it is given.
export function customerTextOf(
  call: { name: string; args: unknown },
  isDocumentTool: (name: string) => boolean = () => false,
): CustomerText[] {
  const args =
    call.args && typeof call.args === "object"
      ? (call.args as Record<string, unknown>)
      : {};
  if (isDocumentTool(call.name)) {
    const text = stringsIn(args).join("\n");
    return text ? [{ field: "*", text, transfer: false }] : [];
  }
  const audience = TOOL_ARG_AUDIENCE[call.name];
  if (!audience) return [];
  const out: CustomerText[] = [];
  for (const [field, who] of Object.entries(audience)) {
    if (who === "internal") continue;
    const text = stringsIn(args[field]).join("\n");
    if (text) out.push({ field, text, transfer: who === "transfer" });
  }
  return out;
}

// How the tool's arguments reach the customer, if any does: always, or only with a transfer.
export function customerAudiences(
  name: string,
  isDocumentTool: (name: string) => boolean = () => false,
): ("customer" | "transfer")[] {
  if (isDocumentTool(name)) return ["customer"];
  return Object.values(TOOL_ARG_AUDIENCE[name] ?? {}).filter(
    (w) => w !== "internal",
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
