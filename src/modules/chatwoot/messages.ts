import { firstLocationAttachment, messageTypeOf } from "./normalize";
import {
  cleanTranscription,
  type RenderableLocation,
  type RenderableMessage,
} from "./render";

// Pure parser for the Chatwoot conversation-messages REST response (admin-token getMessages). The
// list endpoint returns `{ meta, payload: [...] }` (or, defensively, a bare array). Each message
// carries an integer `message_type` (0=incoming, 1=outgoing, 2=activity, 3=template) — DIFFERENT
// from the webhook payload, where it ships as the string "incoming"/"outgoing". The debounce flush
// re-fetches the thread and coalesces the incoming messages past the watermark, so it needs the id,
// the textual content, attachment types, the STT transcription (written back into attachment meta),
// and the quoted-message id. No DB, no network.

export interface ChatwootMessageRow {
  id: number;
  content: string;
  messageType: "incoming" | "outgoing" | "activity" | "template" | "other";
  private: boolean;
  // Chatwoot file_type of each attachment ("audio" | "image" | "file" | ...).
  attachmentTypes: string[];
  // STT transcription, read back from the FIRST attachment's meta.transcribed_text (set by the
  // eager STT pass). Null when absent (text message, or audio not yet/never transcribed).
  transcribedText: string | null;
  // Vision extraction, read back from attachment meta (set by the eager vision pass). Null when
  // absent (vision off/failed/unsupported, or not an image/document).
  imageDescription: string | null;
  extractedText: string | null;
  // Best-effort first-attachment file name (from the data_url basename), for the unsupported marker.
  attachmentName: string | null;
  // NOTE: The first usable location attachment's content (coordinates/title), for the
  // <localização> marker — mirrors the direct webhook path (issue #45). Null when absent/unusable.
  location: RenderableLocation | null;
  // content_attributes.in_reply_to — the quoted/replied-to message id, if any.
  inReplyTo: number | null;
  // content_attributes.is_reaction — true when this message is an emoji reaction (content = emoji).
  isReaction: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

// A string value written back onto an attachment's meta by an eager pass (STT/vision), read from
// the first attachment that carries it. Keys: transcribed_text / image_description / extracted_text.
function metaStringFrom(attachments: unknown, key: string): string | null {
  if (!Array.isArray(attachments)) return null;
  for (const a of attachments) {
    if (!isRecord(a)) continue;
    const meta = isRecord(a.meta) ? a.meta : null;
    const t = meta?.[key];
    if (typeof t === "string" && t.trim()) return t;
  }
  return null;
}

// Best-effort file name of the first attachment, from its data_url basename (query stripped).
function fileNameFrom(attachments: unknown): string | null {
  if (!Array.isArray(attachments)) return null;
  for (const a of attachments) {
    if (!isRecord(a)) continue;
    const url = typeof a.data_url === "string" ? a.data_url : null;
    if (!url) continue;
    const path = url.split("?")[0] ?? url;
    const base = path.slice(path.lastIndexOf("/") + 1);
    const name = decodeURIComponent(base).trim();
    if (name) return name;
  }
  return null;
}

// NOTE: Raw REST attachments → the shared location extractor (the same fields the webhook mapper
// reads: coordinates_lat / coordinates_long / fallback_title).
function locationFrom(attachments: unknown): RenderableLocation | null {
  if (!Array.isArray(attachments)) return null;
  return firstLocationAttachment(
    attachments.filter(isRecord).map((a) => ({
      fileType: typeof a.file_type === "string" ? a.file_type : null,
      latitude:
        typeof a.coordinates_lat === "number" &&
        Number.isFinite(a.coordinates_lat)
          ? a.coordinates_lat
          : null,
      longitude:
        typeof a.coordinates_long === "number" &&
        Number.isFinite(a.coordinates_long)
          ? a.coordinates_long
          : null,
      fallbackTitle:
        typeof a.fallback_title === "string" ? a.fallback_title : null,
    })),
  );
}

function attachmentTypesFrom(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  const out: string[] = [];
  for (const a of attachments) {
    if (isRecord(a) && typeof a.file_type === "string") out.push(a.file_type);
  }
  return out;
}

// Parses the raw response into normalized rows sorted by id ascending (Chatwoot ids are globally
// increasing per account, so id order is chronological and drives the watermark comparison).
export function parseChatwootMessages(raw: unknown): ChatwootMessageRow[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.payload)
      ? raw.payload
      : [];
  const out: ChatwootMessageRow[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = num(item.id);
    if (id === null) continue;
    const ca = isRecord(item.content_attributes)
      ? item.content_attributes
      : null;
    out.push({
      id,
      content: typeof item.content === "string" ? item.content : "",
      messageType: messageTypeOf(item.message_type),
      private: item.private === true,
      attachmentTypes: attachmentTypesFrom(item.attachments),
      transcribedText: metaStringFrom(item.attachments, "transcribed_text"),
      imageDescription: metaStringFrom(item.attachments, "image_description"),
      extractedText: metaStringFrom(item.attachments, "extracted_text"),
      attachmentName: fileNameFrom(item.attachments),
      location: locationFrom(item.attachments),
      inReplyTo: ca ? num(ca.in_reply_to) : null,
      isReaction: ca?.is_reaction === true,
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

// Build a quote resolver from a fetched page: message id → its effective text (content, or the STT
// transcription for a voice note). renderInboundMessage uses it to prefix the "<em resposta a: …>"
// snippet when a message quotes another. Shared by the debounce flush AND the direct webhook path
// (both fetch the same page via getMessages), so reply context is identical on either path.
export function buildQuoteResolver(
  messages: ChatwootMessageRow[],
): (id: number) => string | null {
  const textById = new Map<number, string>();
  for (const m of messages) {
    const eff = m.content.trim() || cleanTranscription(m.transcribedText ?? "");
    if (eff) textById.set(m.id, eff);
  }
  return (id: number) => textById.get(id) ?? null;
}

export function toRenderable(row: ChatwootMessageRow): RenderableMessage {
  return {
    text: row.content,
    transcribedText: row.transcribedText,
    imageDescription: row.imageDescription,
    extractedText: row.extractedText,
    attachmentTypes: row.attachmentTypes,
    attachmentName: row.attachmentName,
    location: row.location,
    inReplyTo: row.inReplyTo,
    isReaction: row.isReaction,
  };
}

// The highest incoming, non-private, RENDERABLE message id in a fetched page (or `floor` if none).
// The supersede gates (debounce flush AND the direct path) compare it against the id a turn is
// answering to detect a mid-turn arrival. Renderable uses the SAME criterion as pendingIncoming
// (text OR an attachment): a voice note / image / file carries empty content, and treating it as
// "no new input" let a stale turn post its reply over a customer who had already moved on.
export function maxIncomingId(
  messages: ChatwootMessageRow[],
  floor: number,
): number {
  let max = floor;
  for (const m of messages) {
    if (
      m.messageType === "incoming" &&
      !m.private &&
      (m.content.trim().length > 0 || m.attachmentTypes.length > 0) &&
      m.id > max
    ) {
      max = m.id;
    }
  }
  return max;
}

// The incoming, non-private, RENDERABLE customer messages whose id is beyond the watermark — the
// burst a flush must answer. Renderable = has text OR an attachment (audio/image/file), so a voice
// note (empty content) is included. `watermark` null ⇒ everything in the fetched page.
export function pendingIncoming(
  messages: ChatwootMessageRow[],
  watermark: number | null,
): ChatwootMessageRow[] {
  return messages.filter(
    (m) =>
      m.messageType === "incoming" &&
      !m.private &&
      (m.content.trim().length > 0 || m.attachmentTypes.length > 0) &&
      (watermark === null || m.id > watermark),
  );
}
