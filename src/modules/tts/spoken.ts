// What an audio reply says, and what it hands over in writing (issue #787). A URL or an e-mail
// address read aloud is useless (nobody copies from a voice note), and prepareSpeechText turned a
// markdown link into its label, so its URL reached the customer by no path at all. Measured on a
// production instance, 8,000 audio replies: e-mail in 602 (125 read aloud), link in 896 (750 read
// aloud, 146 never delivered).
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
  item: string;
  // What the span becomes in the speech: a markdown link keeps its label.
  spoken: string;
}

export function planSpokenReply(text: string): SpokenReplyPlan {
  const candidates: Span[] = [];
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    candidates.push(span(text, m.index, m[0].length, m[3] ?? "", m[1] ?? ""));
  }
  for (const m of text.matchAll(URL)) {
    const item = trimUrl(m[0], text[m.index - 1] ?? "");
    candidates.push(span(text, m.index, item.length, item, ""));
  }
  for (const m of text.matchAll(EMAIL)) {
    candidates.push(span(text, m.index, m[0].length, m[0], ""));
  }
  if (candidates.length === 0)
    return { speech: text, written: [], textOnly: false };

  // Overlaps resolve to the longest match: the whole address over the `www.` host inside it, the
  // whole URL over an address in its query, a markdown link over the target inside it.
  const spans: Span[] = [];
  for (const c of [...candidates].sort(
    (a, b) => b.end - b.start - (a.end - a.start),
  )) {
    if (spans.every((s) => c.end <= s.start || c.start >= s.end)) spans.push(c);
  }
  spans.sort((a, b) => a.start - b.start);

  let speech = "";
  let at = 0;
  for (const s of spans) {
    speech += text.slice(at, s.start) + s.spoken;
    at = s.end;
  }
  speech = tidy(speech + text.slice(at));
  const words = speech.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  return {
    speech,
    written: [...new Set(spans.map((s) => s.item))],
    textOnly: words.length <= INTRODUCTION_MAX_WORDS,
  };
}

// The item's span, widened over a formatting run that wraps it symmetrically, and over a markdown
// autolink's angle brackets.
function span(
  text: string,
  start: number,
  length: number,
  item: string,
  spoken: string,
): Span {
  let s = start;
  let e = start + length;
  for (;;) {
    const open = text[s - 1] ?? "";
    const close = text[e] ?? "";
    const wraps =
      (isWrapper(open) && open === close) || (open === "<" && close === ">");
    if (!wraps) break;
    s--;
    e++;
  }
  return { start: s, end: e, item, spoken };
}

// The sentence's punctuation, the closing half of a wrapper the URL sits in, and a closing
// parenthesis the URL did not open are the greedy match's, not the URL's. A wrapper character with
// no opening twin before the URL is the URL's own (`.../ingresso_`).
function trimUrl(m: string, before: string): string {
  let u = m;
  for (;;) {
    const last = u.at(-1) ?? "";
    const unbalanced =
      last === ")" &&
      (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0);
    if (
      TRAILING_PUNCTUATION.test(last) ||
      (isWrapper(last) && last === before) ||
      unbalanced
    ) {
      u = u.slice(0, -1);
    } else {
      return u;
    }
  }
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
