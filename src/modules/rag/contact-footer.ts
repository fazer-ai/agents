// THE CONTACT FOOTER OF A RETRIEVED PASSAGE (issue #747).
//
// Help-center articles are written for a person browsing a site, and they end on a line of site
// navigation: "entre em contato com nosso atendimento pelo e-mail sac@…". Retrieved into an agent,
// that line is read as an instruction, and the agent escalates a conversation whose answer was in
// the article it just read. Measured on 183 real conversations, two independent batteries: with such
// an article in the search results the agent transferred when it should not have 4.7x and 5.7x as
// often. A prompt paragraph telling the model to ignore contact instructions from retrieved content
// moved nothing (26% vs 27%, p = 1.0); removing the line did. An annotation would lose the same way:
// it is more text competing with the line instead of the line being gone.
//
// So the line goes, at SEARCH time and per knowledge base, behind an operator's switch that is off
// by default. Search time and not ingest time because the article stays the authoritative source:
// nothing stored changes, and turning the switch off gives the passage back without re-indexing.
//
// What counts as a footer is deliberately narrow, because the cost of a false positive is losing a
// sentence of the answer:
//   - only at the END OF THE DOCUMENT: the passage that is its tail, or the one before it where the
//     chunks' overlap carried the head of that same footer (a paragraph that merely ends a middle
//     chunk and is not the document's footer is text the chunker happened to cut there);
//   - only trailing paragraphs, walked backwards, each one short and carrying an e-mail, a phone
//     number or an invitation to get in touch;
//   - never the whole passage: a passage that is nothing but a footer is kept as it is, since it may
//     be the answer to "how do I reach you".

import type { ChunkHit, ChunkRow } from "./sql";

export const CONTACT_FOOTER_MAX_CHARS = 280;
// A footer is one or two short blocks ("Dúvidas? Fale conosco." + "sac@… | (11) …"), plus at most a
// heading or a rule above them. Past that it is content with a contact in it.
const MAX_FOOTER_PARAGRAPHS = 3;

const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/i;
// A phone number as a contact line writes one: an international prefix, an area code in
// parentheses, or groups split by a separator ending in four digits ("11 3456-7890"), or a 0800
// line. A bare digit count is not enough, because the numbers an answer carries are digit runs too:
// a CEP ("01310-100"), a CPF ("123.456.789-00"), a date, an order number. Those are content.
const PHONE =
  /\+\d{1,3}[\s.-]?\(?\d{2,3}\)?[\s.-]?\d{4,5}[\s-]?\d{4}\b|\(\d{2,3}\)\s?\d{4,5}[\s-]?\d{4}\b|\b\d{2,3}[\s.-]\d{4,5}[\s-]\d{4}\b|\b0800[\s-]?\d{3}[\s-]?\d{4}\b/;
const INVITATION =
  /(entr(?:e|ar) em contato|fale conosco|fale com (?:a gente|o nosso|a nossa|nosso|nossa)|central de (?:atendimento|relacionamento)|atendimento ao cliente|\bsac\b|contact us|get in touch|reach out to us|contact our|contáctenos|póngase en contacto)/i;
// What a footer usually hangs under, and means nothing once the footer is gone.
const HEADING_OR_RULE = /^(#{1,6}\s+[^\n]*|[-*_]{3,})$/;

export function isContactFooterParagraph(paragraph: string): boolean {
  const p = paragraph.trim();
  if (!p || p.length > CONTACT_FOOTER_MAX_CHARS) return false;
  return EMAIL.test(p) || PHONE.test(p) || INVITATION.test(p);
}

// The passage without its trailing contact footer, or the passage unchanged when there is none (or
// when removing it would leave nothing).
export function stripContactFooter(content: string): string {
  // Split keeping the separators, so what stays is byte-for-byte what was there.
  // CRLF too: text posted through the API keeps its line endings, and the chunker keeps them.
  // A run of blank lines is ONE separator: split one by one, the empty paragraphs between them would
  // stop the backward walk before it reached the rest of the footer.
  const parts = content.split(/(\r?\n(?:[ \t]*\r?\n)+)/);
  const paragraphs = parts.filter((_, i) => i % 2 === 0);
  let run = 0;
  while (
    run < paragraphs.length &&
    isContactFooterParagraph(paragraphs[paragraphs.length - 1 - run] ?? "")
  )
    run++;
  // A longer run than a footer ever is is a list of channels, which is the article, not its footer.
  if (run === 0 || run > MAX_FOOTER_PARAGRAPHS || run === paragraphs.length)
    return content;
  let keep = paragraphs.length - run;
  while (keep > 1 && HEADING_OR_RULE.test((paragraphs[keep - 1] ?? "").trim()))
    keep--;
  // What stays has to be something besides headings: a page that is a title over its channels
  // ("# Suporte", then the e-mail and the phone) is the answer to "how do I reach you", and cutting
  // the channels would leave the title alone.
  if (
    !paragraphs.some(
      (p, i) => i < keep && p.trim() && !HEADING_OR_RULE.test(p.trim()),
    )
  )
    return content;
  // Array truncation, not a text cut: `parts` alternates paragraph and separator, so this keeps the
  // first `keep` paragraphs with the separators between them.
  parts.length = 2 * keep - 1;
  return parts.join("").trimEnd();
}

// How much of the document's end the query hands back to find its footer: three paragraphs at the
// cap, the separators and a heading above them fit with room to spare.
export const FOOTER_TAIL_CHARS = 1500;

// The shortest overlap read as the footer's head. The chunker cuts on paragraphs, then sentences,
// then words, so a chunk that ends inside the footer ends on a piece of it; below this length the
// match could be a short paragraph that merely starts like the footer does.
const MIN_FOOTER_OVERLAP = 12;

// The footer of a document, found on its tail: what stripContactFooter would remove there, starting
// at a paragraph (or a dangling heading above it), and everything of the tail before it. null when
// the document has none.
export interface DocumentFooter {
  footer: string;
  before: string;
}

export function footerOfDocument(tail: string): DocumentFooter | null {
  const kept = stripContactFooter(tail);
  // Nothing stripped leaves nothing past `kept`.
  const footer = tail.substring(kept.length).trim();
  if (!footer) return null;
  return {
    footer,
    before: tail.substring(0, tail.indexOf(footer, kept.length)),
  };
}

// A passage that is NOT the document's tail can still end inside its footer: chunks overlap, so the
// start of a two-paragraph footer lands at the end of the chunk before the last one. That passage
// ends on a paragraph that begins the footer, and it sits exactly where the footer does: the
// document, read up to that point, ends with the passage (or, for a passage longer than the tail
// the query returns, the passage ends with all of it). Wording alone is not enough, since an
// article can repeat its footer's sentence anywhere. The same safeguard as the tail: a passage that
// would keep nothing but headings is returned whole.
export function stripFooterOverlap(
  content: string,
  { footer, before }: DocumentFooter,
): string {
  const text = content.trimEnd();
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    const piece = text.substring(i + 1).trimStart();
    if (piece.length < MIN_FOOTER_OVERLAP || !footer.startsWith(piece))
      continue;
    const docUpTo = before + piece;
    if (!docUpTo.endsWith(text) && !text.endsWith(docUpTo)) continue;
    const start = text.length - piece.length;
    const kept = text.substring(0, start).trimEnd();
    const substantive = kept
      .split(/\r?\n(?:[ \t]*\r?\n)+/)
      .some((p) => p.trim() && !HEADING_OR_RULE.test(p.trim()));
    return substantive ? kept : content;
  }
  return content;
}

// A search row as the hit every reader gets: the footer gone when the base asks for it, and the
// deciding columns dropped either way. The tail of the document is cut by the footer walk; any other
// passage only where it ends on the head of the document's own footer.
export function passageOf({
  stripContactFooters,
  atDocumentEnd,
  documentTail,
  ...hit
}: ChunkRow): ChunkHit {
  if (!stripContactFooters) return hit;
  if (atDocumentEnd) {
    return { ...hit, content: stripContactFooter(hit.content) };
  }
  const doc = documentTail ? footerOfDocument(documentTail) : null;
  return doc ? { ...hit, content: stripFooterOverlap(hit.content, doc) } : hit;
}
