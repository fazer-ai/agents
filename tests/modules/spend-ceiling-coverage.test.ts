import { describe, expect, it } from "bun:test";
import { USAGE_NODE_IS_AGENT_TURN } from "@/graph/usage";
import { SPEND_GATE_FOR_NODE } from "@/modules/spend-ceiling/coverage";

// THE FENCE. A spend ceiling is one question asked in several places, and the failure mode of that
// shape is not a wrong answer, it is a place that never asks (measured twice already: #134 and
// #177). Nothing in the type system connects `LlmUsage.node` to a gate, so the connection is this
// test: every node the ledger can carry has to name which gate answers for it, and a node added
// without one fails here rather than quietly spending past the ceiling.

describe("spend ceiling coverage", () => {
  it("answers for every node the ledger can carry", () => {
    expect(Object.keys(SPEND_GATE_FOR_NODE).sort()).toEqual(
      Object.keys(USAGE_NODE_IS_AGENT_TURN).sort(),
    );
  });

  it("gives every node one of the two answers", () => {
    for (const [node, site] of Object.entries(SPEND_GATE_FOR_NODE)) {
      expect(
        ["gated", "covered-by-the-unit", "ungated-by-decision"],
        node,
      ).toContain(site);
    }
  });

  // The two ways in that no enclosing gate precedes. `agent` and `nudge` are the units themselves;
  // `vision` runs on the incoming attachment before any of them decides anything. Pinned as VALUES
  // rather than derived, so moving one of them to "covered-by-the-unit" has to be a deliberate edit
  // to a test that says why, and cannot happen as a side effect of a refactor.
  it("holds the three that ask for themselves", () => {
    expect(SPEND_GATE_FOR_NODE.agent).toBe("gated");
    expect(SPEND_GATE_FOR_NODE.nudge).toBe("gated");
    expect(SPEND_GATE_FOR_NODE.vision).toBe("gated");
    // And the one node that no gate answers for says so in its own word. "covered-by-the-unit" here
    // would claim a verdict that does not exist: compaction runs from its own scheduler job, not
    // inside a turn. Pinned so moving it back is a deliberate edit with a red test in between.
    expect(SPEND_GATE_FOR_NODE.memory_compact).toBe("ungated-by-decision");
  });
});
