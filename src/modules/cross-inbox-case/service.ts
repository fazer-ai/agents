// Opening the contact's case in another inbox: the Chatwoot side of the `open_case_in_inbox` native
// tool (src/graph/tools/native.ts owns what the model reads). In order: reuse an open case this
// conversation already opened; settle the destination identity on the contact; open or continue the
// case in the destination inbox; write the case number back on the origin, take the case from any
// agent bot and give it to the team, then send the opening message, link notes and labels. It does
// NOT close the origin: `resolve_conversation` defers that until after delivery and drops it when the
// customer writes again, and closing here would lose that protection.

import { withKeyedQueue } from "@/lib/locks";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import { withConversationLabels } from "@/modules/chatwoot/labels";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
import {
  CROSS_INBOX_CASE_ORIGIN_ATTRIBUTE,
  type CrossInboxCaseConfig,
  destinationIdentity,
  openingAsksMessage,
  renderCaseAddition,
  renderCaseNote,
  renderCaseOpening,
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
  | "listUnresolvedContactConversations"
  | "createConversation"
  | "sendMessageAsAdmin"
  | "sendPrivateNote"
  | "getMessages"
  | "getConversationLabels"
  | "setConversationLabels"
  | "listLabels"
  | "setConversationCustomAttributes"
  | "toggleStatus"
  | "unassignConversation"
  | "assignTeam"
>;

// What the turn's output check made of the opening message: send it, drop it, or the operator's
// policy transferred the ORIGIN to the team over it (the check's `handoff` action), which the runtime
// that owns the check has already carried out. `failed` is that transfer not landing: the policy asked
// for a person and did not get one, so nothing may open as if the text had merely been dropped.
export type CustomerTextVerdict = "send" | "drop" | "handed" | "failed";

export interface OpenCaseInput {
  config: CrossInboxCaseConfig;
  // The origin conversation's display_id and its contact's Chatwoot id.
  originConversationId: number;
  originContactId: number | null;
  reason: string;
  customerMessage: string | null;
  email: string | null;
  labels: string[];
  // The rendered email subject (the operator's template, see settings.ts). Written only on an email
  // destination; a continued case keeps the subject it has.
  subject?: string | null;
  // Asked right before the first write and again right before the create; false ⇒ nothing more is
  // written.
  stillWanted?: () => Promise<boolean>;
  // The turn's OUTPUT guardrail over the opening message, which reaches the customer from inside the
  // tool and would otherwise go out unread by the moderation every reply passes. Answers whether the
  // text may be sent. Absent ⇒ no screening configured on this path.
  screenCustomerMessage?: (text: string) => Promise<CustomerTextVerdict>;
  // The agent's signature over the opening the customer receives, applied after the screening like
  // every reply's. It returns what goes on the wire: the model's text escaped for Chatwoot's Liquid
  // and the signature as the operator wrote it. Absent ⇒ the model's text, escaped. Not applied over
  // the operator's `openingTemplate`, which carries its own sign-off.
  signCustomerMessage?: (text: string) => string;
  // The prompt's context variables, for the operator's opening and note templates, each value fenced
  // with `markValue` so it goes out escaped for Chatwoot's Liquid. Absent ⇒ none.
  interpolate?: (template: string) => string;
  // The label writers' shared queue is keyed by tenant (see modules/chatwoot/labels.ts).
  tenantId?: bigint | null;
  // The team the case is given to when it has none: the agent's pinned handoff team, which is where
  // this agent sends conversations for people to take. Null ⇒ no team is written, and Chatwoot's own
  // routing decides once the case has no owner.
  caseTeamId?: number | null;
}

export type OpenCaseResult =
  | {
      // `appended`: the contact already had a case open in the destination, opened from another
      // conversation, so the note went there and this conversation was linked to it.
      kind: "opened" | "continued" | "already_open" | "appended";
      caseId: number;
      caseUrl: string;
      // How the address that reached the destination was settled, when one had to be.
      identity: "held" | "written" | "merged" | "other_contact" | null;
      // Writes after the case existed that did not land. The case is open either way. On an
      // already-open case, only the owner writes (`case_assignee`, `case_team`) and the note can appear.
      partial: string[];
      // The opening message the output guardrail refused, so it was not sent.
      openingBlocked?: boolean;
      // The destination's reply window was closed (Chatwoot's `can_reply`), so the opening went to
      // the case as an explained private note instead of to the customer.
      openingOutsideWindow?: boolean;
      // Operator case labels the account does not have, left off the case.
      unknownCaseLabels?: string[];
      // The case could not be read to settle its owner, so nothing past that point was written:
      // `before_clear` wrote nothing, `before_team` cleared the bot and wrote no team.
      caseOwnerUnread?: CaseOwnerUnread;
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

// The customer's own messages on one page of the conversation. An address the tool writes on the
// contact has to be one the CUSTOMER typed here: the model paraphrasing, guessing or completing one
// is exactly how a case ends up in a stranger's mailbox.
function incomingTexts(page: unknown): string[] {
  const out: string[] = [];
  for (const msg of pageRows(page)) {
    if (msg.message_type !== 0 && msg.message_type !== "incoming") continue;
    if (typeof msg.content === "string") out.push(msg.content);
  }
  return out;
}

function pageRows(page: unknown): Record<string, unknown>[] {
  const payload =
    page && typeof page === "object"
      ? (page as { payload?: unknown }).payload
      : undefined;
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (m): m is Record<string, unknown> => !!m && typeof m === "object",
  );
}

// Chatwoot answers the messages of a conversation 20 at a time, newest first, and `before` asks for
// the page older than a message id.
const MESSAGES_PAGE = 20;
// How far back the walk goes: a thousand messages, far past any conversation that ends in a case.
const TYPED_EMAIL_MAX_PAGES = 50;

// Whether the customer typed the address anywhere in the conversation, walking back from the newest
// page. The newest page alone is not enough: the address very often comes in the first message (a
// website form), and a conversation that reaches a case is usually longer than one page. Stops at
// the page that has it, at the first message, or at a page that does not move the cursor back.
async function customerTypedInConversation(
  client: CaseClient,
  conversationId: number,
  email: string,
): Promise<boolean> {
  let before: number | undefined;
  for (let pages = 0; pages < TYPED_EMAIL_MAX_PAGES; pages += 1) {
    const page = await client.getMessages(
      conversationId,
      before == null ? undefined : { before },
    );
    if (customerTyped(incomingTexts(page), email)) return true;
    const rows = pageRows(page);
    if (rows.length < MESSAGES_PAGE) return false;
    const ids = rows
      .map((m) => Number(m.id))
      .filter((id) => Number.isFinite(id));
    if (ids.length === 0) return false;
    const oldest = Math.min(...ids);
    if (before != null && oldest >= before) return false;
    before = oldest;
  }
  return false;
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

// Where a contact's case lives, for a reader that is not opening one.
export interface CaseInbox {
  targetInboxId: number;
  caseAttributeKey: string;
  contactId: number | null;
}

// THE CASE A CONTACT IS WAITING ON, open or pending in the destination inbox, other than the
// conversation being asked about. Read two ways, because a case can sit on another contact (the
// address belonged to someone else and nothing was merged): the attribute this conversation got when
// it opened the case, and the contact's own conversations. Null ⇒ none. Throws when a read fails or
// when a full page of the listing may hide the case.
export async function openCaseFor(
  client: Pick<CaseClient, "getConversation" | "listContactConversations">,
  conversationId: number,
  where: CaseInbox,
): Promise<number | null> {
  const waiting = (inboxId: unknown, status: unknown) =>
    Number(inboxId) === where.targetInboxId &&
    (status === "open" || status === "pending");
  const conv = await client.getConversation(conversationId);
  const known = numberAttr(conv, where.caseAttributeKey);
  if (known !== null && known !== conversationId) {
    const c = await client.getConversation(known).catch((err) => {
      if (err instanceof ChatwootApiError && err.status === 404) return null;
      throw err;
    });
    if (c && waiting(field(c, "inbox_id"), field(c, "status"))) return known;
  }
  if (where.contactId === null) return null;
  const listed = await client.listContactConversations(where.contactId);
  const open = listed.find(
    (c) => c.id !== conversationId && waiting(c.inboxId, c.status),
  );
  if (open) return open.id;
  // The listing is the contact's newest page only: a full one without the case does not prove there
  // is none, so it answers like a read that failed.
  if (listed.length >= CONTACT_CONVERSATIONS_PAGE) {
    throw new Error(
      `contact ${where.contactId} has at least ${CONTACT_CONVERSATIONS_PAGE} conversations; an older open case cannot be ruled out`,
    );
  }
  return null;
}

// What `/contacts/:id/conversations` answers at most: the newest page, never older ones.
export const CONTACT_CONVERSATIONS_PAGE = 25;

// Pure: the private notes. PT-BR, like the webhook's other system notes.
export function originLinkNote(caseUrl: string, inboxName: string): string {
  return `➡️ Caso aberto na caixa ${inboxName}: ${caseUrl}`;
}
// Header of the opening that could not reach the customer: the destination channel only lets the
// business write first with an approved template, and a free-form message there is rejected.
export const OPENING_OUTSIDE_WINDOW_PREFIX =
  "⏳ Fora da janela de atendimento deste canal: a mensagem de abertura abaixo NÃO foi enviada ao cliente. " +
  "Para falar com ele por aqui, comece por um template aprovado (HSM).\n\n";

// WHO HOLDS THE CASE, read from the conversation Chatwoot answers with. `human` is a person assigned
// (`meta.assignee_type` "User"); an agent bot is NOT read from here on purpose, see `settleCaseOwner`.
type CaseOwnerUnread = "before_clear" | "before_team";

function caseOwner(conv: unknown): { human: boolean; teamId: number | null } {
  const meta = field(conv, "meta");
  const team = field(meta, "team");
  const teamId = Number(field(team, "id"));
  return {
    human: field(meta, "assignee_type") === "User",
    teamId: Number.isInteger(teamId) && teamId > 0 ? teamId : null,
  };
}

// A CASE NOBODY HOLDS IS NOT A CASE. It can land in a conversation an agent bot holds: one the
// destination's own agent left `pending` (continued, or this origin's known case), or a new one the
// inbox hands its bot on create. Opened, that agent no longer answers it, and the fork counts
// `assignee_agent_bot_id` as an owner, so no "open with no owner" routing rule matches it either.

// THE BOT IS NOT READ, IT IS CLEARED. An inbox's bot assignment can carry the id without the fork's
// `ai_assignee_type`, which the JSON shows as no assignee while every rule still sees an owner.
// `assignee_id: 0` on the assignments endpoint sets both the person and the bot to none.

// A PERSON on the case gets nothing written, the team neither: the fork drops an assignee who is not
// a member of a newly set team (`ensure_assignee_is_from_team`). A team already there stays, and the
// case is read again before the team is written, so an owner set during the clear is kept.

// Owner writes skip the withdrawal fence: a reset or takeover on the ORIGIN does not make an open case
// anyone's. A refused write goes to `partial`; a case that could not be read is returned instead,
// since nothing was attempted, and each reaches the flow log as its own warning.
async function settleCaseOwner(
  client: CaseClient,
  caseId: number,
  teamId: number | null,
  partial: string[],
): Promise<CaseOwnerUnread | null> {
  let owner: { human: boolean; teamId: number | null };
  try {
    owner = caseOwner(await client.getConversation(caseId));
  } catch {
    return "before_clear";
  }
  if (owner.human) return null;
  try {
    await client.unassignConversation(caseId, { asAdmin: true });
  } catch {
    partial.push("case_assignee");
  }
  if (teamId === null || owner.teamId !== null) return null;
  try {
    owner = caseOwner(await client.getConversation(caseId));
  } catch {
    return "before_team";
  }
  if (owner.human || owner.teamId !== null) return null;
  try {
    await client.assignTeam(caseId, teamId, { asAdmin: true });
  } catch {
    partial.push("case_team");
  }
  return null;
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
  const interpolate = input.interpolate ?? ((t: string) => t);

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
        const partial: string[] = [];
        const caseOwnerUnread = await settleCaseOwner(
          client,
          known,
          input.caseTeamId ?? null,
          partial,
        );
        // NOTE: what the model passed now is what the customer added since the case opened, and the case
        // is where the team reads it.
        if (!input.stillWanted || (await input.stillWanted())) {
          try {
            await client.sendMessageAsAdmin(
              known,
              renderCaseAddition(input.reason, client.conversationUrl(origin)),
              { private: true },
            );
          } catch {
            partial.push("destination_note");
          }
        } else {
          partial.push("called_off");
        }
        return {
          kind: "already_open",
          caseId: known,
          caseUrl: client.conversationUrl(known),
          identity: null,
          partial,
          ...(caseOwnerUnread ? { caseOwnerUnread } : {}),
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
        if (!(await customerTypedInConversation(client, origin, email))) {
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
      if (verdict === "failed") {
        return { kind: "failed", step: "guardrail_handoff", error: null };
      }
      if (verdict === "drop") {
        customerMessage = null;
        openingBlocked = true;
      }
    }
    // The subject heads every email of the case and carries the model's summary, so it passes the same
    // check. A refused one is dropped and the case opens under Chatwoot's default subject.
    let subject = needs === "email" ? (input.subject ?? null) : null;
    if (subject && input.screenCustomerMessage) {
      step = "screen_subject";
      const verdict = await input.screenCustomerMessage(subject);
      if (verdict === "handed") return { kind: "handed_by_policy" };
      if (verdict === "failed") {
        return { kind: "failed", step: "guardrail_handoff", error: null };
      }
      if (verdict === "drop") subject = null;
    }

    // One case contact at a time, from the listing to the opening message. The outer queue is per
    // ORIGIN, so two origins of one contact could both list before either creates and both send an
    // opening to the same continued case. Keyed by account, inbox and case contact, the second lists
    // after the first created and reads its case as continued.
    const caseKey = `cross-inbox-case-contact:${client.conversationUrl(0)}:${target}:${caseContactId}`;
    return await withKeyedQueue(caseKey, async (): Promise<OpenCaseResult> => {
      // 3. Open, or continue. Which of the two happened is read from the contact's conversations
      // BEFORE the call: the create answers with a conversation either way.
      // The list is the contact's newest 25 only, so a continued case can be missing from it. The
      // conversation number settles it: numbers come from one per-account sequence, so a conversation
      // the create made is numbered above every one that existed, and one at or below the newest the
      // contact already had is one it handed back.
      step = "list_case_conversations";
      let lookupFailed = false;
      const listed = await client.listContactConversations(caseContactId);
      const before = new Set(
        listed.filter((c) => c.inboxId === target).map((c) => c.id),
      );
      const newestBefore = listed.reduce((m, c) => Math.max(m, c.id), 0);
      // A case this contact already has open in the destination, opened by this tool from another
      // conversation (the channel opens a new one when the customer writes after the origin was
      // resolved). The addition goes to that case rather than to a second one.
      const caseAmong = (rows: typeof listed) =>
        rows
          .filter(
            (c) =>
              c.inboxId === target &&
              c.status !== "resolved" &&
              c.customAttributes?.[CROSS_INBOX_CASE_ORIGIN_ATTRIBUTE] != null,
          )
          .reduce<(typeof listed)[number] | null>(
            (best, c) => (best === null || c.id > best.id ? c : best),
            null,
          );
      let openCase = caseAmong(listed);
      // NOTE: a full listing can hide an older case, so the filter, which has no such cap, is asked. A
      // failed lookup falls back to opening a case, which is what the tool does without one.
      if (openCase === null && listed.length >= CONTACT_CONVERSATIONS_PAGE) {
        step = "find_open_case";
        try {
          openCase = caseAmong(
            await client.listUnresolvedContactConversations(
              caseContactId,
              target,
            ),
          );
        } catch {
          lookupFailed = true;
        }
      }
      // ASKED AGAIN, after the last wait and right before the write nothing undoes: the ask above sat
      // before the screening and this read, and a `/reset` or a withdrawal inside either of them must
      // not still open a case and send its opening.
      if (input.stillWanted && !(await input.stillWanted())) {
        return { kind: "called_off" };
      }
      step = openCase ? "append_to_case" : "create_conversation";
      const created =
        openCase ??
        (await client.createConversation({
          inboxId: target,
          contactId: caseContactId,
          // Open, not pending: the case lands in the team's queue, and an agent bound to the destination
          // inbox does not pick it up and triage it again (shouldBotHandle needs `pending`).
          status: "open",
          customAttributes: { [CROSS_INBOX_CASE_ORIGIN_ATTRIBUTE]: origin },
          ...(subject
            ? { additionalAttributes: { mail_subject: subject } }
            : {}),
        }));
      const caseId = created.id;
      const appended = openCase !== null;
      // An addition reads as continued too: a listed case is in `before`, and one only the filter finds
      // is older than every listed conversation, so its number is below `newestBefore`.
      const continued = before.has(caseId) || caseId <= newestBefore;
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
      const partial: string[] = lookupFailed ? ["open_case_lookup"] : [];
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
      const caseOwnerUnread = await settleCaseOwner(
        client,
        caseId,
        input.caseTeamId ?? null,
        partial,
      );
      // A continued case already has its opening: repeating it would send the customer a second
      // "we opened your case" email for the same case.
      // A channel with a reply window (official WhatsApp, Twilio on WhatsApp, an API inbox with one
      // set) refuses a free-form first message to a customer who has not written there lately, and a
      // new case has, by construction, no message from them. Chatwoot's own `can_reply` says so; the
      // opening then goes to the case as an explained note, the service-window fallback.
      let openingOutsideWindow = false;
      // The operator's template wraps the model's part, which was screened above: a refused part
      // discards the whole opening, and a template that needs the part sends nothing without it. A
      // fixed template (no message placeholder) is the operator's own text and always goes out.
      const openingTemplate = config.openingTemplate ?? null;
      let opening: string | null = null;
      if (openingTemplate === null) {
        opening = customerMessage;
      } else if (
        !openingBlocked &&
        (customerMessage || !openingAsksMessage(openingTemplate))
      ) {
        opening = renderCaseOpening(
          openingTemplate,
          customerMessage,
          caseId,
          interpolate,
        );
      }
      if (!continued && opening) {
        const text = opening;
        // Without a template the opening is the model's own text, escaped on the way out; with one,
        // `renderCaseOpening` escaped the model's part and the rest is the operator's.
        const ownOpening = openingTemplate === null;
        if (created.canReply === false) {
          openingOutsideWindow = true;
          await attempt("customer_message", () =>
            client.sendMessageAsAdmin(
              caseId,
              `${OPENING_OUTSIDE_WINDOW_PREFIX}${ownOpening ? literalForChatwoot(text) : text}`,
              { private: true },
            ),
          );
        } else {
          // The signer escapes the model's text itself and leaves the signature's Liquid alone.
          const signed = ownOpening
            ? (input.signCustomerMessage?.(text) ?? literalForChatwoot(text))
            : text;
          await attempt("customer_message", () =>
            client.sendMessageAsAdmin(caseId, signed, { private: false }),
          );
        }
      }
      // ONE note on the case, so the team reads it whole: the subject, where it came from, and why.
      await attempt("destination_note", () =>
        client.sendMessageAsAdmin(
          caseId,
          appended
            ? renderCaseAddition(input.reason, originUrl)
            : renderCaseNote(
                config.noteTemplate ?? null,
                { subject, reason: input.reason, originUrl },
                interpolate,
              ),
          { private: true },
        ),
      );
      await attempt("origin_link_note", () =>
        client.sendPrivateNote(origin, originLinkNote(caseUrl, inboxName)),
      );
      // Labels are a read-modify-write of the whole set, so both writes go through the shared
      // label queue and READ inside it (a new case included: an automation can label it after create).
      // The operator's labels are checked against the account, the model's are not: an unknown label
      // is stored as a tag no folder lists, so it is left off and reported. An unreadable catalog keeps
      // the label as configured, since it is what puts the case in the team's queue.
      let unknownCaseLabels: string[] = [];
      let caseLabels = config.caseLabels;
      if (caseLabels.length > 0) {
        try {
          const known = new Set(
            (await client.listLabels()).map((l) => l.toLowerCase()),
          );
          unknownCaseLabels = caseLabels.filter((l) => !known.has(l));
          caseLabels = caseLabels.filter((l) => known.has(l));
        } catch {
          // NOTE: catalog unread, applied as configured (above)
        }
      }
      const wanted = [...new Set([...caseLabels, ...input.labels])];
      if (wanted.length > 0) {
        await attempt("destination_labels", () =>
          withConversationLabels(input.tenantId, caseId, async () => {
            const current = await client.getConversationLabels(caseId);
            // Asked again after the queue's wait and the read: a reset queued ahead of this write clears
            // the labels and withdraws the turn, and this write must not put them back.
            if (await withdrawn()) return;
            // Only what is missing: a continued case that already carries every label is not written.
            const missing = wanted.filter((l) => !current.includes(l));
            if (missing.length === 0) return;
            await client.setConversationLabels(
              caseId,
              [...current, ...missing],
              {
                asAdmin: true,
              },
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
            await client.setConversationLabels(origin, [
              ...current,
              originLabel,
            ]);
          }),
        );
      }
      return {
        kind: appended ? "appended" : continued ? "continued" : "opened",
        caseId,
        caseUrl,
        identity,
        partial,
        ...(openingBlocked ? { openingBlocked } : {}),
        ...(openingOutsideWindow ? { openingOutsideWindow } : {}),
        ...(unknownCaseLabels.length > 0 ? { unknownCaseLabels } : {}),
        ...(caseOwnerUnread ? { caseOwnerUnread } : {}),
      };
    });
  } catch (error) {
    return { kind: "failed", step, error };
  }
}
