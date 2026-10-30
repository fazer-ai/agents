import type { BaseMessage } from "@langchain/core/messages";
import {
  DATA_FENCE,
  isNudgeTurn,
  isSystemMarker,
  stampedBurstStart,
  stampedConversationId,
  stampedSentAt,
  stampedSource,
} from "./markers";

// The residue of failed attempts, taken out of the history before the model reads it. Only inputs
// with no model output between them are compared, and the last copy stays, so an event's facts are
// kept once and the thread's newest message is never removed. A copy names the same source (the
// occasion of a nudge, the message a reactive turn answers) as a later input; an input written before
// inputs carried a source is matched by what it carries instead: a directive by the event inside its
// data fence, a customer input by its text and stamps. An ingested message is never a copy. See
// docs/graph.md, "What a failed attempt leaves in the thread".

function isHumanInput(m: BaseMessage): boolean {
  return m.getType() === "human";
}

function sameSource(
  a: BaseMessage,
  b: BaseMessage,
  unsourced: () => boolean,
): boolean {
  if (stampedConversationId(a) !== stampedConversationId(b)) return false;
  const sa = stampedSource(a);
  const sb = stampedSource(b);
  if (sa !== null || sb !== null) return sa === sb;
  return unsourced();
}

// The elapsed time the two follow-ups state in their summary, which grows between attempts.
const ELAPSED = [
  /(inactive for about )\d+( minutes)/g,
  /(asked the customer )\d+( minutes ago)/g,
];
const TRANSCRIPT_HEADER = "conversation, oldest first";
const TEXT_HEADER = "text (";

// The event a directive without a source describes: the facts line and the event's own text inside
// the data fence, which every attempt renders the same. What an attempt renders differently is left
// out: the directive line (another one once a person takes over), the operator guidance (edited
// between attempts), the transcript (it grows) and the elapsed time in the facts. Null when the text
// is not the renderer's shape.
function directiveEvent(text: string): string | null {
  const lines = text.split("\n");
  const open = lines.findIndex((l) => l.startsWith(`${DATA_FENCE} `));
  const close = lines.lastIndexOf(DATA_FENCE);
  if (open < 0 || close <= open + 1) return null;
  const facts = ELAPSED.reduce(
    (line, re) => line.replace(re, "$1N$2"),
    lines[open + 1] as string,
  );
  const data = [facts];
  let inTranscript = false;
  for (const line of lines.slice(open + 2, close)) {
    if (line.startsWith(TRANSCRIPT_HEADER)) inTranscript = true;
    else if (line.startsWith(TEXT_HEADER)) inTranscript = false;
    if (!inTranscript) data.push(line);
  }
  return data.join("\n");
}

// Two sources compare as sources: a retry carries the same one, and two deliveries that render the
// same event are still two events. A directive without a source is compared by the event it
// carries, against a later one with or without a source: left unanswered, its facts are the later
// one's, so removing it loses nothing.
function sameDirective(a: BaseMessage, b: BaseMessage): boolean {
  if (stampedConversationId(a) !== stampedConversationId(b)) return false;
  const sa = stampedSource(a);
  const sb = stampedSource(b);
  if (sa !== null && sb !== null) return sa === sb;
  if (typeof a.content !== "string" || typeof b.content !== "string")
    return false;
  const ea = directiveEvent(a.content);
  const eb = directiveEvent(b.content);
  if (ea !== null && eb !== null) return ea === eb;
  return sa === null && sb === null && a.content === b.content;
}

// A turn's customer input: named by its source or dated, and not an ingested message.
function isTurnInput(m: BaseMessage): boolean {
  return (
    !isSystemMarker(m) &&
    !(typeof m.id === "string" && m.id.startsWith("ingest:")) &&
    typeof m.content === "string" &&
    (stampedSource(m) !== null || stampedSentAt(m) !== null)
  );
}

function sameTurnInput(a: BaseMessage, b: BaseMessage): boolean {
  return sameSource(
    a,
    b,
    () =>
      a.content === b.content &&
      stampedSentAt(a)?.getTime() === stampedSentAt(b)?.getTime() &&
      stampedBurstStart(a)?.getTime() === stampedBurstStart(b)?.getTime(),
  );
}

function residueOfRun(
  run: BaseMessage[],
  out: { ids: string[]; directives: number; duplicates: number },
) {
  for (let i = 0; i < run.length; i++) {
    const m = run[i] as BaseMessage;
    if (typeof m.id !== "string") continue;
    if (isNudgeTurn(m)) {
      if (
        run
          .slice(i + 1)
          .some((later) => isNudgeTurn(later) && sameDirective(m, later))
      ) {
        out.ids.push(m.id);
        out.directives += 1;
      }
      continue;
    }
    if (
      isTurnInput(m) &&
      run.some(
        (later, j) => j > i && isTurnInput(later) && sameTurnInput(later, m),
      )
    ) {
      out.ids.push(m.id);
      out.duplicates += 1;
    }
  }
}

export function unansweredInputs(messages: BaseMessage[]): {
  ids: string[];
  directives: number;
  duplicates: number;
} {
  const out = { ids: [] as string[], directives: 0, duplicates: 0 };
  let run: BaseMessage[] = [];
  for (const m of messages) {
    if (isHumanInput(m)) {
      run.push(m);
      continue;
    }
    residueOfRun(run, out);
    run = [];
  }
  residueOfRun(run, out);
  return out;
}
