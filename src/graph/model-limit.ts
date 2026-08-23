import logger from "@/api/lib/logger";
import config from "@/config";
import { asProviderFailure } from "@/lib/provider-failure";
import { Semaphore } from "@/lib/semaphore";

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

// NOTE: `TypeError` is the predicate, and it is narrow by design. LangChain's AsyncCaller already
// retries everything the PROVIDER answered (6 attempts with backoff, aborting on 4xx), and the
// OpenAI SDK's own retry is disabled in favour of it. What no retry covers is a 200 whose body
// carries no completion: the provider returns `choices: []`, `_generate` returns
// `{ generations: [] }`, the call RESOLVES, and only afterwards does BaseChatModel.invoke raise a
// TypeError reading `generations[0][0].message`. That is issue #63 — an intermittent fault ended
// the turn and the customer got no reply at all.
//
// Everything the provider actually answered arrives as a plain Error (an APIError carries `status`,
// a timeout is named AbortError/TimeoutError, an oversized prompt is ContextOverflowError), so a
// "retry unless 4xx" predicate would have to enumerate those three exclusions, double the latency
// of failures that are already decided, and still miss the next such class.
//
// The failing expression is the only signal there is: the provider answered 200, so there is no
// status, no code and no typed error to match on. Bun (JavaScriptCore) puts that expression in the
// message — `undefined is not an object (evaluating '…generations[0][0].message')` — and Bun is what
// the deploy runs. Matching it, rather than any TypeError, matters because `runModelCall` wraps
// `invoke`, and LangChain runs its callback handlers INSIDE that: a TypeError from a tracing
// callback fires after the provider already answered and was already billed, so retrying it would
// pay for the same completion twice, every turn, until the callback is fixed.
//
// If a future runtime words the message differently the retry stops firing, which is the behaviour
// that shipped before this change — a silent no-op, never a wrong retry.
function isEmptyCompletionFault(err: unknown): boolean {
  return err instanceof TypeError && err.message.includes("generations");
}

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
    return new Error(
      "the model provider returned no completion (empty generations)",
      { cause: err },
    );
  }
  return asProviderFailure(err);
}

export async function runModelCall<T>(
  fn: () => Promise<T>,
  // Fired when a call is retried, so the runtime can leave a warn on the turn's trail. Best-effort.
  onRetry?: (info: { attempt: number; error: unknown }) => void,
): Promise<T> {
  return sem().run(async () => {
    try {
      return await fn();
    } catch (err) {
      if (!isEmptyCompletionFault(err)) throw describeProviderFault(err);
      onRetry?.({ attempt: 1, error: err });
      logger.warn(
        { err },
        "model call returned no completion; retrying once before failing the turn",
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      try {
        return await fn();
      } catch (retryErr) {
        throw describeProviderFault(retryErr);
      }
    }
  });
}
