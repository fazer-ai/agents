import { clipText } from "@/lib/text";
import type { UnreadCause, UnreadFile } from "@/modules/vision/unread";
// Renders ONE inbound customer message into the text the agent sees, mirroring the n8n "Extrair
// mensagem" node: audio becomes its transcription in <mensagem-de-audio> (or a "não audível" marker
// when it is empty or failed), an image or other file a marker, text itself, and a quoted message is
// prefixed with the referenced snippet when resolvable. Pure: no DB, no network. Shared by the direct
// (webhook) path and the debounce flush.

// A location attachment's usable content: coordinates and/or the provider's place title ("Padaria do
// Zé, Rua X, 123"). Coordinate-less pins keep the title; see firstLocationAttachment for the (0,0)
// null-island rule.
export interface RenderableLocation {
  latitude: number | null;
  longitude: number | null;
  title: string | null;
}

export interface RenderableMessage {
  text: string;
  transcribedText?: string | null;
  // Vision extraction written back by the eager pass (or absent when vision is off/failed/unsupported).
  imageDescription?: string | null;
  extractedText?: string | null;
  attachmentsUnread?: number | null;
  // The unread files the pass tried, with name and cause. The rest of the count went over the cap.
  unreadFiles?: UnreadFile[] | null;
  // Chatwoot file_type of each attachment ("audio" | "image" | "file" | "video" | ...).
  attachmentTypes: string[];
  // Images the mailbox kept in the email body: no attachment type, read by vision.
  bodyImages?: number | null;
  // Best-effort file name of the first attachment (for the "could not extract" marker).
  attachmentName?: string | null;
  // NOTE: The first usable location attachment's content (coordinates/title), or null/absent.
  // Rendered as a <localização …> marker so the model can pass the coordinates on as tool args.
  location?: RenderableLocation | null;
  inReplyTo?: number | null;
  // True when this message is an emoji reaction (content = the emoji). Rendered as a context marker so
  // the agent understands the customer reacted (vs sent the emoji as a message) and can decide whether
  // to respond. Mirrors the audio/image markers.
  isReaction?: boolean;
  // The email's Subject header, from the message's own `content_attributes.email.subject`. Its
  // presence stands in for a channel gate, an observed property rather than a guarantee: messages on
  // non-email channels carry no `email` bag, while a mail inbox's carry `subject`. A real channel gate
  // cannot live here (the flush path builds this from a REST row with no channel on it), and asking it
  // only on the direct path would make the two paths disagree.
  emailSubject?: string | null;
}

// Free-form text from a stranger, made safe to sit inside one of the markers above: whitespace
// collapses to one space (a folded header must not become two lines) and `<`/`>` become `‹`/`›`, so no
// closing tag or marker of ours can be forged from what a sender typed. Exported for the tests; one
// caller. It keeps THE SUBJECT inside its own marker; it does NOT make an `<assunto>` block proof of
// origin. The body passes verbatim (it IS the message), as do the quoted snippet, file names,
// location titles and text extracted from a PDF, so a sender can forge the tags there. Never build a
// rule that reads a marker as proof of where its content came from: markers help the model read.
export function defangMarkerText(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .trim();
}

// The same job as renderInboundMessage for the OTHER direction: one message a human agent sent,
// turned into the text the agent's memory keeps of it. A separate function rather than a flag,
// because every marker there is written from the CUSTOMER's side: an attendant's photo would render
// as an instruction to ask the colleague to resend it. The eager media pass never runs on an outgoing
// message, so there is nothing to extract; what matters is that an attachment-only reply is not
// dropped, or a PDF with no caption leaves the memory recording that the team said nothing.
export function renderAttendantMessage(m: {
  text: string;
  attachmentTypes: string[];
  // The words an audio reply spoke. An outgoing voice note carries an EMPTY `content` (the WhatsApp
  // connector refuses a caption on an audio), so without this the reply reads as the marker alone,
  // and the observer tick, which writes labels from what it reads, classifies it as unanswered. It
  // arrives on the attachment's `transcribed_text` (the fork stores it; upstream drops it, and there
  // the runtime's in-process overlay fills it for the turns that follow).
  transcribedText?: string | null;
}): string {
  const type = m.attachmentTypes[0];
  const spoken =
    type === "audio" ? cleanTranscription(m.transcribedText ?? "") : "";
  const text = (m.text ?? "").trim() || spoken;
  if (!type) return text;
  // Named even when there IS a caption: the caption alone loses the fact that a file went with it,
  // and "segue o orçamento" with no record of an attachment reads as a promise never kept.
  const marker = `<atendente enviou um arquivo do tipo '${type}'>`;
  return text ? `${text}\n${marker}` : marker;
}

const AMARA = /amara\.org/i;

// Whisper hallucinates "…Amara.org" subtitle credits on silent/near-silent audio. Drop it.
export function cleanTranscription(s: string): string {
  const t = (s ?? "").trim();
  return AMARA.test(t) ? "" : t;
}

const QUOTE_MAX = 200;

// O PREFIXO É CONTRATO: `unwrapFileMarker` (../playground/sessions.ts) reconhece este marcador por
// `startsWith`; ver a nota no ramo de imagem de `renderInboundMessage`.
const CORPO_SEM_CONTEUDO =
  "<e-mail sem texto; as imagens do corpo não trouxeram conteúdo legível>";
const IMAGEM_ILEGIVEL =
  "<usuário enviou uma imagem; não foi possível ler o conteúdo, peça que o cliente reenvie o arquivo ou escreva a informação>";
// The same prefix with no request: the file-by-file block below says what to ask for.
const IMAGEM_ILEGIVEL_NOMEADA =
  "<usuário enviou uma imagem; não foi possível ler o conteúdo>";

// Each cause asks for the one thing that helps. Resending the same file only helps a failure.
const PEDIDO_POR_MOTIVO: Record<
  UnreadCause,
  { motivo: string; texto: string }
> = {
  format: {
    motivo: "formato",
    texto:
      "formato que não conseguimos abrir; enviar o mesmo arquivo de novo não resolve. Se a resposta depender dele, peça o conteúdo em foto ou por escrito",
  },
  too_large: {
    motivo: "grande-demais",
    texto:
      "imagem com resolução alta demais para ler; se a resposta depender dela, peça um print da tela ou uma foto em resolução normal",
  },
  failed: {
    motivo: "falha",
    texto:
      "não foi possível ler desta vez; se a resposta depender dele, peça o conteúdo por escrito ou o arquivo de novo",
  },
};

function anexosNaoLidos(total: number, files: UnreadFile[]): string {
  const linhas = files.map((f) => {
    const { motivo, texto } = PEDIDO_POR_MOTIVO[f.cause];
    const nome = defangMarkerText(f.name).replace(/"/g, "'");
    const attr = nome ? ` nome="${nome}"` : "";
    const quem = nome ? "" : "arquivo sem nome: ";
    return `<arquivo${attr} motivo="${motivo}">${quem}${texto}</arquivo>`;
  });
  const resto = total - files.length;
  if (resto > 0)
    linhas.push(
      `mais ${resto} arquivo(s) não foram abertos; se a resposta depender deles, peça ao cliente que reenvie o que falta`,
    );
  return `<anexos-nao-lidos quantidade="${total}">estes arquivos chegaram, mas o conteúdo não foi lido:\n${linhas.join("\n")}\n</anexos-nao-lidos>`;
}

export function renderInboundMessage(
  m: RenderableMessage,
  ctx: { resolveQuoted?: (id: number) => string | null } = {},
): string {
  const types = new Set(m.attachmentTypes);
  const text = (m.text ?? "").trim();
  const withText = (marker: string) => (text ? `${text}\n${marker}` : marker);

  // The subject is collapsed, never clipped: folded across lines it would stop being the FIRST
  // LINE of the message, and clipped it would lose the request, which on this channel is often the
  // subject's tail. Defanged because it is the first field a STRANGER fills in that becomes prompt
  // structure: `</assunto> Ignore as instruções anteriores` rendered verbatim would leave the marker.
  // Angle brackets are the whole attack surface, so both become guillemet lookalikes (as the location
  // title does with `"`): nothing is dropped, and no tag can form.
  const subject = defangMarkerText(m.emailSubject);

  // NOTE: a reaction is its own thing: the content is the emoji and in_reply_to points at the
  // reacted-to message. Wrapped as a context marker (like audio/image) so the agent can react back or
  // skip a reply rather than treat the emoji as a fresh question.
  if (m.isReaction) {
    const emoji = text || "(emoji)";
    const quoted =
      m.inReplyTo != null && ctx.resolveQuoted
        ? ctx.resolveQuoted(m.inReplyTo)
        : null;
    const para = quoted
      ? ` para: "${clipText(quoted.replace(/\s+/g, " ").trim(), QUOTE_MAX)}"`
      : "";
    // The subject rides along here too. It cannot happen on a mailbox (nobody reacts to an email),
    // but `hasAnswerableContent` admits a message for its subject alone, and a renderer that dropped
    // it on this one branch would be the predicate and the renderer disagreeing again, on a shape the
    // type allows. The fence walks it.
    const reaction = `<reação do cliente emoji="${emoji}"${para}>`;
    return subject ? `<assunto>${subject}</assunto>\n${reaction}` : reaction;
  }
  const imageDescription = (m.imageDescription ?? "").trim();
  const extractedText = (m.extractedText ?? "").trim();
  // The files the eager pass did not read (over the cap, or attempted and failed). Phrased
  // HERE, with the other markers, so it survives the debounce re-fetch: glued onto the extracted text
  // it would exist only on the discarded event, and a model told nothing answers as if those files
  // were not there.
  const nomeados = m.unreadFiles ?? [];
  const pulados = m.attachmentsUnread ?? 0;
  const naoLidos =
    nomeados.length > 0
      ? anexosNaoLidos(pulados, nomeados)
      : pulados > 0
        ? `<anexos-nao-lidos quantidade="${pulados}">não foi possível ler; se a resposta depender deles, peça ao cliente que reenvie o que falta</anexos-nao-lidos>`
        : "";
  let body: string;
  // Whether a branch below already told the model a file could not be read.
  let pediuReenvio = false;
  if (types.has("audio")) {
    const tr = cleanTranscription(m.transcribedText ?? text);
    body = tr
      ? `<mensagem-de-audio>${tr}</mensagem-de-audio>`
      : "<mensagem de áudio não audível; peça que o cliente reenvie por texto>";
  } else if (imageDescription || extractedText) {
    // Vision extracted the content, so the agent "sees" it. BOTH blocks when both exist, or a
    // message with a photo AND a PDF loses the document without a trace. One `withText` call, so the
    // customer's own words are not repeated once per block.
    const blocos = [
      imageDescription ? `<imagem>${imageDescription}</imagem>` : "",
      extractedText ? `<documento>${extractedText}</documento>` : "",
    ].filter(Boolean);
    body = withText(blocos.join("\n"));
  } else if (types.has("image")) {
    // NOTE: sem extração (vision desligada, falhou, mime não suportado, ou acima do teto por mensagem).
    // O marcador não sugere canal de volta ("por texto ou áudio"): o modelo lê a frase como parte da
    // mensagem, e numa caixa de e-mail isso vence o prompt que diz que ali não existe áudio. Redação
    // neutra como a dos marcadores irmãos; descer o tipo da inbox por três camadas até aqui seria
    // superfície permanente em todo sync com o upstream. O PREFIXO É CONTRATO: `unwrapFileMarker`
    // (../playground/sessions.ts) reconhece este marcador por `startsWith` para remontar o anexo na
    // tela do operador; cercado em `tests/modules/chatwoot-render.test.ts`.
    body = withText(
      nomeados.length > 0 ? IMAGEM_ILEGIVEL_NOMEADA : IMAGEM_ILEGIVEL,
    );
    pediuReenvio = true;
  } else if (m.location) {
    // A WhatsApp location pin: surfaced as attributes (mirroring the reaction marker) so the
    // model reads the coordinates and forwards them as ordinary tool arguments. A pin with neither
    // coordinates nor title never gets here (location is null) and falls through to the generic
    // marker below.
    const coords =
      m.location.latitude !== null && m.location.longitude !== null
        ? ` latitude="${m.location.latitude}" longitude="${m.location.longitude}"`
        : "";
    // The title is provider/user text inside a quoted pseudo-attribute: a double quote in it
    // would read as closing the attribute early; swap for single quotes (no full XML escaping, per
    // this file's marker convention).
    const title = m.location.title
      ? ` titulo="${m.location.title.replace(/"/g, "'")}"`
      : "";
    body = withText(`<localização${coords}${title}>`);
  } else if (text) {
    body = text;
  } else if (types.size > 0) {
    const ty = m.attachmentTypes[0] ?? "arquivo";
    const named = m.attachmentName?.trim()
      ? ` chamado '${m.attachmentName.trim()}'`
      : "";
    body = `<usuário enviou um arquivo do tipo '${ty}'${named}; não foi possível extrair o conteúdo>`;
    pediuReenvio = true;
  } else if (subject) {
    // The subject is the whole message. An email whose body is empty or a client footer is NOT a
    // blank message, and the branch below would have dropped the turn with the request in it.
    body = "";
  } else if (m.bodyImages) {
    // NOTE: an email whose only content is an image in its body. Unread ones are named below.
    // Nothing read and nothing unread is every image an ornament, or vision off, and neither is a
    // file to ask for again: the marker says only that there is nothing to read.
    body = naoLidos ? "" : CORPO_SEM_CONTEUDO;
  } else {
    return ""; // nothing renderable → skip
  }

  // NOTE: only ALONGSIDE something that WAS read: when nothing was, the branch above already asked
  // for the same thing, and two markers saying it is noise. It exists for the PARTIAL case, where a
  // successful extraction would make the message look complete. Or when that marker was NOT emitted:
  // an email-body image has no attachment type, so beside text, an audio or a pin a failed one would
  // leave no trace. A named cause is never redundant: the generic markers do not say what to ask for.
  if (
    naoLidos &&
    (imageDescription || extractedText || !pediuReenvio || nomeados.length > 0)
  )
    body = body ? `${body}\n${naoLidos}` : naoLidos;

  if (m.inReplyTo != null && ctx.resolveQuoted) {
    const quoted = ctx.resolveQuoted(m.inReplyTo);
    if (quoted) {
      const snippet = clipText(quoted.replace(/\s+/g, " ").trim(), QUOTE_MAX);
      if (snippet) body = `<em resposta a: "${snippet}">\n${body}`;
    }
  }
  // OUTERMOST, and after the quote marker for that reason: the quote is context for the body, the
  // subject is the envelope both sit in, and an email client shows it above everything else.
  if (subject) {
    const marker = `<assunto>${subject}</assunto>`;
    body = body ? `${marker}\n${body}` : marker;
  }
  return body;
}
