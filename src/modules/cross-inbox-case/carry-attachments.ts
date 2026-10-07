// Carrying the customer's files into the case (`crossInboxCase.carryAttachments`). The case note
// summarises, and a summary of a document is not the document. The scope is the operator's setting,
// never the model's choice: a model picking which files matter can drop the one that did.
//
// Best effort, like every write after the case exists: a file that cannot be read or posted never
// fails or delays the case, and the model's tool result does not change. What happened is counted and
// reported on the flow log by the caller.

import { withKeyedQueue } from "@/lib/locks";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import {
  CARRIED_IDS_KEPT,
  CARRY_MAX_FILE_BYTES,
  type CarryAttachmentsConfig,
  CROSS_INBOX_CASE_CARRIED_ATTRIBUTE,
} from "./carry-attachments-settings";

export type CarryClient = Pick<
  ChatwootClient,
  | "conversationUrl"
  | "getConversation"
  | "getMessages"
  | "isInstanceUrl"
  | "downloadAttachment"
  | "sendFilesAsAdmin"
  | "sendMessageAsAdmin"
  | "setConversationCustomAttributes"
>;

export interface CarryInput {
  config: CarryAttachmentsConfig;
  originConversationId: number;
  // The origin's contact: only files THEY sent are carried. Null ⇒ any contact sender.
  originContactId: number | null;
  caseId: number;
  // When the origin's current attendance started, as memory compaction cuts the thread. Null ⇒ the
  // whole conversation is the current attendance. Asked only under `attendance`.
  attendanceStartedAt?: () => Promise<Date | null>;
  // The per-file ceiling. Absent ⇒ CARRY_MAX_FILE_BYTES.
  maxFileBytes?: number;
  stillWanted?: () => Promise<boolean>;
}

export interface CarryOutcome {
  carried: number;
  // Eligible files left out on purpose: past `maxFiles`, over the size ceiling, or not on the
  // instance's own host.
  skipped: number;
  failed: number;
  // Why nothing was attempted, when that is the answer: the attendance boundary or the case could not
  // be read, or the run was called off before the note.
  unread?: "attendance" | "case";
  calledOff?: boolean;
  // The walk stopped at its page limit, so older files were never seen.
  truncated?: boolean;
}

interface Candidate {
  attachmentId: number;
  messageId: number;
  dataUrl: string;
  fileSize: number | null;
  fileName: string;
}

// Chatwoot answers 20 messages a page, newest first.
const MESSAGES_PAGE = 20;
// A thousand messages back, the same reach the email check of the case walks.
const MAX_PAGES = 50;

function rows(page: unknown): Record<string, unknown>[] {
  const payload =
    page && typeof page === "object"
      ? (page as { payload?: unknown }).payload
      : undefined;
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (m): m is Record<string, unknown> => !!m && typeof m === "object",
  );
}

// The REST row's sender as a contact: `sender_type` on the message, or `sender.type` on the embedded
// sender. Anything that does not say "contact" is not the customer.
function contactSender(m: Record<string, unknown>): {
  contact: boolean;
  id: number | null;
} {
  const sender =
    m.sender && typeof m.sender === "object"
      ? (m.sender as Record<string, unknown>)
      : null;
  const type = String(m.sender_type ?? sender?.type ?? "").toLowerCase();
  const id = Number(m.sender_id ?? sender?.id);
  return {
    contact: type === "contact",
    id: Number.isInteger(id) && id > 0 ? id : null,
  };
}

function fileNameOf(dataUrl: string, fallback: string): string {
  const path = dataUrl.split("?")[0] ?? dataUrl;
  try {
    const name = decodeURIComponent(
      path.slice(path.lastIndexOf("/") + 1),
    ).trim();
    return name || fallback;
  } catch {
    return fallback;
  }
}

function carriedIds(conv: unknown): Map<number, string> {
  const attrs =
    conv && typeof conv === "object"
      ? (conv as { custom_attributes?: unknown }).custom_attributes
      : undefined;
  const raw =
    attrs && typeof attrs === "object"
      ? (attrs as Record<string, unknown>)[CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]
      : undefined;
  const out = new Map<number, string>();
  for (const part of String(raw ?? "").split(",")) {
    const entry = part.trim();
    const n = Number(entry.slice(entry.indexOf(":") + 1));
    if (Number.isInteger(n) && n > 0) out.set(n, entry);
  }
  return out;
}

// Every message of the origin, walking it back page by page. `complete` is false when the page limit
// ended the walk before the conversation did.
async function originRows(
  client: CarryClient,
  conversationId: number,
): Promise<{ rows: Record<string, unknown>[]; complete: boolean }> {
  const seen = new Map<number, Record<string, unknown>>();
  let before: number | undefined;
  let complete = false;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page = rows(
      await client.getMessages(
        conversationId,
        before == null ? undefined : { before },
      ),
    );
    for (const m of page) {
      const id = Number(m.id);
      if (Number.isFinite(id)) seen.set(id, m);
    }
    complete = true;
    if (page.length < MESSAGES_PAGE) break;
    // The cursor is the page's EARLIEST message, by time and then id: Chatwoot pages on that pair, and
    // an imported message has an old date under a new id, so the smallest id is not the page's end.
    let oldest: { at: number; id: number } | null = null;
    for (const m of page) {
      const id = Number(m.id);
      const at = Number(m.created_at);
      if (!Number.isFinite(id) || !Number.isFinite(at)) continue;
      if (!oldest || at < oldest.at || (at === oldest.at && id < oldest.id))
        oldest = { at, id };
    }
    if (!oldest || oldest.id === before) break;
    before = oldest.id;
    complete = false;
  }
  return { rows: [...seen.values()], complete };
}

function isContactIncoming(m: Record<string, unknown>): boolean {
  return (
    (m.message_type === 0 || m.message_type === "incoming") &&
    m.private !== true &&
    contactSender(m).contact
  );
}

function isImported(m: Record<string, unknown>): boolean {
  const ca = m.content_attributes;
  return (
    !!ca &&
    typeof ca === "object" &&
    (ca as Record<string, unknown>).imported === true
  );
}

// Where the attendance starts in the origin's own timeline. A turn is stamped with the NEWEST message
// of the customer's burst, so the contact's messages right before it, with no public answer between,
// are the same burst and start the attendance with it. Private notes and activity rows do not end a
// burst; imported messages are not the timeline.
function attendanceSince(
  all: Record<string, unknown>[],
  since: number,
): number {
  const timeline = all
    .filter((m) => !isImported(m))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const first = timeline.findIndex((m) => Number(m.created_at) >= since);
  let start = since;
  for (let i = first - 1; first > 0 && i >= 0; i -= 1) {
    const m = timeline[i];
    if (!m) break;
    if (
      m.private === true ||
      m.message_type === 2 ||
      m.message_type === "activity"
    )
      continue;
    if (!isContactIncoming(m)) break;
    const at = Number(m.created_at);
    if (Number.isFinite(at)) start = Math.min(start, at);
  }
  return start;
}

// The files the contact sent, newest first by when they were sent (an imported message carries an old
// date under a new id, so the id does not order them). Under `attendance`, only those since the
// attendance started.
async function candidatesOf(
  client: CarryClient,
  input: CarryInput,
  boundary: Date | null,
): Promise<{ found: Candidate[]; complete: boolean }> {
  const types = new Set<string>(input.config.fileTypes);
  const { rows: all, complete } = await originRows(
    client,
    input.originConversationId,
  );
  // Chatwoot dates a message to the second.
  const since = boundary
    ? attendanceSince(all, Math.floor(boundary.getTime() / 1000))
    : null;
  const newestFirst = all
    .map((m) => ({ m, at: Number(m.created_at), id: Number(m.id) }))
    .sort((x, y) => (y.at || 0) - (x.at || 0) || y.id - x.id);
  const out: Candidate[] = [];
  for (const { m, at } of newestFirst) {
    if (since !== null && Number.isFinite(at) && at < since) continue;
    if (!isContactIncoming(m)) continue;
    if (
      input.originContactId !== null &&
      contactSender(m).id !== input.originContactId
    )
      continue;
    const messageId = Number(m.id);
    const attachments = Array.isArray(m.attachments) ? m.attachments : [];
    // Within one message, the last file is the newest, so the order is reversed with the rest.
    for (let i = attachments.length - 1; i >= 0; i -= 1) {
      const a = attachments[i] as Record<string, unknown> | null;
      if (!a || typeof a !== "object") continue;
      const id = Number(a.id);
      const dataUrl = typeof a.data_url === "string" ? a.data_url : "";
      const type = typeof a.file_type === "string" ? a.file_type : "";
      if (!Number.isInteger(id) || id <= 0 || !dataUrl || !types.has(type))
        continue;
      const size = Number(a.file_size);
      out.push({
        attachmentId: id,
        messageId,
        dataUrl,
        fileSize: Number.isFinite(size) && size >= 0 ? size : null,
        fileName: fileNameOf(dataUrl, `anexo-${id}`),
      });
    }
  }
  return { found: out, complete };
}

// PT-BR, like the case's other system notes.
export function renderCarryCaption(p: {
  carried: number;
  skipped: number;
  failed: number;
  originUrl: string;
}): string {
  const total = p.carried + p.skipped + p.failed;
  const count =
    total === p.carried ? `${p.carried}` : `${p.carried} de ${total}`;
  const lines = [
    `📎 Anexos enviados pelo cliente na conversa de origem (${count}): [ver conversa](${p.originUrl})`,
  ];
  if (p.skipped > 0) {
    lines.push(
      p.skipped === 1
        ? "1 anexo ficou de fora (limite de quantidade ou de tamanho)."
        : `${p.skipped} anexos ficaram de fora (limite de quantidade ou de tamanho).`,
    );
  }
  if (p.failed > 0) {
    lines.push(
      p.failed === 1
        ? "⚠️ 1 anexo não pôde ser copiado; veja a conversa de origem."
        : `⚠️ ${p.failed} anexos não puderam ser copiados; veja a conversa de origem.`,
    );
  }
  return lines.join("\n\n");
}

// Carries the contact's files from the origin into the case, as ONE private note after the case's own
// note. Null when the block is off: nothing is read and nothing is written.
export async function carryCaseAttachments(
  client: CarryClient,
  input: CarryInput,
): Promise<CarryOutcome | null> {
  if (input.config.mode === "off") return null;
  // ONE CARRY PER CASE AT A TIME. Two origins can feed the same case (a contact's case reached from a
  // second conversation), and each reads the case's record, posts, and writes the record back: run
  // side by side, the second write would drop the first one's entries and its files would be posted
  // again on the next call. Serialized, the second reads what the first recorded.
  return withKeyedQueue(
    `cross-inbox-case-carry:${client.conversationUrl(input.caseId)}`,
    () => carryLocked(client, input),
  );
}

async function carryLocked(
  client: CarryClient,
  input: CarryInput,
): Promise<CarryOutcome> {
  const { config } = input;
  const outcome: CarryOutcome = { carried: 0, skipped: 0, failed: 0 };

  let boundary: Date | null = null;
  if (config.mode === "attendance" && input.attendanceStartedAt) {
    try {
      boundary = await input.attendanceStartedAt();
    } catch {
      // NOTE: an attendance that cannot be read is not widened to the whole conversation: the operator
      // chose the narrower scope, so nothing is carried and the caller reports why.
      return { ...outcome, unread: "attendance" };
    }
  }

  let done: Map<number, string>;
  try {
    done = carriedIds(await client.getConversation(input.caseId));
  } catch {
    // NOTE: without the record of what the case already has, carrying could post the same files twice.
    return { ...outcome, unread: "case" };
  }

  let found: Candidate[];
  try {
    const walked = await candidatesOf(client, input, boundary);
    found = walked.found;
    if (!walked.complete) outcome.truncated = true;
  } catch {
    return { ...outcome, unread: "case" };
  }
  // The limit is the case's newest files, not the newest of those not yet carried: a file it left out
  // stays out, instead of draining in on the next call.
  const chosen = found
    .slice(0, config.maxFiles)
    .filter((c) => !done.has(c.attachmentId));
  if (chosen.length === 0) return outcome;
  outcome.skipped += found
    .slice(config.maxFiles)
    .filter((c) => !done.has(c.attachmentId)).length;
  const ceiling = input.maxFileBytes ?? CARRY_MAX_FILE_BYTES;
  const files: Array<{
    candidate: Candidate;
    bytes: ArrayBuffer;
    mime: string;
  }> = [];
  // Oldest first in the note, the order the customer sent them.
  for (const c of [...chosen].reverse()) {
    // Only the instance's own files are fetched: the URL comes from the message, and a file elsewhere
    // is neither requested nor sent the instance's credentials.
    if (!client.isInstanceUrl(c.dataUrl)) {
      outcome.skipped += 1;
      continue;
    }
    if (c.fileSize !== null && c.fileSize > ceiling) {
      outcome.skipped += 1;
      continue;
    }
    try {
      const got = await client.downloadAttachment(c.dataUrl);
      if (got.bytes.byteLength > ceiling) {
        outcome.skipped += 1;
        continue;
      }
      files.push({
        candidate: c,
        bytes: got.bytes,
        mime:
          got.contentType?.split(";")[0]?.trim() || "application/octet-stream",
      });
    } catch (err) {
      if (err instanceof ChatwootApiError && err.status === 413) {
        outcome.skipped += 1;
      } else {
        outcome.failed += 1;
      }
    }
  }

  if (input.stillWanted && !(await input.stillWanted())) {
    return { carried: 0, skipped: 0, failed: 0, calledOff: true };
  }

  const originUrl = client.conversationUrl(input.originConversationId);
  let posted = false;
  if (files.length > 0) {
    try {
      await client.sendFilesAsAdmin(
        input.caseId,
        files.map((f) => ({
          bytes: f.bytes,
          fileName: f.candidate.fileName,
          mime: f.mime,
        })),
        {
          private: true,
          content: renderCarryCaption({
            carried: files.length,
            skipped: outcome.skipped,
            failed: outcome.failed,
            originUrl,
          }),
        },
      );
      outcome.carried = files.length;
      posted = true;
    } catch {
      outcome.failed += files.length;
    }
  }
  // Nothing made it into a note with files, but something failed: the team still learns there were
  // files, and where to see them. Asked again first: the upload was a wait, and a run withdrawn during
  // it writes nothing more.
  if (
    !posted &&
    outcome.failed > 0 &&
    !(input.stillWanted && !(await input.stillWanted()))
  ) {
    try {
      await client.sendMessageAsAdmin(
        input.caseId,
        renderCarryCaption({
          carried: 0,
          skipped: outcome.skipped,
          failed: outcome.failed,
          originUrl,
        }),
        { private: true },
      );
    } catch {
      // NOTE: the flow log still carries the count
    }
  }
  if (posted) {
    const ids = [
      ...done.values(),
      ...files.map(
        (f) => `${f.candidate.messageId}:${f.candidate.attachmentId}`,
      ),
    ].slice(-CARRIED_IDS_KEPT);
    try {
      await client.setConversationCustomAttributes(
        input.caseId,
        { [CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]: ids.join(",") },
        { asAdmin: true },
      );
    } catch {
      // NOTE: the files are on the case; a lost record only means a later call may carry them again
    }
  }
  return outcome;
}
