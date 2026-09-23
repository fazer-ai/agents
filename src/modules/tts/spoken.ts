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

// A path segment may carry one level of balanced parentheses (Wikipedia's `C_(language)`).
const TARGET = String.raw`(?:[^()\s]|\([^()\s]*\))+`;
// Group 1 is the label, group 3 the target without a `mailto:`.
const MARKDOWN_LINK = new RegExp(
  String.raw`\[([^\]\n]+)\]\(\s*(mailto:)?(${TARGET})\s*\)`,
  "g",
);
const URL = /\b(?:https?:\/\/|www\.)[^\s<>[\]`]+/gi;
const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const TRAILING_PUNCTUATION = /[.,;:!?'"»”]$/;
// Formatting that wraps an item (`code`, **bold**, _italic_, ~~strike~~): it leaves the speech with
// the item and never enters the written copy.
const WRAPPERS = "`*_~";
const INTRODUCTION_MAX_WORDS = 4;
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
  const words = speech.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  return {
    speech,
    written: [...new Set(spans.flatMap((s) => s.items))],
    textOnly: words.length <= INTRODUCTION_MAX_WORDS,
  };
}

function itemSpans(text: string): Span[] {
  const candidates: Span[] = [];
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    // The label goes through the same extraction, so an address or a URL used as its own label is
    // neither spoken nor lost; the target comes first, it is what the link points to.
    const label = m[1] ?? "";
    const inner = itemSpans(label);
    candidates.push(
      widen(
        text,
        m.index,
        m.index + m[0].length,
        [m[3] ?? "", ...inner.flatMap((s) => s.items)],
        splice(label, inner),
      ),
    );
  }
  for (const m of text.matchAll(URL))
    candidates.push(item(text, m.index, m[0]));
  for (const m of text.matchAll(EMAIL))
    candidates.push(item(text, m.index, m[0]));

  // Overlaps resolve to the longest match: the whole address over the `www.` host inside it, the
  // whole URL over an address in its query, a markdown link over everything inside it.
  const spans: Span[] = [];
  for (const c of [...candidates].sort(
    (a, b) => b.end - b.start - (a.end - a.start),
  )) {
    if (spans.every((s) => c.end <= s.start || c.start >= s.end)) spans.push(c);
  }
  return spans.sort((a, b) => a.start - b.start);
}

// A bare URL or address, cut down to the destination. What the greedy match took from around it is
// the sentence's: trailing punctuation, a closing parenthesis the destination did not open, and the
// halves of a wrapper, recognised by the twin on the other side (an address's own `_` has none).
function item(text: string, start: number, match: string): Span {
  let s = start;
  let e = start + match.length;
  for (;;) {
    const first = text[s] ?? "";
    const last = text[e - 1] ?? "";
    const opens = (text.slice(s, e).match(/\(/g) ?? []).length;
    const closes = (text.slice(s, e).match(/\)/g) ?? []).length;
    if (TRAILING_PUNCTUATION.test(last) || (last === ")" && opens < closes))
      e--;
    else if (isWrapper(last) && last === text[s - 1]) e--;
    else if (isWrapper(first) && first === text[e]) s++;
    else break;
  }
  return widen(text, s, e, [text.slice(s, e)], "");
}

// The span, widened over a formatting run that wraps it symmetrically, and over a markdown
// autolink's angle brackets.
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
    const wraps =
      (isWrapper(open) && open === close) || (open === "<" && close === ">");
    if (!wraps) break;
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
