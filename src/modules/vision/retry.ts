import { providerFailure, statusOf } from "@/lib/provider-failure";
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

// The ENDPOINT's momentary state rather than our request: 408/504 the hop's own timeout, 429 the
// rate, 500/502/503 the overload, 529 Anthropic's spelling of it. A 4xx about what we SENT (400,
// 401, 403, 404, 413, 422) answers the same way every time.
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

// A connection that never opened is deliberately absent: it reads transient and is just as often a
// base URL that will never resolve, which the operator needs to see fail on the first attempt.
export function isTransientVisionFailure(err: unknown): boolean {
  // "Was this a timeout?" already has an owner, and the second copy is the one that gets it wrong:
  // `provider-failure` learned by measurement that both vendor SDKs raise a CLASS instead of
  // setting `name`.
  if (providerFailure(err) === "timeout") return true;
  const status = statusOf(err);
  return status !== null && TRANSIENT_STATUSES.has(status);
}

// The ceiling for the WHOLE extraction, attempts and waits included — the value the single call
// already carried. Kept, so no turn gets slower than it could before and nothing that succeeds
// today starts timing out because retries exist.
export const VISION_TOTAL_BUDGET_MS = 60_000;

// What ONE attempt may take. Two numbers because they rest on different evidence: an image is
// measured (2.0-4.4s live through gpt-4o, a 3000x3000 one included; the issue reports 4s in
// production), so 20s is ~5x the slowest and cutting there is what funds a second attempt inside
// the same total. A document is NOT measured — up to 25MB and ~100 pages — so it keeps the whole
// budget and gains a retry only when the failure leaves room, which an overload usually does.
export const VISION_ATTEMPT_CEILING_MS: Record<VisionKind, number> = {
  image: 20_000,
  document: VISION_TOTAL_BUDGET_MS,
};

// Waits before the second and third attempts. Same shape as the attachment-download backoff in the
// Chatwoot client, and short for the same reason: a customer is waiting on this turn.
export const VISION_RETRY_DELAYS_MS = [500, 1_500];

// Derived, never written twice: the loop that spends the attempts and the policy that plans them
// must not be able to disagree about when to stop. Mutating the policy alone turned that loop into
// a spin — the battery hung instead of failing, because a stubbed clock never spends the budget
// that was its only other way out.
export const VISION_MAX_ATTEMPTS = VISION_RETRY_DELAYS_MS.length + 1;

// Applied upward, so a delay lands in [base, base * 1.5). A 503 is upstream overload, and every
// caller retrying on the same schedule is what keeps it overloaded.
const JITTER = 0.5;

// Under this an attempt buys a timeout instead of an answer: the fastest measured call is 2.0s.
const MIN_ATTEMPT_MS = 2_000;

export interface VisionAttemptPlan {
  // How long to wait before making this attempt (0 for the first).
  delayMs: number;
  // This attempt's budget alone, handed to the provider as its abort deadline.
  timeoutMs: number;
}

// The plan for attempt `attempt` (1-based), or null when nothing is left to spend — the attempts
// are used up, or the remainder cannot fund a useful call. `elapsedMs` runs from the first attempt,
// so the waits and the failed calls both count against the total.
//
// Attempt 1 always has a plan: it is asked at zero elapsed, and both ceilings are far above the
// minimum.
export function planVisionAttempt(args: {
  kind: VisionKind;
  attempt: number;
  elapsedMs: number;
  rand?: () => number;
}): VisionAttemptPlan | null {
  const { kind, attempt, elapsedMs } = args;
  if (attempt > VISION_MAX_ATTEMPTS) return null;
  const base = attempt <= 1 ? 0 : (VISION_RETRY_DELAYS_MS[attempt - 2] ?? 0);
  const delayMs = Math.round(
    base * (1 + JITTER * (args.rand ?? Math.random)()),
  );
  const left = VISION_TOTAL_BUDGET_MS - elapsedMs - delayMs;
  const timeoutMs = Math.min(VISION_ATTEMPT_CEILING_MS[kind], left);
  return timeoutMs < MIN_ATTEMPT_MS ? null : { delayMs, timeoutMs };
}
