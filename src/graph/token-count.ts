import type { BaseMessage } from "@langchain/core/messages";
import { estimateTokenCount } from "tokenx";
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

export const countMessageTokens: TokenCounter = (message) => {
  let text = contentToText(message.content);
  // An AIMessage that only calls tools carries an EMPTY content and its whole payload in
  // tool_calls. Counting content alone (which is what LangChain's own counter does) scores the
  // heaviest messages of a tool-driven thread at zero.
  const calls = (message as { tool_calls?: unknown[] }).tool_calls;
  if (Array.isArray(calls) && calls.length > 0) text += JSON.stringify(calls);
  return estimateTokenCount(text) + MESSAGE_OVERHEAD_TOKENS;
};
