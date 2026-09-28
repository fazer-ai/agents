import {
  isTransientProviderStatus,
  providerFailure,
  statusOf,
} from "@/lib/provider-failure";
import type { VisionKind } from "./providers";

// WHEN A FAILED EXTRACTION IS WORTH ASKING FOR AGAIN, AND HOW LONG EACH ASK MAY TAKE.
//
// A vision failure loses the attachment PERMANENTLY: the "couldn't extract" marker enters the
// history and no later turn recovers the content, while most failures are transient overload.
// The two halves are one decision, hence one file: retries on top of a 60s-per-call budget would
// spend minutes of a turn, and a shorter budget without retries is a stricter way to fail.

// The ENDPOINT's momentary state rather than our request. The set itself is a fact about the
// transport and lives in `provider-failure`, which the model fallback reads too; what
// stays here is what THIS policy does with the rest. A 4xx about what we SENT (400, 401, 403, 404,
// 413, 422) answers the same way every time, so asking the SAME endpoint again buys nothing.

// A connection that never opened is deliberately absent: it reads transient and is just as often a
// base URL that will never resolve, which the operator needs to see fail on the first attempt.
export function isTransientVisionFailure(err: unknown): boolean {
  // NOTE: "Was this a timeout?" already has an owner, and the second copy is the one that gets it
  // wrong: both vendor SDKs raise a timeout CLASS instead of setting `name`, and `provider-failure`
  // knows it.
  if (providerFailure(err) === "timeout") return true;
  const status = statusOf(err);
  return status !== null && isTransientProviderStatus(status);
}

// The ceiling for the WHOLE extraction, attempts and waits included.
export const VISION_TOTAL_BUDGET_MS = 60_000;

// Waits before each retry; its length is what sets the number of attempts. Same shape as the
// attachment-download backoff in the Chatwoot client, and short for the same reason: a customer is
// waiting on this turn.
//
// TWO attempts, not more: a third would be carved out of the same 60s, at the cost of the LAST
// attempt, the only one that can still answer a call that is legitimately slow.
export const VISION_RETRY_DELAYS_MS = [500];

// Derived, never written twice: the loop that spends the attempts and the policy that plans them
// must not be able to disagree about when to stop: under a stubbed clock the budget never runs out,
// and a disagreement spins the loop forever.
export const VISION_MAX_ATTEMPTS = VISION_RETRY_DELAYS_MS.length + 1;

// What a non-final image attempt may take: several times a normal image call, so an image that has
// not answered by then is a bad call, and cutting it there funds a second attempt inside the total.
export const VISION_IMAGE_CEILING_MS = 20_000;

// The image ceiling applies only to a hosted vendor endpoint. A document (up to ~100 pages) and a
// custom `baseURL` (self-hosted, proxy) have no known timing, so cutting them at 20s would turn a slow
// SUCCESS into a permanent marker; they are bounded by the total alone, and still retry when a fast
// failure leaves room.
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

// Under this an attempt buys a timeout instead of an answer.
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
// The LAST attempt is not capped by its kind's ceiling: the ceiling only leaves room for a next
// attempt, and capping the last would cut a legitimately slow call into a permanent marker.
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
