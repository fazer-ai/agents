// Carrying the customer's files into the case (`crossInboxCase.carryAttachments`). The case opens
// with a note that SUMMARISES the conversation, and a summary of a document is not the document: the
// person who works the case in the destination inbox would otherwise have to follow the link back, or
// ask the customer to send again what they already sent. The scope is the operator's setting, applied
// the same way every time, and never the model's choice: a model picking which files matter adds a
// way to drop the one that did, to save a few kilobytes.
//
// Best effort, like every write after the case exists: a file that cannot be read or posted never
// fails or delays the case, and the model's tool result does not change. What happened is counted and
// reported on the flow log by the caller.

import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";

export const CARRY_FILE_TYPES = ["image", "file", "audio", "video"] as const;
export type CarryFileType = (typeof CARRY_FILE_TYPES)[number];
export const CARRY_MODES = ["off", "attendance", "conversation"] as const;
export type CarryMode = (typeof CARRY_MODES)[number];

export interface CarryAttachmentsConfig {
  // off: nothing is carried. attendance: the files of the origin's current attendance, cut where
  // memory compaction cuts it. conversation: every file the contact sent in the origin conversation.
  mode: CarryMode;
  fileTypes: CarryFileType[];
  // The newest N win when there are more; the rest are counted as left out.
  maxFiles: number;
}

export const CARRY_ATTACHMENTS_MAX_FILES = 20;
export const CARRY_ATTACHMENTS_DEFAULTS: CarryAttachmentsConfig = {
  mode: "off",
  fileTypes: ["image", "file"],
  maxFiles: 10,
};

// The case's attribute that remembers which of the origin's attachments it already received, so a
// reused or continued case gets only what is new. Fixed, like the origin attribute: it is read on the
// case, by whichever agent opens or continues it, without reading that agent's settings. One entry per
// FILE, `<message id>:<attachment id>`: the message says where it came from, and the attachment is
// what is deduplicated, because one message can carry several files and one of them can fail, and
// the failed one is then tried again on the next call instead of being marked done with its siblings.
export const CROSS_INBOX_CASE_CARRIED_ATTRIBUTE = "carried_attachment_ids";
// How many ids the attribute keeps, newest last. A case is not carried thousands of files; the cap
// only keeps a pathological one from growing the attribute without end.
const CARRIED_IDS_KEPT = 500;

// Chatwoot's own default upload ceiling is 40 MB, and the download refuses past 25 MB
// (client.ts MAX_ATTACHMENT_BYTES), so the lower of the two decides what can make the trip.
export const CARRY_MAX_FILE_BYTES = 25 * 1024 * 1024;

export function readCarryAttachments(v: unknown): CarryAttachmentsConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return {
      ...CARRY_ATTACHMENTS_DEFAULTS,
      fileTypes: [...CARRY_ATTACHMENTS_DEFAULTS.fileTypes],
    };
  }
  const o = v as Record<string, unknown>;
  const mode = (CARRY_MODES as readonly unknown[]).includes(o.mode)
    ? (o.mode as CarryMode)
    : CARRY_ATTACHMENTS_DEFAULTS.mode;
  const types: CarryFileType[] = [];
  if (Array.isArray(o.fileTypes)) {
    for (const t of o.fileTypes) {
      const name = typeof t === "string" ? t.trim().toLowerCase() : "";
      if (
        (CARRY_FILE_TYPES as readonly string[]).includes(name) &&
        !types.includes(name as CarryFileType)
      ) {
        types.push(name as CarryFileType);
      }
    }
  }
  const raw =
    typeof o.maxFiles === "string" && o.maxFiles.trim() !== ""
      ? Number(o.maxFiles)
      : o.maxFiles;
  const maxFiles =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.min(CARRY_ATTACHMENTS_MAX_FILES, Math.max(1, Math.round(raw)))
      : CARRY_ATTACHMENTS_DEFAULTS.maxFiles;
  return {
    mode,
    // An empty list (or one with nothing known in it) carries nothing, which is what `off` is for, so
    // it reads as the default rather than as a second way to switch the block off.
    fileTypes:
      types.length > 0 ? types : [...CARRY_ATTACHMENTS_DEFAULTS.fileTypes],
    maxFiles,
  };
}

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
  // When the origin's current attendance started, as memory compaction cut it. Null ⇒ the whole
  // conversation is the current attendance (it was never compacted). Asked only under `attendance`.
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

// The files the contact sent, newest first, walking the origin back page by page. Under
// `attendance`, the walk stops at the first message at or before the boundary.
async function candidatesOf(
  client: CarryClient,
  input: CarryInput,
  boundary: Date | null,
): Promise<Candidate[]> {
  const types = new Set<string>(input.config.fileTypes);
  const since = boundary ? boundary.getTime() / 1000 : null;
  const out: Candidate[] = [];
  let before: number | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page = rows(
      await client.getMessages(
        input.originConversationId,
        before == null ? undefined : { before },
      ),
    );
    let reachedBoundary = false;
    // Newest first, whatever order the page came in.
    const sorted = [...page].sort((a, b) => Number(b.id) - Number(a.id));
    for (const m of sorted) {
      const createdAt = Number(m.created_at);
      if (since !== null && Number.isFinite(createdAt) && createdAt <= since) {
        reachedBoundary = true;
        continue;
      }
      if (m.message_type !== 0 && m.message_type !== "incoming") continue;
      if (m.private === true) continue;
      const sender = contactSender(m);
      if (!sender.contact) continue;
      if (input.originContactId !== null && sender.id !== input.originContactId)
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
    if (reachedBoundary || page.length < MESSAGES_PAGE) break;
    const ids = page
      .map((m) => Number(m.id))
      .filter((id) => Number.isFinite(id));
    if (ids.length === 0) break;
    const oldest = Math.min(...ids);
    if (before != null && oldest >= before) break;
    before = oldest;
  }
  return out;
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
  const { config } = input;
  if (config.mode === "off") return null;
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
    found = await candidatesOf(client, input, boundary);
  } catch {
    return { ...outcome, unread: "case" };
  }
  const fresh = found.filter((c) => !done.has(c.attachmentId));
  if (fresh.length === 0) return outcome;

  const chosen = fresh.slice(0, config.maxFiles);
  outcome.skipped += fresh.length - chosen.length;
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
  // files, and where to see them.
  if (!posted && outcome.failed > 0) {
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
