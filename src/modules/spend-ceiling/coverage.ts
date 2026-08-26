// WHICH GATE ANSWERS FOR EACH BILLED CALL (issue #146).
//
// The ceiling is one question asked in several places, which is the shape that reliably ships
// missing from the N+1 place. So the answer is written down per `LlmUsage.node`, TOTAL over the
// ledger's own node vocabulary, and a fence test (tests/modules/spend-ceiling-coverage.test.ts)
// compares the key set against `USAGE_NODE_IS_AGENT_TURN`: a node added to the ledger without an
// answer here is a red test, never a silent default.
//
// Defaulting either way is what this exists to prevent. Defaulting to "gated" would let a new
// billed path spend past the ceiling while the map claims it cannot; defaulting to "covered" would
// hide the same thing behind a word that sounds like coverage.

export type SpendGateSite =
  // Something asks the ceiling immediately before this call, on EVERY path that reaches it.
  | "gated"
  // This call only ever runs INSIDE a unit of work whose gate already ran, and gating it a second
  // time would abandon a unit halfway: the tokens of the first half are spent either way, and what
  // the customer gets instead is worse than the overspend (an unscreened reply, or none at all).
  | "covered-by-the-unit";

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
    // Memory compaction, inside a turn that was allowed. Deliberately out of the issue's scope: it
    // is the one billed call whose refusal makes the NEXT turn cost more, so a ceiling that skipped
    // it would raise spend rather than bound it.
    memory_compact: "covered-by-the-unit",
    // Vision runs on the incoming attachment BEFORE any turn gate decides anything (#316 measured
    // the same asymmetry for attribution), so it is the one sub-call that has to ask for itself.
    vision: "gated",
  });
