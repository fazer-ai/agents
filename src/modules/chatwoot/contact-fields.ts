// The contact's standard Chatwoot fields an agent may see and, per field, change (the native
// update_contact tool). The set is FIXED: `phone_number` is the contact's identity on the channel
// and unique per account, `identifier` stitches the WhatsApp-to-widget redirect together, and
// neither is something a model should rewrite.
export const CONTACT_FIELDS = [
  "name",
  "email",
  "company_name",
  "city",
  "country",
  "description",
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

// The four that live in Chatwoot's `additional_attributes`, the group its own contact form edits.
// The mirror keeps them in Contact.additionalAttributes under the same keys.
export const ADDITIONAL_CONTACT_FIELDS = [
  "company_name",
  "city",
  "country",
  "description",
] as const satisfies readonly ContactField[];
export type AdditionalContactField = (typeof ADDITIONAL_CONTACT_FIELDS)[number];

export function isAdditionalContactField(
  v: ContactField,
): v is AdditionalContactField {
  return (ADDITIONAL_CONTACT_FIELDS as readonly string[]).includes(v);
}

// `context`: the fields whose current values go into the system prompt. `writable`: the subset
// update_contact may change. Writing a field the agent cannot see is overwriting blind, so a
// writable field outside `context` is dropped on read rather than honored.
export interface ContactFieldsConfig {
  context: ContactField[];
  writable: ContactField[];
}

export const CONTACT_FIELDS_DEFAULTS: ContactFieldsConfig = {
  context: [],
  writable: [],
};

function readFields(v: unknown): ContactField[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<unknown>();
  const scan = Math.min(v.length, CONTACT_FIELDS.length * 10);
  for (let i = 0; i < scan; i++) seen.add(v[i]);
  // NOTE: Filtering the catalog both drops an unknown name and keeps the canonical order, so the
  // prompt block and the tool schema read the same whatever order a bag or an MCP patch used.
  return CONTACT_FIELDS.filter((f) => seen.has(f));
}

// Per-agent selection from `agent.settings.contactFields`. Anything malformed reads as nothing
// selected, never as everything: a bad setting turns the block and the tool off.
export function readContactFieldsConfig(
  settings: unknown,
): ContactFieldsConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).contactFields
      : undefined;
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return { context: [], writable: [] };
  }
  const bag = s as Record<string, unknown>;
  const context = readFields(bag.context);
  const writable = readFields(bag.writable).filter((f) => context.includes(f));
  return { context, writable };
}

// The current value of each field, as the mirror holds it: name and email in their own columns,
// the other four in the additional_attributes column.
export type ContactFieldValues = Partial<Record<ContactField, unknown>>;

export function contactFieldValuesFrom(row: {
  name?: string | null;
  email?: string | null;
  additionalAttributes?: unknown;
}): ContactFieldValues {
  const bag =
    row.additionalAttributes &&
    typeof row.additionalAttributes === "object" &&
    !Array.isArray(row.additionalAttributes)
      ? (row.additionalAttributes as Record<string, unknown>)
      : {};
  const out: ContactFieldValues = { name: row.name, email: row.email };
  for (const f of ADDITIONAL_CONTACT_FIELDS) out[f] = bag[f];
  return out;
}
