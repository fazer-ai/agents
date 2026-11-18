import type { BaseMessage } from "@langchain/core/messages";
import { estimateTokens } from "@/lib/token-estimate";
import { contentToText } from "./message-text";

// Token estimation for the per-agent history ceiling (agent.settings.limits.maxHistoryTokens).
// AN ESTIMATE ON PURPOSE: the ceiling bounds the HISTORY only (system prompt and tool definitions are
// never counted), so exactness buys nothing, while a real BPE table costs ~176MB resident, is
// OpenAI-only, and THROWS on control markers a customer can type. `tokenx` runs LOW against
// o200k_base, so a ceiling of N admits roughly N * 1.2; the operator hint discloses that instead of a
// correction factor, which would fit one content mix only. Figures in docs/graph.md, History ceiling.

export type TokenCounter = (message: BaseMessage) => number;

// The role plus the delimiters a provider wraps around every message. 4 is OpenAI's own documented
// figure; against a ceiling in the thousands its exact value is noise, but leaving it out would let
// a thread of many tiny messages slip past the budget by the count of its messages.
const MESSAGE_OVERHEAD_TOKENS = 4;

// The text a message is counted by: its content plus, for an AIMessage that only calls tools, the
// calls themselves. That message carries an EMPTY content and its whole payload in tool_calls, so
// counting content alone (which is what LangChain's own counter does) scores the heaviest messages of a
// tool-driven thread at zero.
function countedText(message: BaseMessage): string {
  const text = contentToText(message.content);
  const calls = (message as { tool_calls?: unknown[] }).tool_calls;
  return Array.isArray(calls) && calls.length > 0
    ? text + JSON.stringify(calls)
    : text;
}

const MAX_MEMOIZED_COUNTS = 20_000;

// A counter that estimates each distinct text once. The history ceiling counts the whole thread on
// every model call, and the thread comes back from the checkpoint as new objects every turn, so the
// key is a hash of the counted text and not the message: a message estimated on an earlier call or
// turn costs a hash, and an edited message is a new text and is estimated again. The length rides
// along as a second check against a hash collision. Insertion order makes the Map an LRU.
export function memoizedTokenCounter(
  estimate: (text: string) => number,
): TokenCounter {
  const memo = new Map<number | bigint, { length: number; tokens: number }>();
  return (message) => {
    const text = countedText(message);
    const key = Bun.hash(text);
    const hit = memo.get(key);
    if (hit && hit.length === text.length) {
      memo.delete(key);
      memo.set(key, hit);
      return hit.tokens;
    }
    const tokens = estimate(text) + MESSAGE_OVERHEAD_TOKENS;
    memo.set(key, { length: text.length, tokens });
    if (memo.size > MAX_MEMOIZED_COUNTS) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    return tokens;
  };
}

// The estimate is called through its binding and not captured, so whatever `estimateTokens` is when
// the counter runs is what it asks.
export const countMessageTokens: TokenCounter = memoizedTokenCounter((text) =>
  estimateTokens(text),
);

// The size of a text the model receives, for the operator to read: characters, and tokens by the same
// estimate the history ceiling uses (so it runs low against a real tokenizer, like the ceiling does).
// Used on each tool result, in the playground trace and on the flow-log line.
export interface TextSize {
  chars: number;
  tokens: number;
}

export function measureText(text: string): TextSize {
  return { chars: text.length, tokens: estimateTokens(text) };
}
