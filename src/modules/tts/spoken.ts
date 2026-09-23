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

// Group 1 is the label, group 3 the target without a `mailto:`.
const MARKDOWN_LINK = /\[([^\]\n]+)\]\(\s*(mailto:)?([^)\s]+)\s*\)/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi;
const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// The sentence's own punctuation, which the greedy URL match swallows.
const TRAILING = /[.,;:!?'"»”]+$/;
const INTRODUCTION_MAX_WORDS = 4;

export function planSpokenReply(text: string): SpokenReplyPlan {
  // Each pass blanks what it took, so the next one cannot match inside it and every position stays
  // a position in the original text, which is what "order of first appearance" is measured in.
  const items: Array<{ at: number; item: string }> = [];
  const blank = (m: string) => " ".repeat(m.length);
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    items.push({ at: m.index, item: m[3] ?? "" });
  }
  const noMarkdown = text.replace(MARKDOWN_LINK, blank);
  for (const m of noMarkdown.matchAll(URL)) {
    items.push({ at: m.index, item: m[0].replace(TRAILING, "") });
  }
  for (const m of noMarkdown.replace(URL, blank).matchAll(EMAIL)) {
    items.push({ at: m.index, item: m[0] });
  }
  if (items.length === 0) return { speech: text, written: [], textOnly: false };

  items.sort((a, b) => a.at - b.at);
  const speech = tidy(
    text
      .replace(MARKDOWN_LINK, (_m, label: string) => label)
      .replace(URL, (m) => m.slice(m.replace(TRAILING, "").length))
      .replace(EMAIL, ""),
  );
  const words = speech.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  return {
    speech,
    written: [...new Set(items.map((i) => i.item))],
    textOnly: words.length <= INTRODUCTION_MAX_WORDS,
  };
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
