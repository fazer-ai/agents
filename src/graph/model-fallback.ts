import {
  isTransientProviderStatus,
  providerFailure,
  statusOf,
} from "@/lib/provider-failure";
import { isEmptyCompletionFault } from "./empty-completion";

// WHEN A FAILED TURN IS WORTH ASKING A DIFFERENT PROVIDER, AND HOW LONG THE FIRST ONE MAY HOLD IT.
//
// The two halves are one decision, hence one file. A second provider behind the first is worth
// nothing if it only gets its turn after the first has spent the customer's patience, and the
// measurement is what says it would: driven through `createChatModel` against a local
// openai-compatible endpoint (issue #143), LangChain's default AsyncCaller turns a single 503 into
// SEVEN requests over 77s, a 502 into 99s, a 500 into 86s, and a `Retry-After: 1` 429 into 87s. The
// failures that arrive fast are exactly the ones nothing may fall over on — 400/401/404 in about a
// millisecond. So the fallback is not an addition to that retry, it REPLACES it: the primary gets
// one honest attempt, and what used to be six more retries against a provider that just said it was
// overloaded becomes one attempt against a provider that did not.
//
// Nothing here fires for an install that configured no fallback. The bounds below are applied only
// where a second model was resolved, so an install that names none keeps LangChain's six retries and
// its unbounded wait, byte for byte.

// One attempt, not six. The number is not a tuning knob: with anything above zero the fallback
// inherits the exponential backoff measured above, and the customer is already gone when it runs.
// The resilience that budget used to buy has not been deleted, it has been moved to a provider that
// is not the one that just failed.
export const PRIMARY_MAX_RETRIES = 0;

// The primary's own ceiling, because a hang is the one failure with no status to read. Today no
// model call is bounded at all (`createChatModel` sets no `timeout` on any of the four SDK
// families), so a provider that accepts the connection and never answers holds the turn forever and
// the fallback would never get it — measured: 600s and still waiting, versus 3.008ms with a 3s
// ceiling, arriving as our own "timeout".
//
// Generous rather than tight: this bounds ONE attempt of a turn that may legitimately be slow (a
// reasoning model with tools), and the cost of being too tight is abandoning an answer that was
// coming. The fallback gets the same ceiling, so the worst case is two honest attempts rather than
// one attempt and a queue.
export const PRIMARY_TIMEOUT_MS = 45_000;

export function isFallbackWorthy(err: unknown): boolean {
  // A 200 carrying no completion is a PROVIDER fault, and the only one here that has already had a
  // second attempt: `runModelCall` retries it once on the same model, because it is intermittent
  // (measured 1 in 184 on one install, issue #63). Once that has failed too, another provider is
  // what is left.
  if (isEmptyCompletionFault(err)) return true;
  // "Was this a timeout?" has an owner, and this is not the place to write a second opinion: both
  // vendor SDKs raise a CLASS and leave `name` at "Error", which is what `provider-failure` learned
  // by measurement.
  if (providerFailure(err) === "timeout") return true;
  const status = statusOf(err);
  return status !== null && isTransientProviderStatus(status);
}
