import type { BaseMessage } from "@langchain/core/messages";

// Which slice of the persisted history travels to the model this turn.
//
// The checkpointer thread is keyed per contact-inbox, so it spans EVERY conversation that contact
// ever had on that channel, and nothing prunes it. Measured on a production instance: 79,862 tokens
// of context against a 15,806-token floor of prompt + tool definitions, i.e. ~64k of attendances
// that had already ended, re-sent on every turn. The bill is the smaller half of that; what silences
// the agent in front of a customer is the provider's TPM limit, which counts cached tokens too.
//
// Pure on purpose: no model, no database, no clock. The rule is a decision, and a decision belongs
// in a table of cases (tests/graph/history-window.test.ts) rather than behind a live turn.
//
// THE FOUR INVARIANTS, each of which breaks the turn rather than shortening it when violated:
//
//   1. The window opens on a HUMAN message. Open it on a ToolMessage whose originating tool_call
//      was just dropped and the provider rejects the whole request (OpenAI 400), so the naive
//      "keep the last N tokens" fails hardest on precisely the longest conversations.
//   2. Whole messages only. Half a message reads as the agent misquoting the customer.
//   3. The window is never empty, and never opens after the turn being answered. If the last human
//      message and what follows it do not fit the budget, they travel anyway: sending the model a
//      system prompt with no customer message is a broken turn, while going over a soft ceiling is
//      just an expensive one. The ceiling bounds ACCUMULATED history, not a single huge turn.
//   4. Nothing is dropped unless the budget actually demands it. When the whole history fits, it
//      goes through untouched — including a history that happens to start on a non-human message,
//      where invariant 1 would otherwise drop messages for no reason at all.
//
// The system prompt is not counted: it is prepended per turn by the caller and is never part of
// `history`, so counting it here would silently shrink the budget the operator configured.

export interface HistoryWindow {
  // The messages to send, oldest first.
  kept: BaseMessage[];
  // How many were dropped off the front. 0 means the history went through untouched.
  dropped: number;
  // Token total of `kept`, for the turn trail. Can exceed the ceiling under invariant 3. Zero when
  // nothing was measured at all (no ceiling configured, or no human boundary to open on).
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
  // NOTE: No human message anywhere means there is no safe place to open a window (invariant 1),
  // so leave the history alone rather than guess a boundary.
  if (lastHuman < 0) return untouched();

  // NOTE: Longest suffix that fits, counting each message exactly once. Stops at the first message
  // that does not fit, because a window has to be contiguous.
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

  // NOTE: Invariant 4 — only look for a boundary when the budget actually forced a cut. A history
  // that fits entirely goes through as-is, even when it happens to begin on a non-human message.
  if (start > 0) {
    while (start < history.length && history[start]?.getType() !== "human") {
      start++;
    }
    // NOTE: Invariant 3 — the turn being answered always travels, budget or no budget.
    if (start > lastHuman) start = lastHuman;
  }

  let tokens = 0;
  for (let i = start; i < history.length; i++) tokens += tokensAt(i);
  return { kept: history.slice(start), dropped: start, tokens };
}
