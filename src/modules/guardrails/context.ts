import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import {
  CONVERSATION_DIVIDER,
  HUMAN_AGENT_NOTE,
  isConversationDivider,
  isHumanAgentTurn,
  isNudgeTurn,
  isSystemMarker,
  lastStampedConversationId,
} from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
import { DATA_FENCE } from "@/graph/nudge";
import { clipText } from "@/lib/text";
import { selectClosedPrefix } from "@/modules/memory/cut";

// The earlier messages the input guardrail reads beside the customer's current one, as context it
// never judges. Taken from the thread the agent itself answers from, oldest first, and only from the
// attendance that is open: what comes before a divider belongs to attendances that already closed.
// Tool traffic and the system's own notes (the memory head among them) are nobody's words and stay out.

export type GuardrailContextRole = "customer" | "assistant" | "attendant";

export interface GuardrailContextMessage {
  role: GuardrailContextRole;
  text: string;
}

// The thread's messages that belong to the conversation being screened, found from the stamp each
// message carries, as the memory cut finds them: a divider is not always written. A thread whose last
// stamped attendance is another conversation is starting this one, and has nothing of it yet.
export function openAttendance(
  messages: readonly BaseMessage[],
  conversationId: number,
): BaseMessage[] {
  const { open } = selectClosedPrefix([...messages], {
    currentAttendanceClosed: false,
  });
  const current = lastStampedConversationId(open);
  return current === null || current === conversationId ? open : [];
}

// Per message, so one pasted document cannot crowd out the question the window is there to carry.
export const CONTEXT_MESSAGE_MAX = 1000;

// A proactive nudge, or the playground's simulated follow-up. DATA_FENCE catches the ones written
// before the marker, as the summarizer does: renderNudge always embeds it.
function isNudge(m: BaseMessage): boolean {
  return (
    isNudgeTurn(m) ||
    (m.getType() === "human" && contentToText(m.content).includes(DATA_FENCE))
  );
}

export function guardrailContext(
  messages: readonly BaseMessage[],
  limit: number,
): GuardrailContextMessage[] {
  const out: GuardrailContextMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (!m) break;
    const type = m.getType();
    let text = contentToText(m.content).trim();
    if (isConversationDivider(m)) {
      // NOTE: ingestion folds the divider into the customer's first message of the attendance.
      if (text.startsWith(CONVERSATION_DIVIDER))
        text = text.slice(CONVERSATION_DIVIDER.length).trim();
      if (text) out.push({ role: "customer", text });
      break;
    }
    if (isHumanAgentTurn(m)) {
      if (text.startsWith(HUMAN_AGENT_NOTE))
        text = text.slice(HUMAN_AGENT_NOTE.length).trim();
      if (text) out.push({ role: "attendant", text });
      continue;
    }
    if (isSystemMarker(m) || isNudge(m) || !text) continue;
    // NOTE: only a message that calls nothing is a reply. Text beside a call is the agent thinking
    // between rounds, or a reply the runtime recovers only under conditions the thread does not
    // record, so it stays out rather than putting words the customer may never have read in context.
    if (type === "ai" && ((m as AIMessage).tool_calls?.length ?? 0) > 0)
      continue;
    if (type === "human") out.push({ role: "customer", text });
    else if (type === "ai") out.push({ role: "assistant", text });
  }
  return out
    .reverse()
    .map((c) => ({ ...c, text: clipText(c.text, CONTEXT_MESSAGE_MAX) }));
}
