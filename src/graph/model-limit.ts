import logger from "@/api/lib/logger";
import config from "@/config";
import { asProviderFailure } from "@/lib/provider-failure";
import { Semaphore } from "@/lib/semaphore";
import {
  EMPTY_COMPLETION_MESSAGE,
  isEmptyCompletionFault,
} from "./empty-completion";
import { isFallbackWorthy } from "./model-fallback";

// Policy point for every agent model call: the LLM round-trip in the LangGraph agent node
// (graph.ts), the guardrail classifier and the opt-in TTS-normalize call. It caps how many calls are
// in flight across ALL entrypoints (debounce/webhook/nudge/playground) so a burst does not hammer
// the provider, and it recovers the one provider fault LangChain cannot see. Singleton on
// globalThis so `bun --hot` reloads reuse one instance (same pattern as worker.ts / checkpointer.ts).

const KEY = Symbol.for("fazerai.model.semaphore");

function sem(): Semaphore {
  const g = globalThis as unknown as Record<symbol, Semaphore>;
  g[KEY] ??= new Semaphore(config.agent.modelConcurrency);
  return g[KEY];
}

// NOTE: short on purpose — a customer is waiting on the other end of this call.
const RETRY_DELAY_MS = 250;

// The one place that knows an error came from a provider, which is what makes it the place to say
// what it may repeat. This used to name the empty-completion fault and let everything else "travel
// untouched" — and untouched is the leak: the request carried the whole conversation, so a refusal
// quoting its input put the customer's words verbatim into the flow log, the alert body POSTed to
// the operator's channel, `Conversation.lastError` and the private note this failure writes into the
// customer's own Chatwoot conversation. All four read `.message` of whatever was thrown, so this
// single substitution closes all four and no call site downstream changes.
//
// The empty-completion case keeps its own sentence because that diagnosis is OURS: nothing in the
// response says it, we concluded it from the expression that failed. Everything else goes to the
// closed vocabulary in `@/lib/provider-failure`, with the original kept as `cause` for the process
// log.
function describeProviderFault(err: unknown): unknown {
  if (isEmptyCompletionFault(err)) {
    // No log of its own: this fault is only ever reached after the retry, which already logged the
    // failing expression with the error object. A second line here was written and removed once
    // mutation showed it killed nothing — the retry's log is what covers this path.
    return new Error(EMPTY_COMPLETION_MESSAGE, { cause: err });
  }
  return asProviderFailure(err);
}

export interface ModelFallback<T> {
  // The same call, against the other provider. A thunk rather than a model, because only the caller
  // knows what "the same call" means — which messages, which bound tools, and which metadata names
  // the model for the usage row.
  run: () => Promise<T>;
  // Fired when the fallback takes the turn, so the runtime can leave a warn on the trail. `reason`
  // is already the redacted word: the request carried the whole conversation, so the provider's own
  // sentence may be the customer's coming back.
  onFallback?: (info: { reason: string }) => void;
}

export async function runModelCall<T>(
  fn: () => Promise<T>,
  // Fired when a call is retried, so the runtime can leave a warn on the turn's trail. Best-effort.
  onRetry?: (info: { attempt: number; error: unknown }) => void,
  // Absent for every caller that has nothing behind its provider, which is every caller today except
  // the agent turn. Absent also means UNCHANGED: none of the bounds in `model-fallback` apply to a
  // model built without one.
  fallback?: ModelFallback<T>,
): Promise<T> {
  return sem().run(async () => {
    // Reached with the error the PROVIDER raised, which is the whole reason the decision lives here
    // rather than at the call site. One lane up, the error has already been through
    // `describeProviderFault` and is one of our own three words: `statusOf` still reads (the status
    // rides along), but "timeout" has become a message on an Error named "Error", so a predicate
    // asking the SDK's question would answer no to the exact case it exists for.
    const failed = async (err: unknown): Promise<T> => {
      const described = describeProviderFault(err);
      if (!fallback || !isFallbackWorthy(err)) throw described;
      const reason =
        described instanceof Error ? described.message : "provider error";
      logger.warn(
        { err },
        "primary model provider failed; handing the turn to the fallback",
      );
      fallback.onFallback?.({ reason });
      try {
        return await fallback.run();
      } catch (fallbackErr) {
        // The fallback is the last thing there is, so what it failed with is what the turn reports.
        // Redacted the same way: a second vendor's prose is no safer than the first's.
        throw describeProviderFault(fallbackErr);
      }
    };
    try {
      return await fn();
    } catch (err) {
      if (!isEmptyCompletionFault(err)) return failed(err);
      onRetry?.({ attempt: 1, error: err });
      logger.warn(
        { err },
        "model call returned no completion; retrying once before failing the turn",
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      try {
        return await fn();
      } catch (retryErr) {
        return failed(retryErr);
      }
    }
  });
}
