import type { BaseMessage } from "@langchain/core/messages";
import logger from "@/api/lib/logger";
import { contentToText } from "./message-text";

// Token counting for the per-agent history ceiling (agent.settings.limits.maxHistoryTokens).
//
// WHY NOT LangChain's own `tokenCounter: model`. Handing `trimMessages` the model makes
// @langchain/core resolve an encoding through `encodingForModel`, which FETCHES the BPE ranks from
// https://tiktoken.pages.dev at call time. Three problems, in ascending order of how bad they are:
// it puts a third-party network round trip on the hot path of every turn; the failure is cached as
// a rejection and re-attempted (with retries) on the next turn; and on an install with no outbound
// internet it throws, the caller falls back to the whole history, and the ceiling the operator
// switched on does nothing at all, in silence. That path also counts `msg.content` ONLY, so an
// AIMessage that carries tool_calls (content: "") scores zero — the heaviest messages of a
// tool-driven thread are exactly the ones it cannot see.
//
// So the ranks are read from disk, and LAZILY: an install that never enables a ceiling never pays
// for them. Measured on an M-series Mac: +96MB RSS and ~96ms to build cl100k_base once, then ~22ms
// to tokenize 243k chars (76.8k tokens).
//
// ONE encoding for every provider. cl100k_base is exact for the OpenAI family and an approximation
// for Gemini/Anthropic, which is the right trade for a CEILING: this number decides how much
// history to keep and is never shown as a bill. The cheap alternative is worse in the direction
// that matters — measured against this tokenizer, bytes/4 comes in at -40% on a JSON tool result
// and -53% on a URL carrying a uuid, and undercounting is what lets a thread through the bound.

export type TokenCounter = (message: BaseMessage) => number;

// The role plus the delimiters a provider wraps around every message. 4 is OpenAI's own documented
// figure; against a ceiling in the thousands its exact value is noise, but leaving it out would let
// a thread of many tiny messages slip past the budget by the count of its messages.
const MESSAGE_OVERHEAD_TOKENS = 4;

let cached: Promise<TokenCounter | null> | null = null;

async function build(): Promise<TokenCounter | null> {
  try {
    const [{ Tiktoken }, ranks] = await Promise.all([
      import("js-tiktoken/lite"),
      import("js-tiktoken/ranks/cl100k_base"),
    ]);
    const encoding = new Tiktoken(ranks.default);
    return (message) => {
      let text = contentToText(message.content);
      // NOTE: Every message this codebase puts in the history is built from a string, so a content
      // array only ever shows up as provider-returned text blocks — which is why there is no
      // accounting here for image or other non-text blocks.
      const calls = (message as { tool_calls?: unknown[] }).tool_calls;
      if (Array.isArray(calls) && calls.length > 0)
        text += JSON.stringify(calls);
      return encoding.encode(text).length + MESSAGE_OVERHEAD_TOKENS;
    };
  } catch (err) {
    // A broken install, not a transient fault: the ranks ship with the package. Cache the failure
    // so the next turn does not pay for the same import, and let the caller decide what to do with
    // a ceiling it cannot apply.
    logger.warn({ err }, "history ceiling: token encoding unavailable");
    return null;
  }
}

// Resolves the counter once per process. Returns null when the encoding could not be loaded.
export function loadTokenCounter(): Promise<TokenCounter | null> {
  cached ??= build();
  return cached;
}
