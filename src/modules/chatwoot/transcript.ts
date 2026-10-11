// The transcript of a Chatwoot conversation read off its message rows, with each outgoing line named
// by who wrote it. The monitoring agent reads it as its evidence (src/modules/observe/job.ts), and a
// turn reads it for the contact's conversations in other inboxes (src/modules/other-inboxes/).

import { formatParts, partsInTimezone } from "@/graph/time";
import { clipTextEnd } from "@/lib/text";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  buildQuoteResolver,
  type ChatwootMessageRow,
  parseChatwootMessages,
  toRenderable,
} from "@/modules/chatwoot/messages";
import {
  renderAttendantMessage,
  renderInboundMessage,
} from "@/modules/chatwoot/render";

export const TRANSCRIPT_MAX_CHARS = 40_000;
// What stands in for the start of a message the window had no room for.
const CUT_MARK = "[…]";

// Every block tag the prompt fences. `notas-internas` is written by people (a pasted prompt, a
// quoted customer) and `mudancas-de-etiqueta` wraps labels the model wrote (Chatwoot's tag list
// accepts what the catalog refuses), so a closing tag can arrive inside either and end it early.
const FENCE_TAG =
  /<\s*\/?\s*(transcricao|etiquetas-atuais|notas-internas|mudancas-de-etiqueta)[^>]*>/gi;

// A ROW THE TRANSCRIPT CAN USE. Factored out of `transcriptFromRows` so the paging below counts the
// same thing the window measures: private notes, reactions and activity rows are not messages.
export function usableRow(m: ChatwootMessageRow): boolean {
  return (
    !m.private &&
    !m.isReaction &&
    (m.messageType === "incoming" ||
      m.messageType === "outgoing" ||
      // NOTE: a TEMPLATE IS THE ATTENDANT SPEAKING: Chatwoot files a customer-facing template send
      // under its own `message_type`, and without it a terse "sim" reaches the model without its
      // question. Activity lines stay out: they are the system narrating.
      m.messageType === "template")
  );
}

// PAGED BACKWARDS UNTIL THE WINDOW IS FULL: one read is Chatwoot's newest page (about twenty RAW
// rows, fewer usable), and the monitoring window goes to sixty. `before` walks older (the fork's
// MessageFinder honours it). BOUNDED: five pages cover that window's own ceiling, and a page adding
// no older row is the start of the conversation.
const DEFAULT_MAX_PAGES = 5;
// Chatwoot's message page: twenty rows, reactions aside (the fork's MessageFinder adds a window's
// reactions on top of its twenty, upstream has none). A page that brings FEWER holds the first
// message of the conversation, so there is nothing older to ask for, and asking costs a request on
// every tick of every conversation still shorter than a page.
const CHATWOOT_MESSAGES_PAGE = 20;

export async function readWindowRows(
  client: ChatwootClient,
  conversationId: number,
  want: number,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<ChatwootMessageRow[]> {
  const seen = new Map<number, ChatwootMessageRow>();
  let before: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const rows = parseChatwootMessages(
      await client.getMessages(
        conversationId,
        before === undefined ? undefined : { before },
      ),
    );
    let oldest: number | null = null;
    let added = 0;
    for (const r of rows) {
      if (!seen.has(r.id)) added += 1;
      seen.set(r.id, r);
      if (oldest === null || r.id < oldest) oldest = r.id;
    }
    // Nothing older came back: this is the start of the conversation, whatever the window asked for.
    if (added === 0 || oldest === null) break;
    // ...and so is a page Chatwoot did not fill.
    if (rows.filter((r) => !r.isReaction).length < CHATWOOT_MESSAGES_PAGE) {
      break;
    }
    let usable = 0;
    for (const r of seen.values()) if (usableRow(r)) usable += 1;
    // NOTE: ...AND THE MESSAGES THE WINDOW QUOTES: a reply can quote something on an older page,
    // and a "sim" without its question is what the quote resolver exists for. Only rendered rows
    // are asked about, within the same page bound.
    if (usable >= want && quotesResolved(seen, want)) break;
    before = oldest;
  }
  return [...seen.values()];
}

// Whether every quote the rendered window points at is already fetched. The window is the newest
// `want` usable rows, the same slice `transcriptFromRows` renders.
function quotesResolved(
  seen: Map<number, ChatwootMessageRow>,
  want: number,
): boolean {
  const window = [...seen.values()]
    .filter(usableRow)
    .sort((a, b) => a.id - b.id)
    .slice(-want);
  for (const r of window)
    if (r.inReplyTo !== null && !seen.has(r.inReplyTo)) return false;
  return true;
}

// The fence tags the renderers wrap machine-written text in (a transcription, an image
// description): stripped so a transcript line reads as the message, not as its markup.
export function stripFences(text: string): string {
  return text.replace(FENCE_TAG, "");
}

export interface TranscriptLine {
  // `assistant` is an AI agent of this instance, `person` someone on the team, and `attendant` an
  // outgoing message nobody can be named for (imported history, an automation, another bot).
  role: "customer" | "assistant" | "person" | "attendant";
  text: string;
  // When the message was written, kept only for a reader that renders it (`dated`).
  at?: Date | null;
}

const ROLE_LABEL: Record<TranscriptLine["role"], string> = {
  customer: "Cliente",
  assistant: "Assistente virtual",
  person: "Atendente (pessoa)",
  attendant: "Atendente",
};

// Who wrote an outgoing message, from what Chatwoot and the platform recorded on it. Imported
// history first: its sender is whoever ran the import, not who wrote the words.
function outgoingRole(
  m: ChatwootMessageRow,
  ownBotIds: ReadonlySet<number>,
  trustPhoneEcho: boolean,
): TranscriptLine["role"] {
  if (m.imported) return "attendant";
  if (m.platformSent === true) return "assistant";
  if (m.senderType === "agent_bot")
    return m.senderId !== null && ownBotIds.has(m.senderId)
      ? "assistant"
      : "attendant";
  if (m.senderType === "user") return "person";
  // A paired-phone reply is a person only where the provider reserves its echo ids: elsewhere a lost
  // send response comes back as the same sender-less, marked echo of our own reply.
  if (m.externalSenderName && trustPhoneEcho) return "person";
  return "attendant";
}

// The newest `limit` public messages of the conversation, oldest first, rendered per direction the
// way the turn and the memory render them (so a transcription or an image description is read).
export function transcriptFromRows(
  rows: ChatwootMessageRow[],
  limit: number,
  // The Chatwoot agent bot ids this instance provisioned, every agent's and not only the observer's.
  // `dated` keeps each message's own time, for a reader with no other clock for a relative word.
  opts: {
    ownBotIds?: ReadonlySet<number>;
    trustPhoneEcho?: boolean;
    dated?: boolean;
  } = {},
): TranscriptLine[] {
  const ownBotIds = opts.ownBotIds ?? new Set<number>();
  const trustPhoneEcho = opts.trustPhoneEcho === true;
  // Built from every PUBLIC row fetched, not from the windowed slice: a reply inside the window can
  // quote a message older than it, and the quote is then the only thing that says what it is about.
  // What stays out of the lines stays out of the quotes: a private note, a reaction, an activity row.
  const resolveQuoted = buildQuoteResolver(rows.filter(usableRow));
  const usable = rows
    .filter(usableRow)
    .sort((a, b) => a.id - b.id)
    .slice(-limit);
  const out: TranscriptLine[] = [];
  for (const m of usable) {
    const text =
      m.messageType === "incoming"
        ? renderInboundMessage(
            // NOTE: `toRenderable`, not spelled here, so an email's subject reaches the observer as
            // it reaches the turn and the memory fold (a subject-only email is not a blank line).
            toRenderable(m),
            // NOTE: WHAT A REPLY IS ANSWERING, resolved off the rows the window fetched (as the
            // debounce path does), so a quoted "sim" reaches the model with the demand it answers.
            // The observer audience drops the requests aimed at the responder from every marker.
            { resolveQuoted, audience: "observer" },
          )
        : renderAttendantMessage({
            text: m.content,
            attachmentTypes: m.attachmentTypes,
            // Filled by `overlayMediaAnnotations` above for a reply this process just spoke, and by
            // the attachment's own meta on the fork.
            transcribedText: m.transcribedText,
          });
    const clean = stripFences(text).trim();
    if (!clean) continue;
    out.push({
      role:
        m.messageType === "incoming"
          ? "customer"
          : outgoingRole(m, ownBotIds, trustPhoneEcho),
      text: clean,
      ...(opts.dated ? { at: m.createdAt ?? null } : {}),
    });
  }
  return out;
}

// Kept from the newest message back, within `maxChars`. The budget is spent per MESSAGE, not on the
// joined text: a cut inside the joined text lands mid-message, and the oldest line kept then starts
// with no label (or, in a multi-line message, as a bare continuation line), so the model reads words
// it cannot attribute. The message the budget runs out on keeps its label and says it was cut.
// With a timezone, a dated line is prefixed with its local date and time: a "hoje" written weeks ago
// is read against the day it was written, not the day it is read.
export function renderTranscript(
  lines: readonly TranscriptLine[],
  maxChars: number = TRANSCRIPT_MAX_CHARS,
  timezone?: string,
): string {
  const kept: string[] = [];
  let room = maxChars;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as TranscriptLine;
    const sep = kept.length > 0 ? 1 : 0;
    const when =
      timezone && l.at
        ? `[${formatParts(partsInTimezone(l.at, timezone), "DD/MM/YYYY HH:mm")}] `
        : "";
    const label = `${when}${ROLE_LABEL[l.role]}: `;
    const line = `${label}${l.text}`;
    if (line.length + sep <= room) {
      kept.unshift(line);
      room -= line.length + sep;
      continue;
    }
    const prefix = `${label}${CUT_MARK} `;
    const tail = room - sep - prefix.length;
    if (tail > 0) kept.unshift(prefix + clipTextEnd(l.text, tail));
    break;
  }
  return kept.join("\n");
}
