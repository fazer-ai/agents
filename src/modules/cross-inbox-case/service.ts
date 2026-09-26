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
import { withConversationLabels } from "@/modules/chatwoot/labels";
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
  | "toggleStatus"
>;

// What the turn's output check made of the opening message: send it, drop it, or the operator's
// policy transferred the ORIGIN to the team over it (the check's `handoff` action), which the runtime
// that owns the check has already carried out.
export type CustomerTextVerdict = "send" | "drop" | "handed";

export interface OpenCaseInput {
  config: CrossInboxCaseConfig;
  // The origin conversation's display_id and its contact's Chatwoot id.
  originConversationId: number;
  originContactId: number | null;
  reason: string;
  customerMessage: string | null;
  email: string | null;
  labels: string[];
  // Asked right before the first write and again right before the create; false ⇒ nothing more is
  // written.
  stillWanted?: () => Promise<boolean>;
  // The turn's OUTPUT guardrail over the opening message, which reaches the customer from inside the
  // tool and would otherwise go out unread by the moderation every reply passes. Answers whether the
  // text may be sent. Absent ⇒ no screening configured on this path.
  screenCustomerMessage?: (text: string) => Promise<CustomerTextVerdict>;
  // The label writers' shared queue is keyed by tenant (see modules/chatwoot/labels.ts).
  tenantId?: bigint | null;
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
      // The opening message the output guardrail refused, so it was not sent.
      openingBlocked?: boolean;
      // The destination's reply window was closed (Chatwoot's `can_reply`), so the opening went to
      // the case as an explained private note instead of to the customer.
      openingOutsideWindow?: boolean;
    }
  | { kind: "not_configured" }
  | { kind: "unsupported_channel"; channelType: string | null }
  // The conversation already sits in the destination inbox: there is nowhere to move it.
  | { kind: "same_inbox" }
  | { kind: "needs_email" }
  | { kind: "needs_phone" }
  | { kind: "rejected_email"; why: "invalid" | "not_in_conversation" }
  | { kind: "called_off" }
  // The output check's policy transferred the origin to the team over the opening message: nothing
  // was opened, and the conversation is the team's now.
  | { kind: "handed_by_policy" }
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

// Every complete address in a text: a run with no separator around one "@", minus the sentence
// punctuation it can end with. Compared WHOLE, because a substring match lets a truncated address
// through — "anna@example.com" sits inside "joanna@example.com.br", and the case would then go to a
// mailbox the customer never named.
const ADDRESS_TOKEN_RE = /[^\s@<>"',;:()[\]]+@[^\s@<>"',;:()[\]]+/g;

export function customerTyped(texts: string[], email: string): boolean {
  const wanted = email.toLowerCase();
  return texts.some((t) =>
    (t.match(ADDRESS_TOKEN_RE) ?? []).some(
      (tok) =>
        tok
          .replace(/^mailto:/i, "")
          .replace(/[.!?]+$/, "")
          .toLowerCase() === wanted,
    ),
  );
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
// Header of the opening that could not reach the customer: the destination channel only lets the
// business write first with an approved template, and a free-form message there is rejected.
export const OPENING_OUTSIDE_WINDOW_PREFIX =
  "⏳ Fora da janela de atendimento deste canal: a mensagem de abertura abaixo NÃO foi enviada ao cliente. " +
  "Para falar com ele por aqui, comece por um template aprovado (HSM).\n\n";

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
    // An agent can serve the destination inbox too. Opening the "case" there would hand back the
    // origin itself on an inbox that continues open conversations, flip it open under the turn, and
    // under `resolveOrigin` close the very conversation the customer was told holds the case.
    if (Number(field(originConv, "inbox_id")) === target) {
      return { kind: "same_inbox" };
    }
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
        // Pending or snoozed is out of the team's open queue, and "already with the team" would not
        // be true: reopened like a continued case below, and just as mandatory.
        if (field(existing, "status") !== "open") {
          step = "reopen_known_case";
          if (input.stillWanted && !(await input.stillWanted())) {
            return { kind: "called_off" };
          }
          await client.toggleStatus(known, "open", { asAdmin: true });
        }
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
          // Asked right before the one write nothing can undo: the address write and the holder
          // search above were both waits, and a withdrawal inside them must not still move another
          // contact's history onto this one.
          if (input.stillWanted && !(await input.stillWanted())) {
            return { kind: "called_off" };
          }
          await client.mergeContacts(contactId, holder);
          identity = "merged";
        } else {
          caseContactId = holder;
          identity = "other_contact";
        }
      }
    }

    // The opening message is screened BEFORE anything opens, like every reply the customer reads. A
    // refused one is not sent; the case still opens, because the team still owes the customer.
    let customerMessage = input.customerMessage;
    let openingBlocked = false;
    if (customerMessage && input.screenCustomerMessage) {
      step = "screen_customer_message";
      const verdict = await input.screenCustomerMessage(customerMessage);
      if (verdict === "handed") return { kind: "handed_by_policy" };
      if (verdict === "drop") {
        customerMessage = null;
        openingBlocked = true;
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
    // ASKED AGAIN, after the last wait and right before the write nothing undoes: the ask above sat
    // before the screening and this read, and a `/reset` or a withdrawal inside either of them must
    // not still open a case and send its opening.
    if (input.stillWanted && !(await input.stillWanted())) {
      return { kind: "called_off" };
    }
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
    //
    // EVERY WRITE ASKS THE FENCE FIRST, because each one follows a wait: the create, and then each
    // write before it. A `/reset`, a switch-off or a person taking the origin over inside any of them
    // stops what is left, and the attribute writer asks again inside its own queue, after its read,
    // so a reset that cleared the origin's attributes is not undone by this one. The case stays
    // open, since no write here can take it back.
    const partial: string[] = [];
    let calledOff = false;
    const withdrawn = async (): Promise<boolean> => {
      if (calledOff) return true;
      if (input.stillWanted && !(await input.stillWanted())) {
        calledOff = true;
        partial.push("called_off");
      }
      return calledOff;
    };
    const attempt = async (name: string, fn: () => Promise<unknown>) => {
      if (await withdrawn()) return;
      try {
        await fn();
      } catch {
        partial.push(name);
      }
    };
    // A continued case can come back closed: an inbox locked to one conversation per contact hands
    // back the contact's LAST conversation whatever its state, without applying the status asked
    // for. Reopened here, because a case the team cannot see in its queue is not a case.
    // NOT best-effort, unlike everything after it: a case that could not be reopened is not a case,
    // and reporting it open would tell the customer so and, under `resolveOrigin`, close the origin
    // too, leaving both conversations closed. It fails the opening instead, which hands the origin
    // to people.
    if (created.status !== "open") {
      step = "reopen_case";
      if (input.stillWanted && !(await input.stillWanted())) {
        return { kind: "called_off" };
      }
      await client.toggleStatus(caseId, "open", { asAdmin: true });
    }
    await attempt("origin_attribute", () =>
      client.setConversationCustomAttributes(
        origin,
        { [config.caseAttributeKey]: caseId },
        { stillWanted: input.stillWanted },
      ),
    );
    // A continued case already has its opening: repeating it would send the customer a second
    // "we opened your case" email for the same case.
    // A channel with a reply window (official WhatsApp, Twilio on WhatsApp, an API inbox with one
    // set) refuses a free-form first message to a customer who has not written there lately, and a
    // new case has, by construction, no message from them. Chatwoot's own `can_reply` says so; the
    // opening then goes to the case as an explained note, the service-window fallback.
    let openingOutsideWindow = false;
    if (!continued && customerMessage) {
      const text = customerMessage;
      if (created.canReply === false) {
        openingOutsideWindow = true;
        await attempt("customer_message", () =>
          client.sendMessageAsAdmin(
            caseId,
            `${OPENING_OUTSIDE_WINDOW_PREFIX}${text}`,
            { private: true },
          ),
        );
      } else {
        await attempt("customer_message", () =>
          client.sendMessageAsAdmin(caseId, text, { private: false }),
        );
      }
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
    // Labels are a read-modify-write of the whole set, so both go through the queue every label
    // writer shares (`set_labels`, the observer's verdict), and both READ inside it, a new case
    // included: an automation or an operator can label it between the create and this write, and
    // serializing only preserves a change the write has read.
    if (input.labels.length > 0) {
      await attempt("destination_labels", () =>
        withConversationLabels(input.tenantId, caseId, async () => {
          const current = await client.getConversationLabels(caseId);
          // Asked again after the queue's wait and the read: a reset queued ahead of this write clears
          // the labels and withdraws the turn, and this write must not put them back.
          if (await withdrawn()) return;
          await client.setConversationLabels(
            caseId,
            [...new Set([...current, ...input.labels])],
            { asAdmin: true },
          );
        }),
      );
    }
    const originLabel = config.originLabel;
    if (originLabel) {
      await attempt("origin_label", () =>
        withConversationLabels(input.tenantId, origin, async () => {
          const current = await client.getConversationLabels(origin);
          if (current.includes(originLabel)) return;
          if (await withdrawn()) return;
          await client.setConversationLabels(origin, [...current, originLabel]);
        }),
      );
    }
    return {
      kind: continued ? "continued" : "opened",
      caseId,
      caseUrl,
      identity,
      partial,
      ...(openingBlocked ? { openingBlocked } : {}),
      ...(openingOutsideWindow ? { openingOutsideWindow } : {}),
    };
  } catch (error) {
    return { kind: "failed", step, error };
  }
}
