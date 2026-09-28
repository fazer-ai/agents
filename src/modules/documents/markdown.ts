// The tiny markdown a `text` block understands, and nothing more: **bold**, *italic* / _italic_,
// line breaks, and `- ` bullets. Deliberately not a markdown library: @react-pdf/renderer has no
// HTML, and a construct with no layout would print as its own source text, so the set maps 1:1 onto
// primitives the renderer draws. Pure and total: nothing throws, and an unmatched marker stays literal.

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export interface MarkdownLine {
  kind: "paragraph" | "bullet";
  spans: InlineSpan[];
}

const MARKERS: { token: string; key: "bold" | "italic" }[] = [
  { token: "**", key: "bold" },
  { token: "*", key: "italic" },
  { token: "_", key: "italic" },
];

// A marker only opens when its closer exists later on the same line. Without that lookahead, the
// asterisk in "3 * 4 = 12" turns the rest of the line italic, and an underscore in a file name eats
// everything after it.
function closerAt(text: string, from: number, token: string): number {
  return text.indexOf(token, from);
}

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buffer = "";
  let bold = false;
  // NOTE: The TOKEN that opened the current italic, not a boolean: in `_3 * 4_` the asterisk must
  // not close the underscore. While an italic is open the OTHER token is literal, since nested
  // emphasis has no representation and guessing wrong would change the text itself.
  let italicToken: string | null = null;

  const flush = () => {
    if (!buffer) return;
    spans.push({
      text: buffer,
      ...(bold ? { bold: true } : {}),
      ...(italicToken !== null ? { italic: true } : {}),
    });
    buffer = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    // A backslash escapes the next character, which is the only way to write a literal marker.
    if (ch === "\\" && i + 1 < text.length) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    const marker = MARKERS.find((m) => text.startsWith(m.token, i));
    if (marker) {
      // Open only against the SAME token: an italic opened with `_` is closed by `_` and by nothing
      // else, and while it is open an asterisk is just an asterisk.
      const open: boolean =
        marker.key === "bold" ? bold : italicToken === marker.token;
      const blocked = marker.key === "italic" && italicToken !== null && !open;
      const hasCloser =
        closerAt(text, i + marker.token.length, marker.token) !== -1;
      if (!blocked && (open || hasCloser)) {
        flush();
        if (marker.key === "bold") bold = !bold;
        else italicToken = open ? null : marker.token;
        i += marker.token.length;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return spans;
}

const BULLET_RE = /^\s*[-*•]\s+/;

export function parseSimpleMarkdown(text: string): MarkdownLine[] {
  return text.split("\n").map((raw) => {
    const bullet = BULLET_RE.test(raw);
    const body = bullet ? raw.replace(BULLET_RE, "") : raw;
    return {
      kind: bullet ? ("bullet" as const) : ("paragraph" as const),
      spans: parseInline(body),
    };
  });
}
