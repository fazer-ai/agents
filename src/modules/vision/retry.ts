import {
  isTransientProviderStatus,
  providerFailure,
  statusOf,
} from "@/lib/provider-failure";
import type { VisionKind } from "./providers";

// WHEN A FAILED EXTRACTION IS WORTH ASKING FOR AGAIN, AND HOW LONG EACH ASK MAY TAKE.
//
// A vision failure loses the attachment PERMANENTLY: the "couldn't extract" marker is what enters
// the conversation history, and no later turn can recover the content. Measured on one tenant over
// a week (issue #319): 12 failures in 45 extractions — nine `503` and three 60s timeouts — with the
// same credential and model succeeding on the very next turn 16s later. Upstream overload, and the
// only thing missing was asking twice.
//
// The two halves are one decision, hence one file: retries on top of a 60s-per-call budget would
// spend three minutes of a turn, and a shorter budget without retries is a stricter way to fail.

// The ENDPOINT's momentary state rather than our request. The set itself is a fact about the
// transport and moved to `provider-failure`, which is where the model fallback reads it too; what
// stays here is what THIS policy does with the rest. A 4xx about what we SENT (400, 401, 403, 404,
// 413, 422) answers the same way every time, so asking the SAME endpoint again buys nothing.

// A connection that never opened is deliberately absent: it reads transient and is just as often a
// base URL that will never resolve, which the operator needs to see fail on the first attempt.
export function isTransientVisionFailure(err: unknown): boolean {
  // NOTE: "Was this a timeout?" already has an owner, and the second copy is the one that gets it
  // wrong: `provider-failure` learned by measurement that both vendor SDKs raise a CLASS instead of
  // setting `name`.
  if (providerFailure(err) === "timeout") return true;
  const status = statusOf(err);
  return status !== null && isTransientProviderStatus(status);
}

// The ceiling for the WHOLE extraction, attempts and waits included — the value the single call
// already carried. Kept, so no turn gets slower than it could before.
export const VISION_TOTAL_BUDGET_MS = 60_000;

// Waits before each retry; its length is what sets the number of attempts. Same shape as the
// attachment-download backoff in the Chatwoot client, and short for the same reason: a customer is
// waiting on this turn.
//
// TWO attempts, not more, and that is a consequence of the ceiling below rather than of the odds. A
// third attempt would have to be carved out of the same 60s, and what it costs is the length of the
// LAST one — the only attempt that can still answer a call that is legitimately slow.
export const VISION_RETRY_DELAYS_MS = [500];

// Derived, never written twice: the loop that spends the attempts and the policy that plans them
// must not be able to disagree about when to stop. Mutating the policy alone turned that loop into
// a spin — the battery hung instead of failing, because a stubbed clock never spends the budget
// that was its only other way out.
export const VISION_MAX_ATTEMPTS = VISION_RETRY_DELAYS_MS.length + 1;

// What a non-final attempt may take when the work IS measured: 2.0-4.4s live through gpt-4o for an
// image, a 3000x3000 one included, and the issue reports 4s in production. 20s is ~5x the slowest,
// so an image that has not answered by then is not a slow image, it is a bad call — and cutting it
// there is what funds a second attempt inside the same total.
export const VISION_IMAGE_CEILING_MS = 20_000;

// The ceiling only applies where a measurement backs it; everywhere else an attempt is bounded by
// the total alone, exactly as the single call was. Two cases are unmeasured, and cutting either one
// at 20s would turn a slow SUCCESS into a permanent marker:
//
//   a document — up to 25MB and ~100 pages of provider work, with no live measurement here;
//   a custom endpoint — `baseURL` set means the operator pointed us somewhere the numbers above say
//   nothing about (a self-hosted Qwen-VL on modest hardware, a proxy, a regional gateway). The
//   provider name does not answer this: `openai` with a `baseURL` is not the endpoint that was
//   measured, and `openai-compatible` has no default one at all.
//
// Both still gain a retry, just only when the failure leaves room — which an overload usually does,
// since it answers in seconds.
export function attemptCeilingMs(args: {
  kind: VisionKind;
  customEndpoint: boolean;
}): number {
  return args.kind === "image" && !args.customEndpoint
    ? VISION_IMAGE_CEILING_MS
    : VISION_TOTAL_BUDGET_MS;
}

// Applied upward, so a delay lands in [base, base * 1.5). A 503 is upstream overload, and every
// caller retrying on the same schedule is what keeps it overloaded.
const JITTER = 0.5;

// Under this an attempt buys a timeout instead of an answer: the fastest measured call is 2.0s.
const MIN_ATTEMPT_MS = 2_000;

// How long to wait before attempt `attempt` (1-based; 0 for the first), or null when the attempts
// are used up.
export function retryDelayMs(
  attempt: number,
  rand: () => number = Math.random,
): number | null {
  if (attempt > VISION_MAX_ATTEMPTS) return null;
  const base = attempt <= 1 ? 0 : (VISION_RETRY_DELAYS_MS[attempt - 2] ?? 0);
  return Math.round(base * (1 + JITTER * rand()));
}

// This attempt's own deadline, or null when what is left of the total cannot fund a useful call.
// `elapsedMs` runs from the first attempt and is read AFTER the wait, not before it: the wait is
// what the process may oversleep, and a budget computed from the nominal delay would hand a stalled
// process more time than the total still has.
//
// The LAST attempt is not capped by its kind's ceiling. The ceiling exists to leave room for a next
// attempt, and after the last one there is none — so capping it there would buy nothing and would
// cost the one case the ceiling is bad at: a call that is legitimately slow (a loaded vendor, a
// self-hosted `openai-compatible` endpoint on modest hardware) used to have the whole 60s and would
// otherwise be cut at 20s on every attempt, turning a slow success into a permanent marker.
export function attemptBudgetMs(args: {
  kind: VisionKind;
  attempt: number;
  elapsedMs: number;
  customEndpoint: boolean;
}): number | null {
  const left = VISION_TOTAL_BUDGET_MS - args.elapsedMs;
  const ceiling =
    args.attempt >= VISION_MAX_ATTEMPTS
      ? left
      : attemptCeilingMs({
          kind: args.kind,
          customEndpoint: args.customEndpoint,
        });
  const budget = Math.min(ceiling, left);
  return budget < MIN_ATTEMPT_MS ? null : budget;
}
