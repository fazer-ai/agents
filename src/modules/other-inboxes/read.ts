import { createHash } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import { overlayMediaAnnotations } from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { resetAckSendId } from "@/modules/chatwoot/constants";
import { instanceAgentBotChatwootIds } from "@/modules/chatwoot/instance";
import {
  buildQuoteResolver,
  type ChatwootMessageRow,
  chatwootMessageListLength,
  parseChatwootMessages,
  toRenderable,
} from "@/modules/chatwoot/messages";
import { providerReservesEchoIds } from "@/modules/chatwoot/normalize";
import {
  renderTranscript,
  TRANSCRIPT_MAX_CHARS,
  transcriptFromRows,
  usableRow,
} from "@/modules/chatwoot/transcript";

// One conversation of the contact in another inbox, read off Chatwoot: its public messages rendered
// with who wrote each line, the newest public message id, and whether the read reached the start of
// the conversation. Private notes, reactions and activity rows never enter it (`usableRow`).
export interface OtherConversationRead {
  transcript: string;
  // The newest public message, which is what a stored summary records as covered: a private note or
  // an activity row moves `last_activity_at` without changing what the summary describes.
  newestPublicId: number | null;
  // False when the page bound stopped the read before the first message: the transcript is then a
  // tail, and a tail is never handed to the turn as the whole conversation.
  complete: boolean;
  // What the newest public messages say: everything the renderer reads off each (text, subject,
  // transcription, descriptions, attachments). An edit or a late transcription keeps the message id,
  // so the newest id alone would not show it changed. `<hash as Chatwoot returned>:<id.hash of each
  // message the in-process annotations changed, comma-separated>`, read by `fingerprintMoved`.
  recentFingerprint: string;
  // The same read rendered under a smaller character budget, for a caller with a token budget.
  renderWithin: (maxChars: number) => string;
}

// Chatwoot's message page: twenty rows. A page that brings fewer holds the first message.
const CHATWOOT_MESSAGES_PAGE = 20;

// The newest public messages the fingerprint covers, where an edit or a late transcription lands.
const FINGERPRINT_ROWS = 10;

// Ten pages: two hundred rows, past which a conversation is summarized from its newest part.
export const OTHER_CONVERSATION_MAX_PAGES = 10;

export async function readOtherConversation(p: {
  client: ChatwootClient;
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  // The inbox's WhatsApp provider, which decides whether a paired-phone echo is a person.
  provider: string | null;
  // Stop paging once the rendered transcript is past this many characters: the caller only needs
  // to know the conversation is long. Null reads up to the page bound.
  stopAfterChars: number | null;
  // The reading agent's timezone, which each line's date is written in.
  timezone: string;
  // The conversation's `/reset` boundary, when it has one: everything at or below it, and the reset's
  // own acknowledgement, is an episode the operator withdrew, and no other inbox reads it either.
  resetAtMessageId: number | null;
  base?: PrismaClient;
  maxPages?: number;
}): Promise<OtherConversationRead> {
  const maxPages = p.maxPages ?? OTHER_CONVERSATION_MAX_PAGES;
  const ownBotIds = new Set(
    await instanceAgentBotChatwootIds(p.tenantId, p.instanceId, p.base),
  );
  const seen = new Map<number, ChatwootMessageRow>();
  let before: number | undefined;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const raw = await p.client.getMessages(
      p.conversationId,
      before === undefined ? undefined : { before },
    );
    const rows = parseChatwootMessages(raw);
    // NOTE: the parser folds a non-list body and a page of unreadable rows into a short page, which
    // below reads as the start of the conversation: a degraded page fails the read instead.
    if (chatwootMessageListLength(raw) !== rows.length) {
      throw new Error("other inboxes: a page of the conversation did not read");
    }
    let oldest: number | null = null;
    let added = 0;
    for (const r of rows) {
      if (oldest === null || r.id < oldest) oldest = r.id;
      if (withdrawn(r)) continue;
      if (!seen.has(r.id)) added += 1;
      seen.set(r.id, r);
    }
    // NOTE: a page reaching the reset boundary holds the start of what may be read.
    if (
      p.resetAtMessageId !== null &&
      oldest !== null &&
      oldest <= p.resetAtMessageId
    ) {
      complete = true;
      break;
    }
    if (
      added === 0 ||
      oldest === null ||
      rows.filter((r) => !r.isReaction).length < CHATWOOT_MESSAGES_PAGE
    ) {
      complete = true;
      break;
    }
    if (
      p.stopAfterChars !== null &&
      [...seen.values()].filter(usableRow).length >= FINGERPRINT_ROWS &&
      recentQuotesRead([...seen.values()]) &&
      render([...seen.values()]).length > p.stopAfterChars
    ) {
      break;
    }
    before = oldest;
  }
  const all = [...seen.values()];
  const fromChatwoot = fingerprint(all);
  const bare = rowHashes(all);
  overlayMediaAnnotations(p.tenantId, p.instanceId, all);
  const annotated = [...rowHashes(all)]
    .filter(([id, h]) => bare.get(id) !== h)
    .map(([id, h]) => `${id}.${h}`);
  const recentFingerprint = `${fromChatwoot}:${annotated.join(",")}`;
  let newestPublicId: number | null = null;
  for (const r of all) {
    if (usableRow(r) && (newestPublicId === null || r.id > newestPublicId)) {
      newestPublicId = r.id;
    }
  }
  return {
    transcript: render(all),
    newestPublicId,
    complete,
    recentFingerprint,
    renderWithin: (maxChars) =>
      render(all, Math.min(maxChars, TRANSCRIPT_MAX_CHARS)),
  };

  function withdrawn(r: ChatwootMessageRow): boolean {
    const reset = p.resetAtMessageId;
    return (
      reset !== null && (r.id <= reset || r.sendId === resetAckSendId(reset))
    );
  }

  function render(
    rows: ChatwootMessageRow[],
    maxChars: number = TRANSCRIPT_MAX_CHARS,
  ): string {
    return renderTranscript(
      transcriptFromRows(rows, rows.length, {
        ownBotIds,
        trustPhoneEcho: providerReservesEchoIds(p.provider),
        dated: true,
      }),
      maxChars,
      p.timezone,
    );
  }
}

// Whether what a summary covered changed since. Chatwoot's own content changing always counts. The
// in-process annotations (on an upstream Chatwoot, the only place a late transcription exists) count
// only while present: one appearing is new content, one expiring after its fifteen minutes or with a
// restart is the same message read with less, and rewriting the summary from it would lose words.
// Per message, so one annotation of several expiring is not read as new content: only an annotation
// present now that the summary did not cover moves it.
export function fingerprintMoved(covered: string, current: string): boolean {
  const [coveredBase = "", coveredNotes = ""] = covered.split(":");
  const [currentBase = "", currentNotes = ""] = current.split(":");
  if (currentBase !== coveredBase) return true;
  const had = new Set(coveredNotes.split(",").filter(Boolean));
  return currentNotes
    .split(",")
    .filter(Boolean)
    .some((n) => !had.has(n));
}

// Whether a message the summary covered with an annotation is now read without one: the summary then
// holds words this read cannot show. Per message id and regardless of what else moved, so a newer
// message arriving after the expiry does not hide it.
export function annotationsLost(covered: string, current: string): boolean {
  const ids = (notes: string) =>
    new Set(
      notes
        .split(",")
        .filter(Boolean)
        .map((n) => n.split(".")[0]),
    );
  const had = ids(covered.split(":")[1] ?? "");
  const now = ids(current.split(":")[1] ?? "");
  for (const id of had) if (!now.has(id)) return true;
  return false;
}

function newestPublic(rows: ChatwootMessageRow[]): ChatwootMessageRow[] {
  return rows
    .filter(usableRow)
    .sort((a, b) => b.id - a.id)
    .slice(0, FINGERPRINT_ROWS);
}

// Whether every message the newest public ones quote was read: a reply renders with the text it
// quotes, so a read may stop early only once those are in it, or the fingerprint of a short read
// would differ from the job's full one (the observer's `quotesResolved`, over the same rows).
function recentQuotesRead(rows: ChatwootMessageRow[]): boolean {
  const ids = new Set(rows.map((r) => r.id));
  return newestPublic(rows).every(
    (r) => r.inReplyTo === null || ids.has(r.inReplyTo),
  );
}

// Each public message read, as it renders, so the annotations can be told apart per message. Over
// every row read and not only the newest: a voice note ten messages back is in the transcript too, and
// its annotation expiring is what `annotationsLost` has to see. A read that stopped early holds fewer
// of them, which `fingerprintMoved` reads as nothing new, and `annotationsLost` is only asked of a
// complete read.
function rowHashes(rows: ChatwootMessageRow[]): Map<number, string> {
  const quoted = buildQuoteResolver(rows.filter(usableRow));
  return new Map(
    rows.filter(usableRow).map((r) => [
      r.id,
      createHash("sha256")
        .update(
          JSON.stringify([
            toRenderable(r),
            r.inReplyTo === null ? null : quoted(r.inReplyTo),
          ]),
        )
        .digest("hex"),
    ]),
  );
}

// Over the newest public messages only, which every read holds whatever its threshold (a read stops
// early only once it has them): a fingerprint over all rows would differ between a read that stopped
// early and one that did not, and one over a page of raw rows would move with every private note.
function fingerprint(rows: ChatwootMessageRow[]): string {
  const quoted = buildQuoteResolver(rows.filter(usableRow));
  const page = newestPublic(rows).map((r) => [
    r.id,
    toRenderable(r),
    r.inReplyTo === null ? null : quoted(r.inReplyTo),
  ]);
  return createHash("sha256").update(JSON.stringify(page)).digest("hex");
}
