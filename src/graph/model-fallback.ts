import {
  isTransientProviderStatus,
  providerFailure,
  statusOf,
} from "@/lib/provider-failure";
import { isEmptyCompletionFault } from "./empty-completion";

// When a failed turn is worth asking a different provider, and how long the first may hold it: one
// decision, one file. LangChain's default AsyncCaller turns one 503 into seven requests over more
// than a minute (similarly for 502, 500 and a 429 with Retry-After), while 400/401/404 fail in a
// millisecond and must not fall over. So the fallback REPLACES that retry: the primary gets one
// honest attempt, and the rest goes to a provider that did not just say it was overloaded. Applied
// only where a second model was resolved; an install with none keeps LangChain's retries, and the
// whole call runs under `config.agent.modelCallTimeoutMs`.

// One attempt, not six, and not a tuning knob: above zero the fallback inherits the exponential
// backoff, and the customer is gone by the time it runs. The resilience moves to a provider that is
// not the one that just failed.
export const PRIMARY_MAX_RETRIES = 0;

// The primary's own ceiling, because a hang is the one failure with no status to read: a provider
// that accepts the connection and never answers would hold the turn forever and the fallback would
// never get it. Generous rather than tight: it bounds ONE attempt of a turn that may legitimately be
// slow (a reasoning model with tools), where too tight abandons an answer that was coming. The
// fallback gets the same ceiling, so the worst case is two honest attempts.
export const PRIMARY_TIMEOUT_MS = 45_000;

export function isFallbackWorthy(err: unknown): boolean {
  // NOTE: a 200 carrying no completion is a PROVIDER fault, and the only one here already retried:
  // `runModelCall` retries it once on the same model, since it is intermittent. Once that fails
  // too, another provider is what is left.
  if (isEmptyCompletionFault(err)) return true;
  // NOTE: "was this a timeout?" has an owner (`provider-failure`): both vendor SDKs raise a CLASS
  // and leave `name` at "Error", so a second opinion written here would get it wrong.
  if (providerFailure(err) === "timeout") return true;
  const status = statusOf(err);
  return status !== null && isTransientProviderStatus(status);
}
