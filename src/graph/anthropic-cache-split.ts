import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseMessage } from "@langchain/core/messages";

// Anthropic bills a cache write by its TTL (1.25x the input rate for 5 minutes, 2x for 1 hour) and
// says how many tokens went to each in the raw `usage.cache_creation`. ChatAnthropic's normalized
// `usage_metadata` folds both into `input_token_details.cache_creation`, and that normalized field is
// what every reader downstream sees: the usage ledger (`extractTokenUsage`) and the Langfuse handler,
// which turns each `input_token_details` key into an `input_<key>` usage detail. So the split is
// written there, on the message, before any of them reads it: `cache_creation` keeps the 5-minute
// writes and `cache_creation_1h` carries the 1-hour ones, and the two still add up to the total.
export function splitOneHourWrites(message: BaseMessage | undefined): void {
  // biome-ignore lint/suspicious/noExplicitAny: the usage fields are provider-shaped metadata.
  const m = message as any;
  const det = m?.usage_metadata?.input_token_details;
  if (!det || det.cache_creation_1h !== undefined) return;
  const raw = m?.response_metadata?.usage?.cache_creation;
  const oneHour = Number(raw?.ephemeral_1h_input_tokens ?? 0);
  if (!Number.isFinite(oneHour) || oneHour <= 0) return;
  const total = Number(det.cache_creation ?? 0);
  const oneHourCapped = Math.min(oneHour, total);
  det.cache_creation = total - oneHourCapped;
  det.cache_creation_1h = oneHourCapped;
}

// ChatAnthropic with the split applied to the message a call returns. Only to the FINAL message: the
// stream's chunks are left alone, because merging chunks keeps only the token-detail keys LangChain
// knows and would drop `cache_creation_1h` with the writes in it, while the raw usage the split reads
// survives the merge. A caller that streams on its own gets the unsplit message, and
// `extractTokenUsage` reads the 1-hour share from that raw usage.
export class ChatAnthropicCacheSplit extends ChatAnthropic {
  override async _generate(
    ...args: Parameters<ChatAnthropic["_generate"]>
  ): ReturnType<ChatAnthropic["_generate"]> {
    const result = await super._generate(...args);
    for (const g of result.generations) splitOneHourWrites(g.message);
    return result;
  }
}
