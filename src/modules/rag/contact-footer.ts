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
//   - only at the END OF THE DOCUMENT (the caller says whether this passage is its tail; a paragraph
//     that merely ends a middle chunk is text the chunker happened to cut there);
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
// A run of digits with the separators a phone number is written with; judged by its digit count so
// a date ("12/03/2026") or a price ("R$ 1.200,00") does not pass for one.
const PHONE_CANDIDATE = /\+?\(?\d[\d\s().-]{6,}\d/g;
const INVITATION =
  /(entr(?:e|ar) em contato|fale conosco|fale com (?:a gente|o nosso|a nossa|nosso|nossa)|central de (?:atendimento|relacionamento)|atendimento ao cliente|\bsac\b|contact us|get in touch|reach out to us|contact our|contáctenos|póngase en contacto)/i;
// What a footer usually hangs under, and means nothing once the footer is gone.
const HEADING_OR_RULE = /^(#{1,6}\s+[^\n]*|[-*_]{3,})$/;

function hasPhone(text: string): boolean {
  for (const m of text.matchAll(PHONE_CANDIDATE)) {
    const digits = m[0].replace(/\D/g, "").length;
    if (digits >= 8 && digits <= 15) return true;
  }
  return false;
}

export function isContactFooterParagraph(paragraph: string): boolean {
  const p = paragraph.trim();
  if (!p || p.length > CONTACT_FOOTER_MAX_CHARS) return false;
  return EMAIL.test(p) || hasPhone(p) || INVITATION.test(p);
}

// The passage without its trailing contact footer, or the passage unchanged when there is none (or
// when removing it would leave nothing).
export function stripContactFooter(content: string): string {
  // Split keeping the separators, so what stays is byte-for-byte what was there.
  const parts = content.split(/(\n[ \t]*\n)/);
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
  // Array truncation, not a text cut: `parts` alternates paragraph and separator, so this keeps the
  // first `keep` paragraphs with the separators between them.
  parts.length = 2 * keep - 1;
  return parts.join("").trimEnd();
}

// A search row as the hit every reader gets: the footer gone when the base asks for it and the
// passage is the tail of its document, and the two deciding columns dropped either way.
export function passageOf({
  stripContactFooters,
  atDocumentEnd,
  ...hit
}: ChunkRow): ChunkHit {
  return stripContactFooters && atDocumentEnd
    ? { ...hit, content: stripContactFooter(hit.content) }
    : hit;
}
