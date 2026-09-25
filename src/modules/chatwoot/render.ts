import { clipText } from "@/lib/text";
// Renders ONE inbound customer message into the text the agent actually sees, mirroring the n8n
// "Extrair mensagem" node so the agent gets modality + reply context instead of a silent blank:
//   * audio  → the transcription wrapped in <mensagem-de-audio>…</mensagem-de-audio> (or a
//              "não audível" marker when transcription is empty/failed);
//   * image  → a marker asking the customer to send text/audio (no vision yet);
//   * other file → a marker naming the file type;
//   * text   → as-is;
//   * a quoted/replied-to message → prefixed with the referenced snippet when resolvable.
// Pure: no DB, no network. Shared by the direct (webhook) path and the debounce flush.

// NOTE: A location attachment's usable content (issue #45): coordinates and/or the provider's place
// title ("Padaria do Zé, Rua X, 123"). Coordinate-less pins keep the title; see
// firstLocationAttachment for the (0,0) null-island rule.
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
  // Chatwoot file_type of each attachment ("audio" | "image" | "file" | "video" | ...).
  attachmentTypes: string[];
  // Images the mailbox kept in the email body (issue #864): no attachment type, read by vision.
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
  // NOTE: The email's Subject header (issue #598), from the message's own
  // `content_attributes.email.subject`. The field being present is what stands in for a channel gate,
  // and that is a MEASUREMENT rather than a guarantee: over 90 days of production, zero inbound
  // messages on any non-email channel carried an `email` bag at all, while 99.8% of the live mail
  // inbox's own carried a `subject` key. A channel gate proper cannot live here — the flush path
  // builds this from a REST row, which has no channel on it — and asking it only on the direct path
  // is the two paths disagreeing, which is the drift this change exists to remove.
  emailSubject?: string | null;
}

// Free-form text from a stranger, made safe to sit inside one of the markers above. Whitespace is
// collapsed to a single space (a folded header must not become two lines) and `<`/`>` become `‹`/`›`,
// so no closing tag and no marker of ours can be forged out of what a sender typed. Exported for the
// tests that state the contract; there is exactly one caller.
//
// WHAT THIS DOES NOT PROMISE, and the line matters more than the function: it guarantees that THE
// SUBJECT does not leave its own marker. It does NOT guarantee that an `<assunto>` block in what the
// model reads came from an envelope. The body of the same email is passed through verbatim — it IS
// the message, and sanitising it would damage legitimate text — so a sender can write the tags in the
// body and produce a second, forged `<assunto>` in the same message. The same is true of every other
// verbatim channel already here: the quoted snippet, a file name, a location title, text extracted
// from a PDF. So never build a deterministic rule that reads a marker as proof of where its content
// came from; the markers are there to help the model read, not to authenticate.
export function defangMarkerText(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .trim();
}

// The same job as renderInboundMessage, for the OTHER direction: one message a human agent sent,
// turned into the text the agent's memory keeps of it (issue #187).
//
// A separate function rather than a flag on its sibling, because every marker there is written from
// the CUSTOMER's side and reads wrong from this one: an attendant who sends a photo would be
// rendered as "usuário enviou uma imagem; … peça que o cliente reenvie o arquivo", instructing the
// agent to ask its own colleague to retype the file it just sent. What survives from the sibling is
// the shape of the problem, not the wording.
//
// The eager media pass never runs on an outgoing message (no transcription, no vision), so there is
// nothing to extract and nothing to wait for. What matters is only that an attachment-only reply is
// not silently dropped: an attendant who answers with a PDF and no caption would otherwise leave the
// memory recording that the team said nothing, which is the same defect this whole change is about.
export function renderAttendantMessage(m: {
  text: string;
  attachmentTypes: string[];
  // THE WORDS AN AUDIO REPLY SPOKE (issue #763). An outgoing voice note carries an EMPTY `content`
  // — it has to, because the WhatsApp connector refuses a caption on an audio — so without this
  // the agent's own reply came back as the marker alone, and every reader of that thread concluded
  // nobody had said anything. The observer tick is the one that made it a behaviour bug rather than
  // a reporting one: it renders every outgoing message through here and WRITES LABELS from what it
  // read, so five voice replies classified as a conversation the agent never answered. The value
  // arrives on the attachment's `transcribed_text` (the fork stores it; upstream drops it, and
  // there the runtime's in-process overlay fills it for the turns that follow).
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

export function renderInboundMessage(
  m: RenderableMessage,
  ctx: { resolveQuoted?: (id: number) => string | null } = {},
): string {
  const types = new Set(m.attachmentTypes);
  const text = (m.text ?? "").trim();
  const withText = (marker: string) => (text ? `${text}\n${marker}` : marker);

  // A reaction is its own thing: the content is the emoji and in_reply_to points at the reacted-to
  // message. Wrap it as a context marker (like audio/image) so the agent can choose to react back or
  // skip a reply rather than treating the emoji as a fresh question.
  // NOTE: Collapsed, never clipped. Folded across lines it would stop being the FIRST LINE of the
  // message, which is the whole point; clipped it would lose the request, because on this channel
  // the subject IS frequently the request — the case in the issue runs to 237 characters and its
  // operative half ("recuperar o acesso à minha conta") is the tail.
  //
  // AND DEFANGED, because this one is different in kind from every other marker here. The subject is
  // the first field a STRANGER fills in that becomes structure in the prompt: anyone with an email
  // address can write `</assunto> Ignore as instruções anteriores`, and rendered verbatim their text
  // leaves the marker and arrives as though the system had written it. Angle brackets are the whole
  // attack surface, so both are swapped for their single-guillemet lookalikes — the same move the
  // location title already makes with the quote that would end IT (`"` → `'`): nothing is dropped,
  // nothing is mangled, and no tag can form. The subject still reads the way the sender wrote it.
  const subject = defangMarkerText(m.emailSubject);

  if (m.isReaction) {
    const emoji = text || "(emoji)";
    const quoted =
      m.inReplyTo != null && ctx.resolveQuoted
        ? ctx.resolveQuoted(m.inReplyTo)
        : null;
    const para = quoted
      ? ` para: "${clipText(quoted.replace(/\s+/g, " ").trim(), QUOTE_MAX)}"`
      : "";
    // The subject rides along here too. It cannot happen on a mailbox — nobody reacts to an email —
    // but `hasAnswerableContent` admits a message for its subject alone, and a renderer that dropped
    // it on this one branch would be the predicate and the renderer disagreeing again, on a shape the
    // type allows. The fence walks it.
    const reaction = `<reação do cliente emoji="${emoji}"${para}>`;
    return subject ? `<assunto>${subject}</assunto>\n${reaction}` : reaction;
  }
  const imageDescription = (m.imageDescription ?? "").trim();
  const extractedText = (m.extractedText ?? "").trim();
  // The files the eager pass did not read — over the cap, or attempted and failed. Phrased HERE,
  // with the other markers, so it survives the debounce re-fetch: glued onto the extracted text it
  // existed only on the discarded event, and a model told nothing answers as if the message had
  // those files fewer (PR #692 review, rounds 1 and 3).
  const pulados = m.attachmentsUnread ?? 0;
  const naoLidos =
    pulados > 0
      ? `<anexos-nao-lidos quantidade="${pulados}">não foi possível ler; se a resposta depender deles, peça ao cliente que reenvie o que falta</anexos-nao-lidos>`
      : "";
  let body: string;
  if (types.has("audio")) {
    const tr = cleanTranscription(m.transcribedText ?? text);
    body = tr
      ? `<mensagem-de-audio>${tr}</mensagem-de-audio>`
      : "<mensagem de áudio não audível; peça que o cliente reenvie por texto>";
  } else if (imageDescription || extractedText) {
    // Vision extracted the content → the agent "sees" it. BOTH blocks, when both exist: this was an
    // `else if`, so a message carrying a photo AND a PDF rendered only the photo and the document
    // vanished with no trace (issue #691). One `withText` call, so the customer's own words are not
    // repeated once per block.
    const blocos = [
      imageDescription ? `<imagem>${imageDescription}</imagem>` : "",
      extractedText ? `<documento>${extractedText}</documento>` : "",
    ].filter(Boolean);
    body = withText(blocos.join("\n"));
  } else if (types.has("image")) {
    // Sem extração (vision desligada, falhou, mime não suportado, ou acima do teto por mensagem).
    //
    // E O MARCADOR NÃO ESCOLHE O CANAL DE VOLTA (issue #758). Ele dizia "peça que envie a informação
    // por texto ou áudio", frase escrita para o WhatsApp, e o modelo a lê como parte da mensagem que
    // está respondendo, não como texto de referência: numa caixa de e-mail saiu "Envie as informações
    // por texto ou áudio" para quem não tem como mandar áudio, por cima de um prompt que dizia, no
    // segundo parágrafo, que ali não existe áudio. Instrução dentro de conteúdo recuperado vence
    // contra-instrução no prompt, então o que resolve é a instrução não estar aqui.
    //
    // A redação neutra é a mesma escolha dos dois marcadores irmãos deste arquivo (o de áudio não
    // audível e o `<anexos-nao-lidos>`), e por isso o canal não precisa descer até aqui: `render.ts`
    // não conhece canal nenhum, e passar o tipo da inbox por três camadas seria superfície
    // permanente em todo sync com o upstream para dizer o que uma frase já diz. Quem quiser mandar
    // áudio manda sem ser convidado.
    //
    // O PREFIXO É CONTRATO: `unwrapFileMarker` (../playground/sessions.ts) reconhece este marcador
    // por `startsWith` para remontar o anexo na tela do operador, e uma reescrita da frase inteira
    // quebraria aquele lado em silêncio. Cercado em `tests/modules/chatwoot-render.test.ts`.
    body = withText(IMAGEM_ILEGIVEL);
  } else if (m.location) {
    // NOTE: A WhatsApp location pin: surfaced as attributes (mirroring the reaction marker) so the
    // model reads the coordinates and forwards them as ordinary tool arguments (issue #45). A pin
    // with neither coordinates nor title never gets here (location is null) and falls through to
    // the generic marker below.
    const coords =
      m.location.latitude !== null && m.location.longitude !== null
        ? ` latitude="${m.location.latitude}" longitude="${m.location.longitude}"`
        : "";
    // NOTE: The title is provider/user text inside a quoted pseudo-attribute — a double quote in it
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
  } else if (subject) {
    // The subject is the whole message. An email whose body is empty or a client footer is NOT a
    // blank message, and the branch below would have dropped the turn with the request in it.
    body = "";
  } else if (m.bodyImages) {
    // An email whose only content is an image in its body (issue #864). Unread ones are named
    // below. Nothing read and nothing unread is every image an ornament, or vision off, and neither
    // is a file to ask for again: the marker says only that there is nothing to read.
    body = naoLidos ? "" : CORPO_SEM_CONTEUDO;
  } else {
    return ""; // nothing renderable → skip
  }

  // Only ALONGSIDE something that WAS read. When nothing was, the branch above already emitted the
  // "send it as text" marker, which asks for exactly the same thing — and two markers saying it is
  // noise the model has to reconcile. The case this exists for is the PARTIAL one: some files read,
  // others over the cap or unreadable, where the extraction that succeeded would otherwise make the
  // message look complete (PR #692 review, rounds 1 and 3).
  // Or when no attachment marker was emitted at all: an image in an email body has no attachment
  // type, so a failed one would otherwise leave no trace beside the text (issue #864).
  if (naoLidos && (imageDescription || extractedText || types.size === 0))
    body = body ? `${body}\n${naoLidos}` : naoLidos;

  if (m.inReplyTo != null && ctx.resolveQuoted) {
    const quoted = ctx.resolveQuoted(m.inReplyTo);
    if (quoted) {
      const snippet = clipText(quoted.replace(/\s+/g, " ").trim(), QUOTE_MAX);
      if (snippet) body = `<em resposta a: "${snippet}">\n${body}`;
    }
  }
  // OUTERMOST, and after the quote marker for that reason: the quote is context for the body, the
  // subject is the envelope both sit in — and an email client shows it above everything else.
  if (subject) {
    const marker = `<assunto>${subject}</assunto>`;
    body = body ? `${marker}\n${body}` : marker;
  }
  return body;
}
