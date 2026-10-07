// WHICH GATE ANSWERS FOR EACH BILLED CALL, per `LlmUsage.node`, TOTAL over the ledger's node
// vocabulary. A fence test (tests/modules/spend-ceiling-coverage.test.ts) compares the key set
// against `USAGE_NODE_IS_AGENT_TURN`, so a new node without an answer here is a red test. There is
// deliberately no default: either default would hide a billed path that can spend past the ceiling.

export type SpendGateSite =
  // Something asks the ceiling immediately before this call, on EVERY path that reaches it.
  | "gated"
  // This call only ever runs INSIDE a unit of work whose gate already ran, and gating it a second
  // time would abandon a unit halfway: the tokens of the first half are spent either way, and what
  // the customer gets instead is worse than the overspend (an unscreened reply, or none at all).
  | "covered-by-the-unit"
  // NOT covered by anything, and not gated: this call can run with no enclosing verdict and spends
  // past the ceiling. A DECISION, which is why it is its own word — "covered-by-the-unit" would say
  // a gate answers for it when none does, and that is the sentence this whole file exists to keep
  // anyone from writing by accident. An entry here owes the argument AND the cost it accepts.
  | "ungated-by-decision";

export const SPEND_GATE_FOR_NODE: Readonly<Record<string, SpendGateSite>> =
  Object.freeze({
    // The reactive turn. Gated in the Chatwoot webhook (inbox) and in `runPlaygroundTurn`
    // (playground), both before the graph is built.
    agent: "gated",
    // The proactive follow-up. Gated in `runAgentNudge` and in `runPlaygroundFollowup`.
    nudge: "gated",
    // Moderation, on the guardrails agent's own model. NOT gated separately, and this is the one
    // entry worth arguing with: a ceiling that switched the screening off would let the ceiling
    // decide a safety question. On the output direction the reply is already written and paid for,
    // so refusing here either posts it unscreened or drops a reply the customer is waiting for; on
    // the input direction the turn behind it was already allowed. The unit is the right granularity.
    guardrail: "covered-by-the-unit",
    // Speech normalization, inside a turn that was allowed.
    tts_normalize: "covered-by-the-unit",
    // Memory compaction runs from its own `MEMORY_COMPACT` job, outside any turn, and is out of the
    // ceiling by DECISION: refusing it does not save tokens, it moves them into the next turn's
    // history. So a tenant past its ceiling keeps paying for compaction (see docs/spend-ceiling.md).
    memory_compact: "ungated-by-decision",
    // Vision runs on the incoming attachment BEFORE any turn gate decides anything, so it is the one
    // sub-call that has to ask for itself.
    vision: "gated",
    // The OBSERVE job: its own scheduler job, outside any turn, so it asks the ceiling itself right
    // before its one model call. A refusal leaves a label as it was, nothing a customer waits on.
    observer: "gated",
    // The OBSERVE job on the `decisions` engine asks the same gate, in the same place, right before
    // its one classification call.
    decision: "gated",
    // The SUGGESTION_REVIEW job: its own scheduler job, outside any turn, so it asks the ceiling
    // itself right before its one model call. A refusal queues the proposal unreviewed.
    suggestion_review: "gated",
  });
