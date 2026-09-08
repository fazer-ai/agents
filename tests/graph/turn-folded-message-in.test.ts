import { describe, expect, test } from "bun:test";
import { type RunAgentTurnOutcome, turnFoldedMessageIn } from "@/graph/runtime";

// WHAT THE LATE-TRANSCRIPTION GATE ASKS, pinned outcome by outcome (issue #576). The classification
// is `graph.invoke`: it persists the channel, so an outcome decided after it leaves the customer's
// message in memory whatever the model produced, and one decided before it leaves it in nobody's.
//
// The `switch` in the runtime is exhaustive, so the COMPILER already refuses a new outcome that
// nobody classified. What this file adds is the answer itself: a reclassification compiles fine and
// costs either a duplicate line in memory or the customer's words, depending which way it goes.
describe("turnFoldedMessageIn", () => {
  // Decided after the invoke.
  test.each<RunAgentTurnOutcome>([
    "posted",
    "posted-partial",
    // THE ONE THAT MOTIVATED THE SPLIT: the settlement calls this `consumed`, the same word a gate
    // that took the message gets, and the message is in the checkpoint all the same.
    "empty",
    // The post-model ownership recheck, which runs once the turn has read and written the thread.
    "taken-over",
  ])("%s leaves the message in the thread", (outcome) => {
    expect(turnFoldedMessageIn(outcome)).toBe(true);
  });

  // Decided before it, or deliberately left for a later run.
  test.each<RunAgentTurnOutcome>([
    // The INPUT guardrail, which answers ahead of the second ask that guards the invoke.
    "blocked",
    "skipped",
    "no-agent",
    // Both leave the watermark where it is so a later run answers the burst; claiming the message is
    // remembered would take it out of that run's reach.
    "stale",
    "superseded",
    // Ambiguous — a config that never loaded, OR a turn that invoked and then stood down at the send
    // fence — and answered the safe way: a duplicate line is visible, lost words are silent.
    "agent-unavailable",
  ])("%s leaves it in nobody's", (outcome) => {
    expect(turnFoldedMessageIn(outcome)).toBe(false);
  });
});
