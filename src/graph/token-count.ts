import type { BaseMessage } from "@langchain/core/messages";
import { estimateTokenCount } from "tokenx";
import { contentToText } from "./message-text";

// Token estimation for the per-agent history ceiling (agent.settings.limits.maxHistoryTokens).
//
// THIS IS AN ESTIMATE, ON PURPOSE, because precision here would be false precision. The ceiling
// bounds the HISTORY only: the system prompt and the tool definitions sit above it and are never
// counted, and on the install that motivated this feature those were 15,806 tokens. Being exact
// about the history while ignoring a floor that size buys nothing, and exactness is expensive — a
// real BPE table costs ~176MB of resident memory (measured inside the deploy image on both
// architectures), it is OpenAI-only (js-tiktoken ships no table for Anthropic or Google, which
// expose token-counting ENDPOINTS instead, i.e. a network round trip per turn), it forces a choice
// of encoding that is wrong for whichever models you did not pick, and its `encode` THROWS on a
// control marker such as <|endoftext|> — text a customer can simply type into WhatsApp.
//
// `tokenx` is 84KB, has no dependencies, adds ~3MB of RSS and is calibrated against o200k_base, the
// encoding every current OpenAI model uses. Measured against that tokenizer on a realistic clinic
// thread (12 turns of customer prose, agent replies, tool calls and tool results carrying ids and
// ISO timestamps):
//
//   whole thread  -17.3%      prose only  -7.1%      JSON payloads  -18.8%
//   worst single sample: a URL carrying a uuid, -42%
//
// It runs LOW, so a ceiling of N lets through roughly N * 1.2 of what OpenAI actually bills on a
// tool-heavy thread. That is disclosed in the operator hint rather than papered over with a
// correction factor: a factor would be right for one content mix and wrong for the next, and it
// would be a pure guess outside the OpenAI family, where any local estimate is an approximation
// regardless. What matters is that the thread ends up BOUNDED — the measured problem was 79.8k
// tokens and climbing, not the difference between 12k and 14k.

export type TokenCounter = (message: BaseMessage) => number;

// The role plus the delimiters a provider wraps around every message. 4 is OpenAI's own documented
// figure; against a ceiling in the thousands its exact value is noise, but leaving it out would let
// a thread of many tiny messages slip past the budget by the count of its messages.
const MESSAGE_OVERHEAD_TOKENS = 4;

export const countMessageTokens: TokenCounter = (message) => {
  let text = contentToText(message.content);
  // NOTE: An AIMessage that only calls tools carries an EMPTY content and its whole payload in
  // tool_calls. Counting content alone (which is what LangChain's own counter does) scores the
  // heaviest messages of a tool-driven thread at zero.
  const calls = (message as { tool_calls?: unknown[] }).tool_calls;
  if (Array.isArray(calls) && calls.length > 0) text += JSON.stringify(calls);
  return estimateTokenCount(text) + MESSAGE_OVERHEAD_TOKENS;
};
