import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import {
  isNudgeTurn,
  isSystemMarker,
  stampedBurstStart,
  stampedConversationId,
  stampedSentAt,
} from "./markers";

// The residue of failed attempts, taken out of the history before the model reads it: a nudge
// directive no model output followed, and a customer input that is an exact copy (same text, same
// stamps) of an earlier one with no finished answer between them, where the first stays. Recognised
// by metadata, never by text a customer could type, and an unstamped input is never taken for a
// copy. See docs/graph.md, "What a failed attempt leaves in the thread".

function isHumanInput(m: BaseMessage | undefined): boolean {
  return m !== undefined && m.getType() === "human";
}

// An answer the model finished: a retry never resumes past one, so an input before it is not
// something a later copy could repeat. A message that only calls tools is progress, not an answer.
function isCompletedReply(m: BaseMessage): boolean {
  return (
    m.getType() === "ai" && ((m as AIMessage).tool_calls?.length ?? 0) === 0
  );
}

function sameCustomerInput(a: BaseMessage, b: BaseMessage): boolean {
  if (isSystemMarker(a) || isSystemMarker(b)) return false;
  if (typeof a.content !== "string" || a.content !== b.content) return false;
  const sentA = stampedSentAt(a)?.getTime() ?? null;
  const burstA = stampedBurstStart(a)?.getTime() ?? null;
  if (sentA === null && burstA === null) return false;
  return (
    sentA === (stampedSentAt(b)?.getTime() ?? null) &&
    burstA === (stampedBurstStart(b)?.getTime() ?? null) &&
    stampedConversationId(a) === stampedConversationId(b)
  );
}

export function unansweredInputs(messages: BaseMessage[]): {
  ids: string[];
  directives: number;
  duplicates: number;
} {
  const ids: string[] = [];
  let directives = 0;
  let duplicates = 0;
  const inputs: BaseMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as BaseMessage;
    if (isCompletedReply(m)) inputs.length = 0;
    if (!isHumanInput(m)) continue;
    const hasId = typeof m.id === "string";
    if (isNudgeTurn(m)) {
      if (hasId && isHumanInput(messages[i + 1])) {
        ids.push(m.id as string);
        directives += 1;
      }
      continue;
    }
    if (hasId && inputs.some((earlier) => sameCustomerInput(earlier, m))) {
      ids.push(m.id as string);
      duplicates += 1;
      continue;
    }
    inputs.push(m);
  }
  return { ids, directives, duplicates };
}
