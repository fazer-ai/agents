import type { BaseMessage } from "@langchain/core/messages";
import {
  isNudgeTurn,
  isSystemMarker,
  stampedBurstStart,
  stampedConversationId,
  stampedSentAt,
} from "./markers";

// The residue of failed attempts, taken out of the history before the model reads it. Only inputs
// with no model output between them are compared, and only exact copies are removed: a nudge
// directive repeated word for word, and a turn's customer input with the same text and the same
// sent-at and burst-start stamps. The last copy stays, so an event's facts are kept once and the
// thread's newest message is never removed. An ingested message is never a copy: its id comes from the Chatwoot message, so a retry of
// it replaces instead of appending, and two of them in one second are two messages. See docs/graph.md, "What a failed attempt leaves in the thread".

function isHumanInput(m: BaseMessage): boolean {
  return m.getType() === "human";
}

function sameDirective(a: BaseMessage, b: BaseMessage): boolean {
  return (
    typeof a.content === "string" &&
    a.content === b.content &&
    stampedConversationId(a) === stampedConversationId(b)
  );
}

// A turn's customer input: dated, and not an ingested message.
function isTurnInput(m: BaseMessage): boolean {
  return (
    !isSystemMarker(m) &&
    !(typeof m.id === "string" && m.id.startsWith("ingest:")) &&
    typeof m.content === "string" &&
    stampedSentAt(m) !== null
  );
}

function sameTurnInput(a: BaseMessage, b: BaseMessage): boolean {
  return (
    a.content === b.content &&
    stampedSentAt(a)?.getTime() === stampedSentAt(b)?.getTime() &&
    stampedBurstStart(a)?.getTime() === stampedBurstStart(b)?.getTime() &&
    stampedConversationId(a) === stampedConversationId(b)
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
