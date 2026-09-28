import type { BaseMessage } from "@langchain/core/messages";
import { isHumanHandback } from "./markers";

// Which slice of the persisted history travels to the model this turn. The thread is keyed per
// contact-inbox, so it spans every conversation the contact had on that channel and nothing prunes
// it; the provider's TPM limit counts cached tokens too, so resending ended attendances can silence
// the agent in front of a customer. Pure, so the rule is a table of cases
// (tests/graph/history-window.test.ts). Each rule noted below breaks the turn, not just shortens it,
// when violated. The system prompt is not counted: the caller prepends it, and counting it here would
// silently shrink the budget the operator configured.

export interface HistoryWindow {
  // The messages to send, oldest first.
  kept: BaseMessage[];
  // How many were dropped off the front. 0 means the history went through untouched.
  dropped: number;
  // Token total of `kept`, for the turn trail. Can exceed the ceiling when the turn being answered
  // alone does. Zero when nothing was counted (no ceiling configured, or no human boundary).
  tokens: number;
}

export function selectHistoryWindow(
  history: BaseMessage[],
  maxTokens: number | null | undefined,
  count: (message: BaseMessage) => number,
): HistoryWindow {
  const untouched = (): HistoryWindow => ({
    kept: history,
    dropped: 0,
    tokens: 0,
  });
  if (!maxTokens || history.length === 0) return untouched();

  let lastHuman = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.getType() === "human") {
      lastHuman = i;
      break;
    }
  }
  // NOTE: the window opens on a HUMAN message: opened on a ToolMessage whose tool_call was dropped,
  // the provider rejects the whole request (OpenAI 400). No human message anywhere means no safe place
  // to open, so the history is left alone rather than guessing a boundary.
  if (lastHuman < 0) return untouched();

  // NOTE: longest suffix that fits, counting each message once. Whole messages only (half a message
  // reads as the agent misquoting the customer), and it stops at the first that does not fit, because
  // a window has to be contiguous.
  const counted: number[] = new Array(history.length);
  const tokensAt = (i: number): number => {
    const cachedCount = counted[i];
    if (cachedCount !== undefined) return cachedCount;
    const message = history[i];
    const value = message ? count(message) : 0;
    counted[i] = value;
    return value;
  };
  let total = 0;
  let start = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const size = tokensAt(i);
    if (total + size > maxTokens) break;
    total += size;
    start = i;
  }

  // NOTE: nothing is dropped unless the budget demands it: a history that fits goes through as is,
  // even when it begins on a non-human message.
  if (start > 0) {
    while (start < history.length && history[start]?.getType() !== "human") {
      start++;
    }
    // NOTE: the turn being answered always travels, budget or not: a prompt with no customer message
    // is a broken turn, while going over a soft ceiling is only an expensive one. The ceiling bounds
    // ACCUMULATED history, not a single huge turn.
    if (start > lastHuman) start = lastHuman;
    // NOTE: a hand-back note right before the opener travels with it: once in the thread,
    // ./handback.ts reads it as announced and never writes another, so losing it here leaves the turn
    // answering from the transfer context for the rest of the conversation.
    if (start > 0 && isHumanHandback(history[start - 1] as BaseMessage)) {
      start--;
    }
  }

  let tokens = 0;
  for (let i = start; i < history.length; i++) tokens += tokensAt(i);
  return { kept: history.slice(start), dropped: start, tokens };
}
