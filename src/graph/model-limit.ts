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

// Short on purpose: a customer is waiting on the other end of this call.
const RETRY_DELAY_MS = 250;

// The one place that knows an error came from a provider, so the place to say what it may repeat.
// The request carried the whole conversation, so a provider message quoting its input would put the
// customer's words into the flow log, the operator alert, `Conversation.lastError` and the private
// note in their Chatwoot conversation, all of which read `.message`; substituting here covers all
// four. Everything goes to the closed vocabulary in `@/lib/provider-failure` (original kept as
// `cause`), except the empty completion, whose diagnosis is ours: nothing in the response says it.
function describeProviderFault(err: unknown): unknown {
  if (isEmptyCompletionFault(err)) {
    // NOTE: no log of its own: this fault is only reached after the retry, which already logged the
    // failing expression with the error object.
    return new Error(EMPTY_COMPLETION_MESSAGE, { cause: err });
  }
  return asProviderFailure(err);
}

export interface ModelLabels {
  provider: string;
  model: string;
}

export interface ModelFallback<T> {
  // The same call, against the other provider. A thunk rather than a model, because only the caller
  // knows what "the same call" means: which messages, which bound tools, and which metadata names
  // the model for the usage row. Handed the deadline's signal, like the primary's thunk.
  run: (signal: AbortSignal) => Promise<T>;
  // The fallback's own deadline: it is another provider, with its own ceiling.
  deadlineMs: number;
  // What it runs on, for the lines this module writes about it.
  labels: ModelLabels;
  // Fired when the fallback takes the turn, so the runtime can leave a warn on the trail. `reason`
  // is already the redacted word: the request carried the whole conversation, so the provider's own
  // sentence may be the customer's coming back.
  onFallback?: (info: { reason: string }) => void;
  // Fired when the fallback ALSO failed, which is the turn's real ending. Its own line, because the
  // `generate` stage wrapping this call is labelled with the PRIMARY by construction: without it an
  // operator reads "the fallback took the turn (ok)" followed by an error attributed to the model
  // that never made the second call, which reads as the primary failing twice.
  onFallbackFailed?: (info: { reason: string }) => void;
}

// Which model an event is about, carried on every event and NOT optional: only this module knows
// which of the two models it just called, and a label defaulted at each call site would publish a
// fallback's retry under the primary's name.
export interface ModelRetryInfo extends ModelLabels {
  attempt: number;
  error: unknown;
}

// A wait for a permit that outlasted the operator's threshold. `waitedMs` is measured when it is
// reported, which is while the call is STILL waiting: at least the threshold, never the whole wait.
export interface PermitWaitInfo {
  waitedMs: number;
  thresholdMs: number;
}

// Every call has a deadline. `runModelCall` applies it itself, through
// `callWithDeadline`, so no call through this module can wait on a provider for longer, whatever its
// adapter does with the signal. `deadlineMs` is the caller's own value; left out, a call gets the
// agent's `modelCallTimeoutMs`, and `tests/lib/model-call-deadline-sweep.test.ts` keeps every caller
// under `src/` from leaving it out, so the default is a floor for tests and never a site's policy.
export type ModelCallOptions<T> = {
  deadlineMs?: number;
  // The caller's own end, which is a job's deadline. It ends the wait for a
  // permit: a call whose signal aborts leaves the queue with the signal's reason and takes no permit,
  // so a run past its deadline stops holding its row in the running set until a permit frees. It
  // does not reach `fn`, which is handed the call's own deadline; a caller that wants the model call
  // itself ended joins the two there, as the agent turn does.
  signal?: AbortSignal;
} & (
  | ReportingModelCallOptions<T>
  | {
      primary?: undefined;
      onRetry?: undefined;
      fallback?: undefined;
      onPermitWait?: undefined;
    }
);

interface ReportingModelCallOptions<T> {
  // What `fn` runs on. Required whenever anything is reported at all, which is what keeps a
  // reporting caller from being written without the labels its lines need.
  primary: ModelLabels;
  // Fired when a call is retried, so the runtime can leave a warn on the turn's trail. Best-effort.
  onRetry?: (info: ModelRetryInfo) => void;
  // Absent for every caller that has nothing behind its provider, which is every caller except the
  // agent turn. None of the bounds in `model-fallback` apply to a model built without one; the agent
  // turn bounds that call with `callWithDeadline` instead.
  fallback?: ModelFallback<T>;
  // Fired ONCE when this call has waited for a permit past `config.agent.capacityWaitAlertMs`, and
  // while it still waits, so the operator hears about a saturated instance during the wait rather
  // than after it. Reported at the threshold and not at the grant for a second reason: every call
  // queued behind the same saturation crosses it together, which is what lets the alert bus
  // coalesce them into one alert with a count. Best-effort: a throw here is swallowed.
  onPermitWait?: (info: PermitWaitInfo) => void;
}

// A deadline on ONE model call, retries included, that holds whether or not the adapter honours the
// abort signal. The signal goes to the call, so an adapter that listens (the OpenAI-shaped clients,
// Anthropic) cancels its own request; the race holds on one that does not (the Google adapter
// ignores `signal` and `timeout`), leaving that request to finish on its own. `signal.reason` is the
// DOMException `TimeoutError`, which `provider-failure` reads as "timeout". Built INSIDE the thunk
// `runModelCall` runs: a signal created outside spends its budget waiting on the semaphore.
export function callWithDeadline<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    run(signal)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function runModelCall<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts?: ModelCallOptions<T>,
): Promise<T> {
  const fallback = opts?.fallback;
  const deadlineMs = opts?.deadlineMs ?? config.agent.modelCallTimeoutMs;
  // One attempt at one model, with the single recovery LangChain cannot make, applied to BOTH
  // models: the fallback answers in the primary's place, and an intermittent empty completion would
  // cost it the turn the same way. The deadline is armed per ATTEMPT and inside the permit: a retry
  // gets a fresh one, and time queueing on the semaphore is not spent from it.
  const attemptOn = async (
    call: (signal: AbortSignal) => Promise<T>,
    labels: ModelLabels | undefined,
    ms: number,
  ): Promise<T> => {
    const run = () => callWithDeadline(ms, call);
    try {
      return await run();
    } catch (err) {
      if (!isEmptyCompletionFault(err)) throw err;
      if (labels) opts?.onRetry?.({ attempt: 1, error: err, ...labels });
      logger.warn(
        { err },
        "model call returned no completion; retrying once before giving up on this model",
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return await run();
    }
  };

  // Armed before the queue and cleared as the permit is granted. A permit that is free now is
  // granted in the next microtask, long before any timer can fire, so an uncontended call reports
  // nothing.
  const onPermitWait = opts?.onPermitWait;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  if (onPermitWait) {
    const thresholdMs = config.agent.capacityWaitAlertMs;
    const queuedAt = performance.now();
    waitTimer = setTimeout(() => {
      try {
        onPermitWait({
          waitedMs: Math.round(performance.now() - queuedAt),
          thresholdMs,
        });
      } catch (err) {
        logger.warn({ err }, "reporting a model permit wait failed");
      }
    }, thresholdMs);
    waitTimer.unref?.();
  }

  // NOTE: cleared on every way out of the wait, a call that left the queue included: a wait that
  // ended is not one to report.
  try {
    return await sem().run(async () => {
      clearTimeout(waitTimer);
      // Reached with the error the PROVIDER raised, which is why the decision lives here and
      // not at the call site: after `describeProviderFault`, "timeout" is a message on an Error named
      // "Error", so a predicate asking the SDK's question would answer no to the case it exists for.
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
          return await attemptOn(
            fallback.run,
            fallback.labels,
            fallback.deadlineMs,
          );
        } catch (fallbackErr) {
          // The fallback is the last thing there is, so what it failed with is what the turn
          // reports. Redacted the same way: a second vendor's prose is no safer than the first's.
          const out = describeProviderFault(fallbackErr);
          fallback.onFallbackFailed?.({
            reason: out instanceof Error ? out.message : "provider error",
          });
          throw out;
        }
      };
      try {
        return await attemptOn(fn, opts?.primary, deadlineMs);
      } catch (err) {
        return failed(err);
      }
    }, opts?.signal);
  } finally {
    clearTimeout(waitTimer);
  }
}
