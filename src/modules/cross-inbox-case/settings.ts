// Per-agent config for the `open_case_in_inbox` native tool, read from `agent.settings.crossInboxCase`.
//
// WHERE the case goes is an operator decision and lives here, never in a tool argument: the model
// decides WHETHER to open the case, not which inbox receives it (issue #700). A tool argument could
// be steered by the customer's own words into an inbox the operator never meant to expose.
//
// `mergeContacts` is off by default on purpose. The address a customer types in a chat is only a
// claim, and when it already belongs to another contact a merge is irreversible (Chatwoot has no
// unmerge) and pulls that other contact's attributes into the prompt of the agent talking to whoever
// typed it. Off, the case opens on the contact that already holds the address and the two link notes
// join the halves; an operator who accepts the risk turns the merge on.

export interface CrossInboxCaseConfig {
  // The Chatwoot inbox id (chatwootInboxId) the case is opened in. Null ⇒ the tool is not offered.
  targetInboxId: number | null;
  // Our ChatwootInstance id the inbox was picked from. An inbox id only means something inside one
  // Chatwoot account, so on a conversation of another account the tool is not offered. Null ⇒ a
  // config written without it, honored as-is (single-account tenants).
  targetInstanceId: number | null;
  // A label written on the ORIGIN conversation once the case is open. Null ⇒ none.
  originLabel: string | null;
  // The origin conversation's custom attribute that receives the case's conversation number.
  caseAttributeKey: string;
  mergeContacts: boolean;
  // Close the origin conversation once the case is open, through the same deferred close
  // `resolve_conversation` schedules: after this turn's reply is delivered, and dropped when the
  // customer writes again first. An operator rule, not the model's call, so it is never forgotten.
  resolveOrigin: boolean;
}

export const CROSS_INBOX_CASE_DEFAULT_ATTRIBUTE = "case_conversation_id";

// The destination conversation's attribute that names the conversation the case came from. Fixed,
// because it is what the destination side reads to recognise a case opened this way, and a reader
// has to know the key without reading another agent's settings.
export const CROSS_INBOX_CASE_ORIGIN_ATTRIBUTE = "origin_conversation_id";

export const CROSS_INBOX_CASE_DEFAULTS: CrossInboxCaseConfig = {
  targetInboxId: null,
  targetInstanceId: null,
  originLabel: null,
  caseAttributeKey: CROSS_INBOX_CASE_DEFAULT_ATTRIBUTE,
  mergeContacts: false,
  resolveOrigin: false,
};

// Chatwoot attribute keys are lowercase snake case; anything else would be written under a key the
// dashboard never shows.
// Exported for the write boundary and the editor: a key the reader would replace is refused there, not
// saved and silently ignored.
export const CROSS_INBOX_CASE_ATTRIBUTE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ATTRIBUTE_KEY_RE = CROSS_INBOX_CASE_ATTRIBUTE_KEY_RE;

function positiveInt(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

export function readCrossInboxCaseConfig(
  settings: unknown,
): CrossInboxCaseConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).crossInboxCase
      : undefined;
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return { ...CROSS_INBOX_CASE_DEFAULTS };
  }
  const o = s as Record<string, unknown>;
  const label = typeof o.originLabel === "string" ? o.originLabel.trim() : "";
  const key =
    typeof o.caseAttributeKey === "string" ? o.caseAttributeKey.trim() : "";
  return {
    targetInboxId: positiveInt(o.targetInboxId),
    targetInstanceId: positiveInt(o.targetInstanceId),
    originLabel: label || null,
    caseAttributeKey: ATTRIBUTE_KEY_RE.test(key)
      ? key
      : CROSS_INBOX_CASE_DEFAULT_ATTRIBUTE,
    mergeContacts: o.mergeContacts === true,
    resolveOrigin: o.resolveOrigin === true,
  };
}

// Which identity the destination channel needs to reach the customer, or null when the channel
// cannot start a conversation on its own (Facebook, Instagram, Telegram, Line: they only answer).
export type DestinationIdentity = "email" | "phone" | "none";

export function destinationIdentity(
  channelType: string | null,
): DestinationIdentity | null {
  switch (channelType) {
    case "Channel::Email":
      return "email";
    case "Channel::Whatsapp":
    case "Channel::Sms":
    case "Channel::TwilioSms":
      return "phone";
    case "Channel::Api":
    case "Channel::WebWidget":
      return "none";
    default:
      return null;
  }
}
