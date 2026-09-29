import { clipText } from "@/lib/text";
import {
  composeForChatwoot,
  markValue,
  replaceInOperatorText,
} from "@/modules/chatwoot/liquid";

// Per-agent config for the `open_case_in_inbox` native tool, read from `agent.settings.crossInboxCase`.
// WHERE the case goes lives here, never in a tool argument, which the customer's words could steer
// into an inbox the operator never meant to expose. `mergeContacts` is off by default: a typed address
// is only a claim, and a merge is irreversible in Chatwoot and pulls the other contact's attributes
// into the prompt. Off, the case opens on the contact holding the address and link notes join them.

export interface CrossInboxCaseConfig {
  // The Chatwoot inbox id (chatwootInboxId) the case is opened in. Null ⇒ the tool is not offered.
  targetInboxId: number | null;
  // Our ChatwootInstance id the inbox was picked from. An inbox id only means something inside one
  // Chatwoot account, so on a conversation of another account the tool is not offered. Null ⇒ a
  // config written without it, honored as-is (single-account tenants).
  targetInstanceId: number | null;
  // A label written on the ORIGIN conversation once the case is open. Null ⇒ none.
  originLabel: string | null;
  // Labels written on every CASE this tool opens or continues, on top of the model's `labels`. A team
  // whose queue is a label-filtered folder needs one the operator controls, or the agent's cases never
  // reach it.
  caseLabels: string[];
  // The origin conversation's custom attribute that receives the case's conversation number.
  caseAttributeKey: string;
  mergeContacts: boolean;
  // Close the origin conversation once the case is open, through the same deferred close
  // `resolve_conversation` schedules: after this turn's reply is delivered, and dropped when the
  // customer writes again first. An operator rule, not the model's call, so it is never forgotten.
  resolveOrigin: boolean;
  // The subject of a case opened in an EMAIL inbox: the operator's template, with the prompt's context
  // variables and `{{resumo}}`/`{{summary}}`, which the model writes. Null ⇒ Chatwoot's generic one.
  subjectTemplate: string | null;
  // The opening message of a NEW case, written by the operator: the prompt's context variables,
  // `{{numero_caso}}`/`{{case_number}}` and `{{mensagem}}`/`{{message}}`, the part the model writes.
  // Without the message placeholder the opening is fixed and the model is not asked for one. Null ⇒
  // the model's message, signed, as the whole opening.
  openingTemplate: string | null;
  // The one private note on the case, written by the operator: `{{assunto}}`/`{{subject}}`,
  // `{{motivo}}`/`{{reason}}`, `{{link_origem}}`/`{{origin_url}}` and the context variables. Null ⇒
  // the default layout (`renderCaseNote`).
  noteTemplate: string | null;
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
  caseLabels: [],
  caseAttributeKey: CROSS_INBOX_CASE_DEFAULT_ATTRIBUTE,
  mergeContacts: false,
  resolveOrigin: false,
  subjectTemplate: null,
  openingTemplate: null,
  noteTemplate: null,
};

// An email header: one line, and short enough to read in a list.
export const CROSS_INBOX_CASE_SUBJECT_MAX = 200;
export const CROSS_INBOX_CASE_SUBJECT_TEMPLATE_MAX = 500;
const SUMMARY_PLACEHOLDER = /\{\{\s*(?:resumo|summary)\s*\}\}/g;

// Whether the template leaves part of the subject to the model, which is what offers it the argument.
export function subjectAsksSummary(template: string | null): boolean {
  return template !== null && new RegExp(SUMMARY_PLACEHOLDER).test(template);
}

// Context variables first, then the model's summary: text the model wrote is never interpolated, so a
// `{{...}}` in it stays literal. Empty after rendering ⇒ null, and the case keeps Chatwoot's subject.
export function renderCaseSubject(
  template: string | null,
  summary: string | null,
  interpolate: (template: string) => string,
): string | null {
  if (!template) return null;
  const line = interpolate(template)
    .replace(SUMMARY_PLACEHOLDER, () => summary ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return line ? clipText(line, CROSS_INBOX_CASE_SUBJECT_MAX).trim() : null;
}

export const CROSS_INBOX_CASE_OPENING_TEMPLATE_MAX = 4000;
export const CROSS_INBOX_CASE_NOTE_TEMPLATE_MAX = 2000;
const MESSAGE_PLACEHOLDER = /\{\{\s*(?:mensagem|message)\s*\}\}/;
const OPENING_PLACEHOLDERS =
  /\{\{\s*(mensagem|message|numero_caso|case_number)\s*\}\}/g;
const NOTE_PLACEHOLDERS =
  /\{\{\s*(assunto|subject|motivo|reason|link_origem|origin_url)\s*\}\}/g;

// Whether the model is asked for its part of the opening: always without a template (the message IS
// the opening), and with one only when it has the placeholder.
export function openingAsksMessage(template: string | null): boolean {
  return template === null || MESSAGE_PLACEHOLDER.test(template);
}

// Context variables first, then the case number and the model's message in ONE pass, so text the
// model wrote is never interpolated, and the placeholders are filled in the operator's text only, never
// inside a value already filled in. `interpolate` fences the values it fills in (`markValue`), the
// model's message is fenced here, and `composeForChatwoot` escapes every fenced value for Chatwoot's
// Liquid while the operator's own keeps rendering: the result is the wire. Empty ⇒ null, nothing sent.
export function renderCaseOpening(
  template: string,
  message: string | null,
  caseNumber: number,
  interpolate: (template: string) => string,
): string | null {
  const text = composeForChatwoot(
    replaceInOperatorText(
      interpolate(template),
      OPENING_PLACEHOLDERS,
      (_, key) =>
        key === "mensagem" || key === "message"
          ? markValue(message ?? "")
          : String(caseNumber),
    ),
  ).trim();
  return text || null;
}

// The one private note on the case, in markdown: the subject as its title, a link back to the
// conversation the case came from, and the model's reason. PT-BR, like the other system notes. The
// operator's template replaces the layout, filled the same way as the opening: the subject and the
// reason carry the model's words and are fenced values, the link is ours.
export function renderCaseNote(
  template: string | null,
  parts: { subject: string | null; reason: string; originUrl: string },
  interpolate: (template: string) => string,
): string {
  const subject = parts.subject ? markValue(parts.subject) : "";
  const reason = markValue(parts.reason);
  if (!template) {
    const title = subject ? `### ${subject}\n\n` : "";
    return composeForChatwoot(
      `${title}**Caso aberto a partir de outra conversa:** [ver conversa de origem](${parts.originUrl})\n\n**Motivo:**\n${reason}`,
    );
  }
  return composeForChatwoot(
    replaceInOperatorText(
      interpolate(template),
      NOTE_PLACEHOLDERS,
      (_, key) => {
        if (key === "assunto" || key === "subject") return subject;
        if (key === "motivo" || key === "reason") return reason;
        return parts.originUrl;
      },
    ),
  ).trim();
}

// The note a case gets when the customer adds something after it opened. Its own layout, never the
// operator's `noteTemplate`, which describes a case being opened.
export function renderCaseAddition(reason: string, originUrl: string): string {
  return composeForChatwoot(
    `**Informação adicional do cliente** ([ver conversa](${originUrl})):\n\n${markValue(reason)}`,
  );
}

// Chatwoot attribute keys are lowercase snake case; anything else would be written under a key the
// dashboard never shows.
// Exported for the write boundary and the editor: a key the reader would replace is refused there, not
// saved and silently ignored.
export const CROSS_INBOX_CASE_ATTRIBUTE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ATTRIBUTE_KEY_RE = CROSS_INBOX_CASE_ATTRIBUTE_KEY_RE;

// Chatwoot label titles are lowercase, and the same label twice is one label.
export const CROSS_INBOX_CASE_MAX_LABELS = 20;

export function normalizeCaseLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const l of v) {
    if (typeof l !== "string") continue;
    const label = l.trim().toLowerCase();
    if (label && !out.includes(label)) out.push(label);
  }
  return out.slice(0, CROSS_INBOX_CASE_MAX_LABELS);
}

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
  const subject =
    typeof o.subjectTemplate === "string"
      ? clipText(
          o.subjectTemplate.trim(),
          CROSS_INBOX_CASE_SUBJECT_TEMPLATE_MAX,
        )
      : "";
  const template = (v: unknown, max: number) =>
    typeof v === "string" ? clipText(v.trim(), max).trim() || null : null;
  return {
    targetInboxId: positiveInt(o.targetInboxId),
    targetInstanceId: positiveInt(o.targetInstanceId),
    originLabel: label || null,
    caseLabels: normalizeCaseLabels(o.caseLabels),
    caseAttributeKey: ATTRIBUTE_KEY_RE.test(key)
      ? key
      : CROSS_INBOX_CASE_DEFAULT_ATTRIBUTE,
    mergeContacts: o.mergeContacts === true,
    resolveOrigin: o.resolveOrigin === true,
    subjectTemplate: subject || null,
    openingTemplate: template(
      o.openingTemplate,
      CROSS_INBOX_CASE_OPENING_TEMPLATE_MAX,
    ),
    noteTemplate: template(o.noteTemplate, CROSS_INBOX_CASE_NOTE_TEMPLATE_MAX),
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
