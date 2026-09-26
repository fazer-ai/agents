// Opening the contact's case in another inbox (issue #700): the operation behind the
// `open_case_in_inbox` native tool. The tool (src/graph/tools/native.ts) owns what the model reads;
// this owns what happens in Chatwoot, in this order:
//
//   1. an open case this conversation already opened is answered with that case, not a second one;
//   2. the destination's identity (an email address for an email inbox) is settled on the contact;
//   3. the conversation is opened in the destination inbox, or continued when the inbox is set to
//      continue the contact's open case (the fork's `continue_open_conversation`);
//   4. the case number is written back on the origin conversation, then the opening message, the
//      notes that link the two sides and the labels.
//
// It does NOT close the origin conversation. `resolve_conversation` does that, and on the reactive
// path it defers the close until after delivery and drops it when the customer writes again; closing
// here would take that protection away.

import { withKeyedQueue } from "@/lib/locks";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import {
  CROSS_INBOX_CASE_ORIGIN_ATTRIBUTE,
  type CrossInboxCaseConfig,
  destinationIdentity,
} from "./settings";

export { destinationIdentity };

// What the operation needs from the Chatwoot client, named so a test can hand it a fake.
export type CaseClient = Pick<
  ChatwootClient,
  | "conversationUrl"
  | "getInbox"
  | "getConversation"
  | "getContact"
  | "updateContact"
  | "findContactIdByEmail"
  | "mergeContacts"
  | "listContactConversations"
  | "createConversation"
  | "sendMessageAsAdmin"
  | "sendPrivateNote"
  | "getMessages"
  | "getConversationLabels"
  | "setConversationLabels"
  | "setConversationCustomAttributes"
>;

export interface OpenCaseInput {
  config: CrossInboxCaseConfig;
  // The origin conversation's display_id and its contact's Chatwoot id.
  originConversationId: number;
  originContactId: number | null;
  reason: string;
  customerMessage: string | null;
  email: string | null;
  labels: string[];
  // Asked right before the first write; false ⇒ nothing is written.
  stillWanted?: () => Promise<boolean>;
}

export type OpenCaseResult =
  | {
      kind: "opened" | "continued" | "already_open";
      caseId: number;
      caseUrl: string;
      // How the address that reached the destination was settled, when one had to be.
      identity: "held" | "written" | "merged" | "other_contact" | null;
      // Writes after the case existed that did not land. The case is open either way.
      partial: string[];
    }
  | { kind: "not_configured" }
  | { kind: "unsupported_channel"; channelType: string | null }
  | { kind: "needs_email" }
  | { kind: "needs_phone" }
  | { kind: "rejected_email"; why: "invalid" | "not_in_conversation" }
  | { kind: "called_off" }
  | { kind: "failed"; step: string; error: unknown };

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;.]{2,}$/;

export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().replace(/^mailto:/i, "");
  return EMAIL_RE.test(v) ? v : null;
}

// The customer's own messages on the latest page of the conversation. An address the tool writes on
// the contact has to be one the CUSTOMER typed here: the model paraphrasing, guessing or completing
// one is exactly how a case ends up in a stranger's mailbox.
function incomingTexts(page: unknown): string[] {
  const payload =
    page && typeof page === "object"
      ? (page as { payload?: unknown }).payload
      : undefined;
  if (!Array.isArray(payload)) return [];
  const out: string[] = [];
  for (const m of payload) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    if (msg.message_type !== 0 && msg.message_type !== "incoming") continue;
    if (typeof msg.content === "string") out.push(msg.content);
  }
  return out;
}

export function customerTyped(texts: string[], email: string): boolean {
  const wanted = email.toLowerCase();
  return texts.some((t) => t.toLowerCase().includes(wanted));
}

function numberAttr(conv: unknown, key: string): number | null {
  if (!conv || typeof conv !== "object") return null;
  const attrs = (conv as { custom_attributes?: unknown }).custom_attributes;
  if (!attrs || typeof attrs !== "object") return null;
  const n = Number((attrs as Record<string, unknown>)[key]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function field(conv: unknown, key: string): unknown {
  return conv && typeof conv === "object"
    ? (conv as Record<string, unknown>)[key]
    : undefined;
}

// Pure: the private notes. PT-BR, like the webhook's other system notes.
export function originLinkNote(caseUrl: string, inboxName: string): string {
  return `➡️ Caso aberto na caixa ${inboxName}: ${caseUrl}`;
}
export function destinationLinkNote(originUrl: string): string {
  return `⬅️ Caso aberto a partir da conversa: ${originUrl}`;
}
export function destinationReasonNote(reason: string): string {
  return `Motivo: ${reason}`;
}

export function openCaseInInbox(
  client: CaseClient,
  input: OpenCaseInput,
): Promise<OpenCaseResult> {
  // One turn's tool calls run concurrently (LangGraph's ToolNode uses Promise.all), so a model that
  // calls twice would otherwise read "no case yet" twice and open two. Serialized per origin
  // conversation, the second call reads the case number the first one wrote.
  return withKeyedQueue(
    `cross-inbox-case:${client.conversationUrl(input.originConversationId)}`,
    () => run(client, input),
  );
}

async function run(
  client: CaseClient,
  input: OpenCaseInput,
): Promise<OpenCaseResult> {
  const { config } = input;
  const target = config.targetInboxId;
  if (target === null) return { kind: "not_configured" };
  const origin = input.originConversationId;

  let step = "read_target_inbox";
  try {
    const inbox = await client.getInbox(target);
    const channelType =
      typeof field(inbox, "channel_type") === "string"
        ? (field(inbox, "channel_type") as string)
        : null;
    const inboxName =
      typeof field(inbox, "name") === "string"
        ? (field(inbox, "name") as string)
        : `#${target}`;
    const needs = destinationIdentity(channelType);
    if (needs === null) return { kind: "unsupported_channel", channelType };

    // 1. A case this conversation already opened, still open, IS the answer. It covers the model
    // calling twice, a redelivered turn, and the customer asking again while the case is running.
    step = "read_origin";
    const originConv = await client.getConversation(origin);
    const known = numberAttr(originConv, config.caseAttributeKey);
    if (known !== null) {
      step = "read_known_case";
      const existing = await client.getConversation(known).catch((err) => {
        if (err instanceof ChatwootApiError && err.status === 404) return null;
        throw err;
      });
      if (
        existing &&
        Number(field(existing, "inbox_id")) === target &&
        field(existing, "status") !== "resolved"
      ) {
        return {
          kind: "already_open",
          caseId: known,
          caseUrl: client.conversationUrl(known),
          identity: null,
          partial: [],
        };
      }
    }

    const contactId = input.originContactId;
    if (contactId === null) {
      return { kind: "failed", step: "no_contact", error: null };
    }

    // 2. The identity the destination needs.
    step = "read_contact";
    const contact = await client.getContact(contactId);
    let caseContactId = contactId;
    let identity: "held" | "written" | "merged" | "other_contact" | null = null;
    let pendingEmail: string | null = null;
    if (needs === "phone") {
      if (!contact?.phoneNumber) return { kind: "needs_phone" };
      identity = "held";
    } else if (needs === "email") {
      if (contact?.email) {
        identity = "held";
      } else {
        if (!input.email) return { kind: "needs_email" };
        const email = normalizeEmail(input.email);
        if (!email) return { kind: "rejected_email", why: "invalid" };
        step = "read_messages";
        const texts = incomingTexts(await client.getMessages(origin));
        if (!customerTyped(texts, email)) {
          return { kind: "rejected_email", why: "not_in_conversation" };
        }
        pendingEmail = email;
      }
    }

    if (input.stillWanted && !(await input.stillWanted())) {
      return { kind: "called_off" };
    }

    if (pendingEmail !== null) {
      step = "write_email";
      try {
        await client.updateContact(contactId, { email: pendingEmail });
        identity = "written";
      } catch (err) {
        // 422 is the fork's answer to an address another contact of the account already holds
        // (the uniqueness is per account, case-insensitive). Anything else is a real failure.
        if (!(err instanceof ChatwootApiError && err.status === 422)) throw err;
        step = "find_email_holder";
        const holder = await client.findContactIdByEmail(pendingEmail);
        if (holder === null || holder === contactId) throw err;
        if (config.mergeContacts) {
          // The ORIGIN contact is the base: it is the one this conversation, and the platform's
          // mirror of it, point at. The holder's conversations and address move onto it.
          step = "merge_contacts";
          await client.mergeContacts(contactId, holder);
          identity = "merged";
        } else {
          caseContactId = holder;
          identity = "other_contact";
        }
      }
    }

    // 3. Open, or continue. Which of the two happened is read from the contact's conversations in
    // that inbox BEFORE the call: the create answers with a conversation either way.
    step = "list_case_conversations";
    const before = new Set(
      (await client.listContactConversations(caseContactId))
        .filter((c) => c.inboxId === target)
        .map((c) => c.id),
    );
    step = "create_conversation";
    const created = await client.createConversation({
      inboxId: target,
      contactId: caseContactId,
      // Open, not pending: the case lands in the team's queue, and an agent bound to the destination
      // inbox does not pick it up and triage it again (shouldBotHandle needs `pending`).
      status: "open",
      customAttributes: { [CROSS_INBOX_CASE_ORIGIN_ATTRIBUTE]: origin },
    });
    const caseId = created.id;
    const continued = before.has(caseId);
    const caseUrl = client.conversationUrl(caseId);
    const originUrl = client.conversationUrl(origin);

    // 4. Everything below is best-effort: the case exists, and a missing note does not undo it.
    // The case number goes first, because it is what makes the next call answer "already open".
    const partial: string[] = [];
    const attempt = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        partial.push(name);
      }
    };
    await attempt("origin_attribute", () =>
      client.setConversationCustomAttributes(origin, {
        [config.caseAttributeKey]: caseId,
      }),
    );
    // A continued case already has its opening: repeating it would send the customer a second
    // "we opened your case" email for the same case.
    if (!continued && input.customerMessage) {
      const text = input.customerMessage;
      await attempt("customer_message", () =>
        client.sendMessageAsAdmin(caseId, text, { private: false }),
      );
    }
    await attempt("destination_reason_note", () =>
      client.sendMessageAsAdmin(caseId, destinationReasonNote(input.reason), {
        private: true,
      }),
    );
    await attempt("destination_link_note", () =>
      client.sendMessageAsAdmin(caseId, destinationLinkNote(originUrl), {
        private: true,
      }),
    );
    await attempt("origin_link_note", () =>
      client.sendPrivateNote(origin, originLinkNote(caseUrl, inboxName)),
    );
    if (input.labels.length > 0) {
      await attempt("destination_labels", async () => {
        const current = continued
          ? await client.getConversationLabels(caseId)
          : [];
        await client.setConversationLabels(
          caseId,
          [...new Set([...current, ...input.labels])],
          { asAdmin: true },
        );
      });
    }
    const originLabel = config.originLabel;
    if (originLabel) {
      await attempt("origin_label", async () => {
        const current = await client.getConversationLabels(origin);
        if (current.includes(originLabel)) return;
        await client.setConversationLabels(origin, [...current, originLabel]);
      });
    }
    return {
      kind: continued ? "continued" : "opened",
      caseId,
      caseUrl,
      identity,
      partial,
    };
  } catch (error) {
    return { kind: "failed", step, error };
  }
}
