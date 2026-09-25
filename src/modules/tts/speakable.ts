// Whether a reply works as speech at all (issue #856). #787 took the URLs and the e-mail addresses
// out of a voice note; this is the reply as a whole. A price table, a numbered walkthrough or a
// 1,000-character answer is built to be read: heard, the customer cannot scan back, cannot compare
// two prices, and replays the note to catch the one number they needed. Measured on a production
// deployment's voice replies, reviewed by hand: 17 of 27 would have been better as text (longer than
// ~450 characters 13, a list of 3+ items 8, 3+ money values or long numbers 6, a link 5).
//
// The model cannot fix it: it does not know the reply will become audio (the runtime decides after
// generation), and the speech rewrite has to keep every fact. So the runtime decides, before
// synthesis, deterministically and without a model: a reply past any of the agent's limits goes as
// text. A text reply costs the same one message as a voice note, so nothing is added. It is the
// agent's choice (`tts.textInstead`, off by default), so updating the service changes no agent.
//
// Pure, like `planSpokenReply`: the runtime and the playground both ask it, so the operator hears
// what the customer hears. `unspeakable` is the decision on its own, with no plan and no log, for
// any other caller that has to choose a turn's modality from a text and the agent's settings.

import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import type { TtsConfig } from "./settings-shared";
import { planSpokenReply, type SpokenReplyPlan } from "./spoken";

export type UnspeakableCriterion = "length" | "list" | "numbers";

export interface SpeakabilityVerdict {
  criterion: UnspeakableCriterion;
  // What the reply measured, and the agent's limit it reached.
  value: number;
  limit: number;
}

export type SpeakabilityLimits = Pick<
  TtsConfig,
  "textInstead" | "textOverChars" | "textOverListItems" | "textOverNumbers"
>;

// A list item: a line that opens with a bullet (`-`, `*`, `+`, `•`, `◦`, `▪`, `–`) or a number
// followed by `.` or `)`. Indentation is allowed, so a nested list counts every level, which is
// right: every level is more to hold in the ear.
const LIST_ITEM = /^[ \t]*(?:[-*+•◦▪–][ \t]+\S|\d{1,3}[.)][ \t]+\S)/u;
// A step number set in bold or italics (`**1.** Entre`): the marks around the number are layout.
const EMPHASIZED_STEP = /^([ \t]*)[*_]+(\d{1,3}[.)])[*_]+/u;
const isListItem = (line: string) =>
  LIST_ITEM.test(line.replace(EMPHASIZED_STEP, "$1$2"));
// A markdown table's delimiter row (`|---|:--:|`, or `--- | ---` without the outer pipes). Tested
// only on lines that hold a pipe, so a bare `---` (a horizontal rule) never takes an item away.
const TABLE_SEPARATOR =
  /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/u;
// A table row written with both outer pipes, which reads as one even without a delimiter row.
const PIPED_ROW = /^[ \t]*\|.*\|[ \t]*$/u;
// A money value (a currency sign or code on either side of a number, `R$ 1.200,00`, `$12.50`,
// `€ 30`, `30 €`, `10 USD`, `300 reais`), or any other number of 4+ digits (an order, a protocol, a
// total written without a sign). Separators inside the number are kept (`1.200,00`), so one value
// counts once, and a sign on both sides (`R$ 10 reais`) is one value too: the prefix match takes the
// number, and the word after it has none left to pair with.
const MONEY =
  /(?:R\$|US\$|\$|€|£|¥|\b(?:BRL|USD|EUR)\b)[ \t\u00a0]*\d[\d.,\u00a0]*|\d[\d.,\u00a0]*[ \t\u00a0]*(?:reais|real|dólares|dolares|euros|pesos|BRL|USD|EUR|R\$|US\$|\$|€|£|¥)(?![\p{L}\p{N}])/giu;
const NUMBER = /\d(?:[\d.,]*\d)?/gu;

function countListItems(text: string): number {
  const lines = text.split(/\r?\n/);
  let n = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.includes("|")) {
      if (isListItem(line)) n += 1;
      i += 1;
      continue;
    }
    // A run of lines with pipes. With a delimiter row it is a table, and every other line of it is
    // a row, outer pipes or not (GFM allows both); without one, only lines fenced by pipes count.
    let end = i;
    while (end < lines.length && (lines[end] as string).includes("|")) end += 1;
    const block = lines.slice(i, end);
    const isTable = block.some((l) => TABLE_SEPARATOR.test(l));
    for (const l of block) {
      if (TABLE_SEPARATOR.test(l)) continue;
      if (isTable || PIPED_ROW.test(l) || isListItem(l)) n += 1;
    }
    i = end;
  }
  return n;
}

// Inline emphasis and code marks (`R$ **30**`, `_60 €_`, `` `1234` ``): layout, not part of a value,
// and a matcher that has to step over them would miss the formatted price the model likes best.
const INLINE_MARKS = /[*_`~]+/gu;

function countNumbers(text: string): number {
  let n = 0;
  // Money first, blanked out, so its digits are not counted a second time as a long number.
  const rest = text.replace(INLINE_MARKS, "").replace(MONEY, () => {
    n += 1;
    return " ";
  });
  for (const m of rest.matchAll(NUMBER)) {
    if (m[0].replace(/\D/g, "").length >= 4) n += 1;
  }
  return n;
}

// The first limit the reply reaches, or null when it is speakable (or the switch or every limit is
// off). `text` is the speech as `planSpokenReply` leaves it: the URLs and addresses are already out,
// since they go in writing either way and should not push a short answer over the length limit.
export function unspeakable(
  text: string,
  limits: SpeakabilityLimits,
): SpeakabilityVerdict | null {
  if (!limits.textInstead) return null;
  const chars = limits.textOverChars;
  if (chars != null && text.trim().length > chars) {
    return { criterion: "length", value: text.trim().length, limit: chars };
  }
  const items = limits.textOverListItems;
  if (items != null) {
    const value = countListItems(text);
    if (value >= items) return { criterion: "list", value, limit: items };
  }
  const numbers = limits.textOverNumbers;
  if (numbers != null) {
    const value = countNumbers(text);
    if (value >= numbers)
      return { criterion: "numbers", value, limit: numbers };
  }
  return null;
}

export interface AudioReplyPlan extends SpokenReplyPlan {
  // Why the reply goes as text when audio was on the table: the #787 case (nothing but the
  // introduction of a link is left to say) or the first limit it reached. null = it is spoken.
  textReason: "introduction" | SpeakabilityVerdict | null;
}

// The one question both the runtime and the playground ask before synthesizing: what the voice note
// says, what follows it in writing, and whether there should be a voice note at all.
export function planAudioReply(
  text: string,
  limits: SpeakabilityLimits,
): AudioReplyPlan {
  const spoken = planSpokenReply(text);
  if (spoken.textOnly) return { ...spoken, textReason: "introduction" };
  const verdict = unspeakable(spoken.speech, limits);
  return verdict
    ? { ...spoken, textOnly: true, textReason: verdict }
    : { ...spoken, textReason: null };
}

// The `tts` line of a reply that would have been audio and went as text. `info`, because it is the
// agent doing what it was configured to do; what fired and the numbers are the whole point, so an
// operator can tell a limit set too low from a reply that really was a price table. Numbers and a
// closed vocabulary only: never a fragment of the reply.
export function logTextInsteadOfAudio(
  flow: FlowContext | undefined,
  plan: AudioReplyPlan,
): void {
  if (!flow || !plan.textOnly || plan.textReason === null) return;
  const r = plan.textReason;
  emitFlowEvent(flow, {
    stage: "tts",
    level: "info",
    status: "skipped",
    detail:
      r === "introduction"
        ? { sentAsText: "introduction" }
        : { sentAsText: r.criterion, value: r.value, limit: r.limit },
  });
}
