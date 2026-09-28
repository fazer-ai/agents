// Which characters a document can actually PRINT. The standard 14 PDF fonts use WinAnsiEncoding,
// and pdfkit writes an unmapped UTF-16 unit above 255 as two bytes the reader draws as unrelated
// Latin-1 glyphs (中 prints as "-"), silently. So such text is REFUSED, at the keyboard and at the
// turn, never stripped. The rule is pdfkit's: tests/modules/document-printable.test.ts holds this
// copy to the renderer in both directions.
const WIN_ANSI_ABOVE_LATIN1 = new Set([
  338, 339, 352, 353, 376, 381, 382, 402, 710, 732, 8211, 8212, 8216, 8217,
  8218, 8220, 8221, 8222, 8224, 8225, 8226, 8230, 8240, 8249, 8250, 8364, 8482,
]);

// The only control the page has a shape for: a text block is legitimately several lines, which is
// why sanitizeDocumentValue keeps this one and turns every other control into a space.
const LINE_FEED = 0x0a;

function isControl(code: number): boolean {
  // C0, DEL, and C1. The WinAnsi extras that LOOK like they live at 0x80–0x9F (€, curly quotes) are
  // Unicode code points elsewhere — U+20AC, U+2018 — so nothing printable is caught here.
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

export function isPrintableCodeUnit(code: number): boolean {
  if (code === LINE_FEED) return true;
  // Controls are drawn as `.notdef` by the standard fonts — an empty box at the end of every line
  // for a value pasted with CRLF — and a NUL is worse than that: Postgres refuses it in text and
  // jsonb outright, so it turns an authored template into a 500 at the INSERT rather than a
  // refusal anyone can act on.
  if (isControl(code)) return false;
  return code <= 255 || WIN_ANSI_ABOVE_LATIN1.has(code);
}

// The offending characters, in order and without repeats, so a refusal can quote them. Empty when
// the text prints as written.
export function unprintableCharacters(text: string): string[] {
  const found: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // A character outside the BMP is two code units, and BOTH are unmapped — reported once, as the
    // character the operator actually typed.
    const printable = code > 0xffff ? false : isPrintableCodeUnit(code);
    if (!printable && !found.includes(ch)) found.push(ch);
  }
  return found;
}

// The refusal, phrased for whoever hit it: an operator writing a template, or a model filling a
// field in. It names the characters, because "this text cannot be printed" about a 2,000-character
// block is not something anyone can act on.
export function unprintableProblem(text: string, what: string): string | null {
  const bad = unprintableCharacters(text);
  if (bad.length === 0) return null;
  // A control has no shape to quote, and pasting one into the message would put it in a log line and
  // an API response. Named by code point instead, which is also what a caller has to search for.
  const named = bad.map((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return isControl(code)
      ? `U+${code.toString(16).toUpperCase().padStart(4, "0")}`
      : ch;
  });
  return `${what} contains characters this document cannot print (${named.join(" ")}) — the PDF fonts cover Latin text only, and printing them anyway would put a different character in the document.`;
}
