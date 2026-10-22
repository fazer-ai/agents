import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { replyWrittenThisTurn } from "@/graph/graph";
import {
  CONVERSATION_DIVIDER,
  HUMAN_AGENT_NOTE,
  isConversationDivider,
  isHumanAgentTurn,
  isSystemMarker,
  lastStampedConversationId,
} from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
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

// The assistant messages the customer actually read. A turn is answered only when it ends on an
// assistant message that calls nothing: that message when it has text, otherwise the text the runtime
// recovers from earlier in the turn (`replyWrittenThisTurn`). A turn cut short after a tool call
// answered nobody, and text beside a call is otherwise the agent thinking between rounds.
function deliveredReplies(messages: readonly BaseMessage[]): Set<number> {
  const out = new Set<number>();
  let end = messages.length - 1;
  while (end >= 0) {
    if (messages[end]?.getType() === "human") {
      end--;
      continue;
    }
    let start = end;
    while (start > 0 && messages[start - 1]?.getType() !== "human") start--;
    const last = messages[end];
    if (
      last?.getType() === "ai" &&
      ((last as AIMessage).tool_calls?.length ?? 0) === 0
    ) {
      if (contentToText(last.content).trim()) out.add(end);
      else if (replyWrittenThisTurn(messages.slice(0, end + 1))) {
        for (let i = end - 1; i >= start; i--) {
          const m = messages[i];
          if (m?.getType() === "ai" && contentToText(m.content).trim()) {
            out.add(i);
            break;
          }
        }
      }
    }
    end = start - 1;
  }
  return out;
}

export function guardrailContext(
  messages: readonly BaseMessage[],
  limit: number,
): GuardrailContextMessage[] {
  const delivered = deliveredReplies(messages);
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
    if (isSystemMarker(m) || !text) continue;
    if (type === "ai" && !delivered.has(i)) continue;
    if (type === "human") out.push({ role: "customer", text });
    else if (type === "ai") out.push({ role: "assistant", text });
  }
  return out
    .reverse()
    .map((c) => ({ ...c, text: clipText(c.text, CONTEXT_MESSAGE_MAX) }));
}
