import type { BaseMessage } from "@langchain/core/messages";
import {
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
// inputs carried a source is matched by its text and stamps instead. An ingested message is never a
// copy. See docs/graph.md, "What a failed attempt leaves in the thread".

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

function sameDirective(a: BaseMessage, b: BaseMessage): boolean {
  return sameSource(
    a,
    b,
    () => typeof a.content === "string" && a.content === b.content,
  );
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
