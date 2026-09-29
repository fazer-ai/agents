import type { VisualAttachment } from "@/modules/vision/extract-message";
import type { UnreadFile } from "@/modules/vision/unread";
import { CHATWOOT_SEND_ID_KEY } from "./constants";
import { bodyImagesBesides, emailBodyImageUrlsFrom } from "./email-body-images";
import {
  activityStatusFrom,
  activityTypeFrom,
  bodyImageVisuals,
  chatwootTimestamp,
  emailSubjectFrom,
  firstLocationAttachment,
  isVisualFileType,
  messageTypeOf,
  metaString,
} from "./normalize";
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
  // When Chatwoot recorded it. The only place the re-engage path can learn the age of the message it
  // answers: `last_inbound_at` is null on a row created from a non-message event. Optional because a
  // hand-built row has no instant, and absent reads the same as unreadable.
  createdAt?: Date | null;
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
  // How many attachments the eager vision pass did not open (over the per-message cap). OPTIONAL
  // because the fetched page can never carry it: `overlayMediaAnnotations` fills it from the
  // in-process stash, which is why the notice is a COUNT here and a marker only at render time.
  attachmentsUnread?: number | null;
  // Filled the same way, and only from the stash: which of those files were tried, and why each failed.
  unreadFiles?: UnreadFile[] | null;
  // Best-effort first-attachment file name (from the data_url basename), for the unsupported marker.
  attachmentName: string | null;
  // The visual attachments themselves, with the id and url an extraction needs. The fields above say
  // what was already extracted; this says what exists to extract, so a turn that re-read the thread
  // can open an attachment whose meta was never written (a conversation that arrived before the
  // agent observed the inbox never went through the eager path).
  visuals: VisualAttachment[];
  // How many of `visuals` are images the mailbox kept in the email body. They carry no attachment
  // type, so this is what makes a message whose only content is one of them answerable.
  bodyImages?: number;
  // True when a vision pass already went through the body images (in-process stash): attachment
  // meta never covers them, since they have no attachment to carry it.
  bodyRead?: boolean;
  // The first usable location attachment's content (coordinates/title), for the <localização>
  // marker, as on the direct webhook path. Null when absent or unusable.
  location: RenderableLocation | null;
  // content_attributes.in_reply_to — the quoted/replied-to message id, if any.
  inReplyTo: number | null;
  // content_attributes.is_reaction — true when this message is an emoji reaction (content = emoji).
  isReaction: boolean;
  // The email's Subject header, from `content_attributes.email.subject`. Null on every message no
  // mailbox wrote.
  emailSubject: string | null;
  // `content_attributes.activity.type`: non-null on activity rows that declare what they narrate (a
  // status change, a Linear event), null on those that carry only a localized sentence, which is
  // where a label change lives.
  activityType: string | null;
  // `content_attributes.activity.status` on a status-change activity row: the status the
  // conversation moved to. Null on every other row. Optional because a hand-built row narrates no
  // status, and absent reads the same as null.
  activityStatus?: string | null;
  // Who sent it, from Chatwoot's `sender.type`. Separates our outgoing message from a human agent's,
  // which `messageType` cannot: a person's reply closes every customer message before it, one of
  // ours closes only what its turn claimed.
  senderType: "contact" | "user" | "agent_bot" | "other" | null;
  // Which sender, when the page named one. "agent_bot" alone does not say ours: another AgentBot's
  // replies write no claim row here, and exempting them from the outgoing boundary would read its
  // answers as ours.
  senderId: number | null;
  // `content_attributes.external_sender_name`: a person answering on the phone paired to the inbox's
  // number. The fork stores that echo sender-less, so `senderType` is null, and this is the only
  // field that separates it from Chatwoot's own sender-less outgoing messages (automation rule,
  // scheduled message, CSAT survey). Trusting it also needs the inbox's WhatsApp provider; see
  // `foreignReplyBoundary` and `providerReservesEchoIds`.
  externalSenderName: string | null;
  // `content_attributes.imported`, written by the history importer. The fence on the mark above: an
  // import inserts old messages with today's ids, so a backfilled phone reply lands above a live,
  // unanswered customer message and, read as a boundary, would silence the operator's backlog the
  // day they pair a phone. The webhook path fences it one layer up (`hasDeviceAttendantShape`).
  imported: boolean;
  // The name the send gave itself on the way out, when this message is one of ours and the sender
  // asked for one. Null on everything inbound, everything a person wrote, and sends with no resend to
  // decide. It lets a delivery be proved by identity instead of by matching text.
  sendId: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Chatwoot's `sender.type` as the page reports it, narrowed to the three its serializer emits
// (`push_event_data`: "contact", "user", "agent_bot"). An unknown string is "other" rather than
// null: null means the page said nothing about a sender, which the serializer allows
// (`json.sender … if message.sender`), and a caller deciding ownership has to tell "nobody said"
// from "somebody we do not recognise".
function senderTypeOf(
  sender: unknown,
): "contact" | "user" | "agent_bot" | "other" | null {
  if (!isRecord(sender)) return null;
  const t = sender.type;
  if (typeof t !== "string") return null;
  return t === "contact" || t === "user" || t === "agent_bot" ? t : "other";
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

// Every attachment that carries the key, labelled by file name when there is more than one (vision
// writes back per attachment, so reading only the first throws the others away). One attachment
// returns exactly what `metaStringFrom` returns, so the common case keeps its wording.
function metaJoinedFrom(attachments: unknown, key: string): string | null {
  if (!Array.isArray(attachments)) return null;
  const partes: { nome: string | null; texto: string }[] = [];
  for (const a of attachments) {
    if (!isRecord(a)) continue;
    const meta = isRecord(a.meta) ? a.meta : null;
    const t = meta?.[key];
    if (typeof t === "string" && t.trim())
      partes.push({ nome: fileNameOfUrl(a.data_url), texto: t });
  }
  if (partes.length === 0) return null;
  if (partes.length === 1) return partes[0]?.texto ?? null;
  return partes
    .map((p, i) => `[${p.nome ?? `arquivo ${i + 1}`}] ${p.texto}`)
    .join("\n\n");
}

// The basename of an attachment's data url, or null. Best-effort like `fileNameFrom`:
// `decodeURIComponent` throws on an invalid escape, and a label must never cost the page it labels.
function fileNameOfUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  const path = url.split("?")[0] ?? url;
  const base = path.slice(path.lastIndexOf("/") + 1);
  let name: string;
  try {
    name = decodeURIComponent(base).trim();
  } catch {
    name = base.trim();
  }
  return name.length > 0 && name.length <= 120 ? name : null;
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

// OS ANEXOS QUE UMA EXTRAÇÃO PODE ABRIR, na mesma forma que o caminho do webhook produz
// (`visualAttachments`, ./normalize.ts). A diferença entre os dois é só a grafia dos campos: a
// lista REST manda `data_url` e `meta`, a wire manda o já normalizado. A REGRA de o que é visual
// não é repetida aqui — ela mora em `isVisualFileType`, e é por isso que ela é exportada.
function visualsFrom(attachments: unknown): VisualAttachment[] {
  if (!Array.isArray(attachments)) return [];
  const out: VisualAttachment[] = [];
  for (const a of attachments) {
    if (!isRecord(a)) continue;
    const id = num(a.id);
    const dataUrl = typeof a.data_url === "string" ? a.data_url : null;
    if (
      id === null ||
      !dataUrl ||
      !isVisualFileType(typeof a.file_type === "string" ? a.file_type : null)
    )
      continue;
    out.push({
      id,
      dataUrl,
      name: fileNameOfUrl(dataUrl),
      imageDescription: metaString(a.meta, "image_description"),
      extractedText: metaString(a.meta, "extracted_text"),
    });
  }
  return out;
}

// The attachments, then the images the mailbox kept in the email body.
function visualsWithBody(
  attachments: unknown,
  ca: Record<string, unknown> | null,
): { visuals: VisualAttachment[]; bodyImages?: number } {
  const anexos = visualsFrom(attachments);
  const corpo = bodyImageVisuals(
    bodyImagesBesides(
      emailBodyImageUrlsFrom(ca),
      anexos.map((v) => v.dataUrl),
    ),
  );
  // The count only when there is one: every other channel's row stays exactly what it was.
  return corpo.length > 0
    ? { visuals: [...anexos, ...corpo], bodyImages: corpo.length }
    : { visuals: anexos };
}

function attachmentTypesFrom(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  const out: string[] = [];
  for (const a of attachments) {
    if (isRecord(a) && typeof a.file_type === "string") out.push(a.file_type);
  }
  return out;
}

// How many messages the response carried before parsing, or `null` when it was not a list at all.
// `parseChatwootMessages` folds three answers into one empty array (an empty page, a non-list body,
// a page of unreadable rows); a caller asking "did I reach the end of the history?" must tell the
// first from the degraded two, or "I could not tell" turns into "it is not there".
export function chatwootMessageListLength(raw: unknown): number | null {
  if (Array.isArray(raw)) return raw.length;
  if (isRecord(raw) && Array.isArray(raw.payload)) return raw.payload.length;
  return null;
}

// Parses the raw response into normalized rows sorted by id ascending (Chatwoot ids increase per
// account, so id order is chronological and drives the watermark comparison). `created_at` comes as
// epoch seconds (jbuilder `.to_i`) or an ISO-8601 string; anything unparseable reads as absent,
// never as the epoch.
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
      createdAt: chatwootTimestamp(item.created_at),
      messageType: messageTypeOf(item.message_type),
      private: item.private === true,
      attachmentTypes: attachmentTypesFrom(item.attachments),
      transcribedText: metaStringFrom(item.attachments, "transcribed_text"),
      imageDescription: metaJoinedFrom(item.attachments, "image_description"),
      extractedText: metaJoinedFrom(item.attachments, "extracted_text"),
      attachmentName: fileNameFrom(item.attachments),
      ...visualsWithBody(item.attachments, ca),
      location: locationFrom(item.attachments),
      inReplyTo: ca ? num(ca.in_reply_to) : null,
      isReaction: ca?.is_reaction === true,
      emailSubject: emailSubjectFrom(ca),
      activityType: activityTypeFrom(ca),
      activityStatus: activityStatusFrom(ca),
      senderType: senderTypeOf(item.sender),
      senderId: isRecord(item.sender) ? num(item.sender.id) : null,
      externalSenderName:
        typeof ca?.external_sender_name === "string"
          ? ca.external_sender_name
          : null,
      imported: ca?.imported === true,
      // Read as a STRING and nothing else. The bag is shared with Chatwoot's own keys and with
      // whatever an operator's automation writes there, so a value of another shape is somebody
      // else's key that happens to collide, not a name this build wrote.
      sendId:
        typeof ca?.[CHATWOOT_SEND_ID_KEY] === "string"
          ? (ca[CHATWOOT_SEND_ID_KEY] as string)
          : null,
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
    attachmentsUnread: row.attachmentsUnread,
    unreadFiles: row.unreadFiles,
    attachmentTypes: row.attachmentTypes,
    bodyImages: row.bodyImages,
    attachmentName: row.attachmentName,
    location: row.location,
    inReplyTo: row.inReplyTo,
    isReaction: row.isReaction,
    emailSubject: row.emailSubject,
  };
}

// Can this message be answered at all? Asked by `renderInboundMessage` (its "" branch), the debounce
// burst (`pendingIncoming`) and the supersede gate (`maxIncomingId`), which must agree: if one copy
// learned a new shape (a subject-only email) and another did not, the burst would drop a message the
// renderer can read. A fence test walks the shapes and asserts they answer alike.
export function hasAnswerableContent(
  m: Pick<
    ChatwootMessageRow,
    "content" | "attachmentTypes" | "emailSubject" | "bodyImages"
  >,
): boolean {
  return (
    m.content.trim().length > 0 ||
    m.attachmentTypes.length > 0 ||
    (m.emailSubject ?? "").trim().length > 0 ||
    (m.bodyImages ?? 0) > 0
  );
}

// The highest incoming, non-private, RENDERABLE message id in a fetched page (or `floor` if none).
// The supersede gates (debounce flush AND the direct path) compare it against the id a turn is
// answering to detect a mid-turn arrival. Renderable is `hasAnswerableContent`, the same predicate
// pendingIncoming asks: a voice note / image / file carries empty content, and so does an email
// whose request is in the subject; treating either as "no new input" lets a stale turn post its
// reply over a customer who has already moved on.
export function maxIncomingId(
  messages: ChatwootMessageRow[],
  floor: number,
): number {
  let max = floor;
  for (const m of messages) {
    if (
      m.messageType === "incoming" &&
      !m.private &&
      hasAnswerableContent(m) &&
      m.id > max
    ) {
      max = m.id;
    }
  }
  return max;
}

// The incoming, non-private, RENDERABLE customer messages whose id is beyond the watermark — the
// burst a flush must answer. Renderable is `hasAnswerableContent`, so a voice note (empty content)
// and a subject-only email are both included. `watermark` null ⇒ everything in the fetched page.
export function pendingIncoming(
  messages: ChatwootMessageRow[],
  watermark: number | null,
): ChatwootMessageRow[] {
  return messages.filter(
    (m) =>
      m.messageType === "incoming" &&
      !m.private &&
      hasAnswerableContent(m) &&
      (watermark === null || m.id > watermark),
  );
}
