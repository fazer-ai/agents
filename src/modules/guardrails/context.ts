import type {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  CONVERSATION_DIVIDER,
  HUMAN_AGENT_NOTE,
  isConversationDivider,
  isHumanAgentTurn,
  isNudgeTurn,
  isSystemMarker,
  lastStampedConversationId,
  stampedSentAt,
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
  for (const c of unclippedContext(messages, limit))
    if (c.role !== "tool")
      out.push({ role: c.role, text: clipText(c.text, CONTEXT_MESSAGE_MAX) });
  return out;
}

// A person's message carries the instant it was sent when the thread stored one, as the agent's
// dated history reads it; the agent's own lines are never dated. A `tool` entry is what a tool
// returned, present only when the reader asks for it.
export interface DatedContextMessage {
  role: GuardrailContextRole | "tool";
  text: string;
  at: Date | null;
  tool?: string;
}

// The same window with every message whole, for a reader that must not decide on a prefix of what
// someone said. `toolResultChars` also takes in each tool result, cut to that many characters: they
// are no one's words, and a reader may need them to tell which record an id in a call names.
export function unclippedContext(
  messages: readonly BaseMessage[],
  limit: number,
  opts?: { toolResultChars?: number },
): DatedContextMessage[] {
  return contextWindow(messages, limit, opts).out;
}

// Where that window begins: the index of the oldest message it shows, or of the divider that opens
// the attendance when the walk stops there; `messages.length` when it shows nothing. What lies from
// here on is what a reader of the window has in front of it.
export function contextWindowStart(
  messages: readonly BaseMessage[],
  limit: number,
): number {
  return contextWindow(messages, limit).start;
}

function contextWindow(
  messages: readonly BaseMessage[],
  limit: number,
  opts?: { toolResultChars?: number },
): { out: DatedContextMessage[]; start: number } {
  const out: DatedContextMessage[] = [];
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (!m) break;
    const type = m.getType();
    let text = contentToText(m.content).trim();
    if (isConversationDivider(m)) {
      // NOTE: ingestion folds the divider into the customer's first message of the attendance.
      if (text.startsWith(CONVERSATION_DIVIDER))
        text = text.slice(CONVERSATION_DIVIDER.length).trim();
      if (text) out.push({ role: "customer", text, at: stampedSentAt(m) });
      start = i;
      break;
    }
    const before = out.length;
    if (isHumanAgentTurn(m)) {
      if (text.startsWith(HUMAN_AGENT_NOTE))
        text = text.slice(HUMAN_AGENT_NOTE.length).trim();
      if (text) out.push({ role: "attendant", text, at: stampedSentAt(m) });
      if (out.length > before) start = i;
      continue;
    }
    if (isSystemMarker(m) || isNudge(m) || !text) continue;
    if (type === "tool") {
      if (opts?.toolResultChars) {
        out.push({
          role: "tool",
          text: clipText(text, opts.toolResultChars),
          at: null,
          tool: (m as ToolMessage).name ?? "",
        });
        start = i;
      }
      continue;
    }
    // NOTE: only a message that calls nothing is a reply. Text beside a call is the agent thinking
    // between rounds, or a reply the runtime recovers only under conditions the thread does not
    // record, so it stays out rather than putting words the customer may never have read in context.
    if (type === "ai" && ((m as AIMessage).tool_calls?.length ?? 0) > 0)
      continue;
    if (type === "human")
      out.push({ role: "customer", text, at: stampedSentAt(m) });
    else if (type === "ai") out.push({ role: "assistant", text, at: null });
    if (out.length > before) start = i;
  }
  return { out: out.reverse(), start };
}
