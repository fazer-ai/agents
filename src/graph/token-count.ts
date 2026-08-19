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
// for them. Measured inside the deploy base image (oven/bun:1-alpine, arm64): RSS 34MB -> 209MB,
// paid once, then ~22ms to tokenize 243k chars (76.8k tokens).
//
// ONE encoding for every provider: o200k_base, which is what every current OpenAI model uses
// (gpt-4o, gpt-4.1, the gpt-5 family, the o-series). js-tiktoken ships OpenAI tokenizers only, and
// no other provider publishes a local table — Anthropic and Google expose token-counting ENDPOINTS
// instead, and a network round trip per turn is the very thing this module exists to avoid. So off
// the OpenAI family the number is an approximation, which is the right trade for a CEILING: it
// decides how much history to keep and is never shown as a bill.
//
// The legacy cl100k_base table costs half the memory and was measured against o200k on this
// product's own content: +15.3% aggregate and +11% to +30% on Portuguese prose, because the older
// vocabulary splits accented words harder. Overcounting is the safe direction, but it is 15% of a
// configured budget quietly going unused on the model family this product defaults to, which does
// not pay for the 83MB it saves.
//
// The cheap alternative is worse in the direction that matters — measured against this tokenizer,
// bytes/4 comes in at -40% on a JSON tool result and -53% on a URL carrying a uuid, and
// undercounting is what lets a thread through the bound.

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
      import("js-tiktoken/ranks/o200k_base"),
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
      // NOTE: Both special-token lists are empty ON PURPOSE. By default js-tiktoken THROWS when the
      // text contains a marker like <|endoftext|>, and this text is whatever a customer typed into
      // WhatsApp — so the default would let anyone switch off an agent's ceiling by sending one
      // literal string (the throw is caught upstream, which falls back to the full history). Empty
      // lists count the marker as the ordinary characters it is.
      return encoding.encode(text, [], []).length + MESSAGE_OVERHEAD_TOKENS;
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
