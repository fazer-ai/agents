import type { RunAgentNudgeOutcome } from "@/graph/nudge";

// What a proactive job does with a nudge that posted NOTHING for a reason an operator (or time) can
// repair. The three callers of `runAgentNudge` used to answer this separately, and only one of them
// answered it at all: the generic follow-up retried `live-unavailable` and `deferred` while the
// appointment reminder and the redirect ladder discarded every outcome, so an occasion that had
// produced no message was consumed exactly like one that had. Issue #281 measured the cost with a
// model credential that does not resolve: the agent exists, is enabled and is expected to answer,
// and the follow-up episode burned step by step, the reminder was marked done, and the ladder
// advanced a stage, none of them having said anything to anyone.
//
// The question is deliberately ONE predicate rather than a condition repeated per caller: the rule
// was already duplicated when it existed in one place, because the next caller inherited nothing.

// 15 minutes, 8 attempts: two hours of a broken credential or a held interrupt, which is the span an
// operator plausibly fixes something in, and a bound short enough that a job cannot outlive the
// occasion it exists for. Inherited unchanged from the generic follow-up handler, which is the only
// one of the three that already had a ladder.
export const NUDGE_RETRY_BACKOFF_MS = 900_000;
export const NUDGE_RETRY_LIMIT = 8;

// Nothing was posted, and the reason may not hold next time. The three members differ in what is
// broken and agree on what it costs, which is the only thing a caller has to decide about:
//
//   agent-unavailable  the agent cannot author right now (its credential does not resolve, or it is
//                      switched off); see runAgentNudge, which separates this from "no agent here"
//   live-unavailable   the live-state probe could not run, so ownership is unknown and the send was
//                      fail-closed
//   deferred           a human-in-the-loop interrupt is pending on the thread
//
// Every other outcome is excluded on purpose. `no-agent` and `no-conversation` have no occasion left
// to preserve; `stale` means the conversation stopped being ours, which retrying cannot undo;
// `silent`, `noted` and `noted-window` mean the agent DID take its turn and chose to say nothing or
// to say it in a note, and re-running those would author a second turn for one occasion.
export function isRepairableNudgeRefusal(
  outcome: RunAgentNudgeOutcome,
): boolean {
  return (
    outcome === "agent-unavailable" ||
    outcome === "live-unavailable" ||
    // The month turns over on its own, and the operator can raise the number: a follow-up step
    // burned against a ceiling would be a message the customer never gets and nobody re-sends.
    outcome === "over-ceiling" ||
    outcome === "deferred"
  );
}

export type NudgeRetryDecision =
  | { retry: true; runAt: Date; attempt: number }
  | { retry: false; attempt: number };

// The attempt counter rides in the job's own payload, so it survives the reschedule without a column
// and resets naturally when a new occasion enqueues a fresh row. A value that is not a positive
// integer reads as zero rather than as itself: a negative one would otherwise push the ladder's
// ceiling out of reach and retry forever, which is the one failure a bound exists to prevent.
export function nextNudgeRetry(
  payload: Record<string, unknown>,
  now: Date = new Date(),
): NudgeRetryDecision {
  const prior = payload.nudgeRetries;
  const attempt =
    (typeof prior === "number" && Number.isInteger(prior) && prior > 0
      ? prior
      : 0) + 1;
  return attempt >= NUDGE_RETRY_LIMIT
    ? { retry: false, attempt }
    : {
        retry: true,
        runAt: new Date(now.getTime() + NUDGE_RETRY_BACKOFF_MS),
        attempt,
      };
}
