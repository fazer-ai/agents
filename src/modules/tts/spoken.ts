// What an audio reply says, and what it hands over in writing (issue #787). A URL or an e-mail
// address read aloud is useless (nobody copies from a voice note), and prepareSpeechText turned a
// markdown link into its label, so its URL reached the customer by no path at all. Measured on a
// production instance, 8,000 audio replies: e-mail in 602 (125 read aloud), link in 896 (750 read
// aloud, 146 never delivered).
//
// Two invariants, and every rule below serves one of them: no item is ever in the speech, and every
// written item is exactly the destination, since it is the only copy the customer gets.
//
// Pure: the runtime and the playground both ask it, so the operator hears what the customer hears.

export interface SpokenReplyPlan {
  // The reply with every item taken out. The input itself when there is nothing to take out, so a
  // reply without links synthesizes byte for byte as it did before.
  speech: string;
  // The items, verbatim, in order of first appearance, each once.
  written: string[];
  // What is left to say is only the introduction of the items ("Segue o link:"): a three-word voice
  // note followed by the link is worse than the text alone, and one more billed message.
  textOnly: boolean;
}

// A path segment may carry one level of balanced parentheses (Wikipedia's `C_(language)`), and an
// escaped one (`\)`) is the destination's, never the link's end.
const TARGET = String.raw`(?:\\[()]|[^()\s]|\((?:\\[()]|[^()\s])*\))+`;
// CommonMark's inline link: the destination bare or in `<…>`, then an optional title in `"…"`,
// `'…'` or `(…)`. Group 1 is the label; groups 2/3 (angle) or 4/5 (bare) the `mailto:` and target.
const AUTOLINK =
  /<(?:(mailto:)([^<>\s]+)|((?:https?:\/\/|www\.)[^<>\s]+|[^<>\s@]+@[^<>\s@]+))>/gi;
const MARKDOWN_LINK = new RegExp(
  String.raw`\[([^\]\n]+)\]\(\s*(?:<(mailto:)?((?:\\[<>]|[^<>\n])+)>|(mailto:)?(${TARGET}))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)`,
  "g",
);
// A match never starts or ends inside a token: a written item that is only part of the destination
// sends the customer somewhere else. A formatting run may sit between the item and whitespace
// (`**https://…`), never between the item and a word (`abc_https://…`, `ops~billing@…`). CJK and
// fullwidth punctuation (`。`, `，`) ends a URL: it is the sentence's, and no URL holds it. Letters in
// those blocks (`佐々木`, fullwidth `ｗ`) are the URL's.
const URL =
  /(?<![\p{L}\p{N}\p{M}][*_~`]*)(?:https?:\/\/|www\.)[^\s<>`[[\u3000-\u303f\uff01-\uff65]--[\p{L}\p{N}\p{M}]]]+/giv;
// Unicode and `'` in the local part (`d'angelo@`), Unicode and punycode labels in the domain. An
// address starts only where a token starts (after whitespace, an opening bracket, a separator, a
// quote or formatting, the last two checked for pairing below), so a local part the class cannot
// hold (`john!doe.smith@`, `a!b'finance@`) is left alone, never cut to the piece after its last
// unsupported character.
const EMAIL =
  /(?<=^|[\s\p{Ps}\p{Pi}<:;,，：；、"'*_~`])[\p{L}\p{N}\p{M}_%+-][\p{L}\p{N}\p{M}._%+'-]*@(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}\p{M}])?\.)+\p{L}[\p{L}\p{N}\p{M}-]*(?![\p{L}\p{N}\p{M}-]|\.[\p{L}\p{N}])/gu;
// GFM's autolink rule, plus closing quotes: these end a sentence or a formatting run, not a link.
const TRAILING_PUNCTUATION = /[?!.,:*_~;'"»”]$/;
// Formatting that wraps an item (`code`, **bold**, _italic_, ~~strike~~): it leaves the speech with
// the item and never enters the written copy.
const WRAPPERS = "`*_~";
const INTRODUCTION_MAX_WORDS = 4;
// Unicode word boundaries (UAX #29), so a language written without spaces is not one long word.
const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
// `includes("")` is true, and the character before index 0 or past the end is "".
const isWrapper = (c: string) => c.length === 1 && WRAPPERS.includes(c);

interface Span {
  start: number;
  end: number;
  items: string[];
  // What the span becomes in the speech: a markdown link keeps its label, minus any item in it.
  spoken: string;
}

export function planSpokenReply(text: string): SpokenReplyPlan {
  const spans = itemSpans(text);
  if (spans.length === 0) return { speech: text, written: [], textOnly: false };
  const speech = tidy(splice(text, spans));
  const words = [...WORDS.segment(speech)].filter((w) => w.isWordLike);
  return {
    speech,
    written: [...new Set(spans.flatMap((s) => s.items))],
    textOnly: words.length <= INTRODUCTION_MAX_WORDS,
  };
}

function itemSpans(text: string): Span[] {
  const links: Span[] = [];
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    // The label goes through the same extraction, so an address or a URL used as its own label is
    // neither spoken nor lost; the target comes first, it is what the link points to.
    const label = m[1] ?? "";
    const inner = itemSpans(label);
    links.push(
      widen(
        text,
        m.index,
        m.index + m[0].length,
        [
          target(m[2] ?? m[4], m[3] ?? m[5] ?? ""),
          ...inner.flatMap((s) => s.items),
        ],
        splice(label, inner),
      ),
    );
  }
  // A CommonMark autolink says where it starts and ends, and a `mailto:` one hands over its
  // recipient the way an inline `mailto:` link does. Inside an inline link's `(<…>)` it is that link's.
  for (const m of text.matchAll(AUTOLINK)) {
    const end = m.index + m[0].length;
    if (!links.every((l) => end <= l.start || m.index >= l.end)) continue;
    const written = m[1] ? recipient(m[2] ?? "") : (m[3] ?? "");
    links.push(widen(text, m.index, m.index + m[0].length, [written], ""));
  }
  // Structure before text: bare items are searched only outside the links, so a greedy URL cannot
  // run across `[um](…),[outro](…)`. Blanking UTF-16 units keeps every index where it was.
  const units = text.split("");
  for (const l of links) units.fill(" ", l.start, l.end);
  const bare = units.join("");
  const candidates: Span[] = [];
  for (const m of bare.matchAll(URL))
    candidates.push(item(bare, m.index, m[0]));
  for (const m of bare.matchAll(EMAIL)) {
    // `*sales@`, `~sales@` and `'sales@` are valid addresses. A marker left unpaired after
    // widening, or a quote not closed right after the address, may be the address's own first
    // character, so the address is left alone rather than cut.
    const c = item(bare, m.index, m[0]);
    const before = bare[c.start - 1] ?? "";
    const quoted = before === "'" || before === '"';
    if (isWrapper(before) || (quoted && bare[c.end] !== before)) continue;
    candidates.push(c);
  }

  // Overlaps resolve to the longest match: the whole address over the `www.` host inside it, the
  // whole URL over an address in its query.
  const spans: Span[] = [...links];
  for (const c of [...candidates].sort(
    (a, b) => b.end - b.start - (a.end - a.start),
  )) {
    if (spans.every((s) => c.end <= s.start || c.start >= s.end)) spans.push(c);
  }
  return spans.sort((a, b) => a.start - b.start);
}

// A markdown destination is written in markdown: the link points to it after CommonMark decodes
// backslash escapes and character references (`Function_\(x\)`, `a=1&amp;b=2`, `&#38;`); of the
// named ones only those a URL can carry are decoded. A `mailto:` link hands over
// its recipient: `?subject=…` makes it neither the address nor a URI a chat client opens, and out
// of the URI its percent escapes would name another mailbox (`foo%2Bbar@` is `foo+bar@`).
function target(mailto: string | undefined, destination: string): string {
  // One pass, so what one replacement produces is never read as markdown again (`&amp;#38;` is
  // `&#38;`, `\&amp;` is `&amp;`).
  const decoded = destination.replace(
    /\\([!-/:-@[-`{-~])|&(amp|lt|gt|quot);|&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/g,
    (_, escaped?: string, named?: string, dec?: string, hex?: string) => {
      if (escaped) return escaped;
      if (named) return ENTITIES[named] ?? "";
      // CommonMark: an invalid code point decodes to U+FFFD.
      const cp = dec ? Number(dec) : Number.parseInt(hex ?? "", 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\uFFFD";
    },
  );
  // Delivered as bare text, a space would end the link where a renderer would have sent `%20`.
  return mailto
    ? recipient(decoded)
    : decoded.replace(/\s/g, (c) => encodeURIComponent(c));
}

function recipient(uri: string): string {
  const address = uri.split("?")[0] ?? "";
  try {
    return decodeURIComponent(address);
  } catch {
    return address;
  }
}
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
};

// A bare URL or address, cut down to the destination. What the greedy match took from around it is
// the sentence's: trailing punctuation or formatting, a closing bracket the destination did not
// open, and an opening `_` whose twin closes the address (an address's own `_` has none).
function item(text: string, start: number, match: string): Span {
  let s = start;
  let e = start + match.length;
  // Backticks say where the item ends: nothing inside them is the sentence's (`<…>` is an
  // autolink, parsed before any bare item).
  const delimited = text[s - 1] === "`" && text[e] === "`";
  for (; !delimited; ) {
    const first = text[s] ?? "";
    const last = text[e - 1] ?? "";
    if (TRAILING_PUNCTUATION.test(last) || unbalanced(text.slice(s, e), last))
      e--;
    else if (isWrapper(first) && first === text[e]) s++;
    else break;
  }
  return widen(text, s, e, [text.slice(s, e)], "");
}

// A closing bracket the item did not open (`(https://x.com.br)`, `[https://x.com.br]`) is the
// sentence's; a balanced one is the destination's (`C_(language)`, `?ids[]=1`).
function unbalanced(item: string, last: string): boolean {
  const open = last === ")" ? "(" : last === "]" ? "[" : "";
  if (!open) return false;
  const count = (c: string) => item.split(c).length - 1;
  return count(open) < count(last);
}

// The span, widened over a formatting run that wraps it symmetrically.
function widen(
  text: string,
  start: number,
  end: number,
  items: string[],
  spoken: string,
): Span {
  let s = start;
  let e = end;
  for (;;) {
    const open = text[s - 1] ?? "";
    const close = text[e] ?? "";
    if (!isWrapper(open) || open !== close) break;
    s--;
    e++;
  }
  return { start: s, end: e, items, spoken };
}

function splice(text: string, spans: Span[]): string {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + s.spoken;
    at = s.end;
  }
  return out + text.slice(at);
}

// The holes the items leave: doubled spaces, a space before punctuation, a comma right after
// another mark ("Dúvidas: , ou" becomes "Dúvidas: ou").
function tidy(s: string): string {
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/([.,;:!?])[,;]/g, "$1")
    .replace(/^[ ,;]+|[ \t]+$/gm, "")
    .trim();
}
