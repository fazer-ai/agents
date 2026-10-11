import { describe, expect, test } from "bun:test";
import { describeClosedGate } from "@/modules/chatwoot/gate-close";

// The decision the three ownership gates share. The table proves the FUNCTION; that no gate spells
// the outcomes out again is biome-plugins/no-gate-close-outcome-outside-owner.grit.

describe("describeClosedGate", () => {
  const cases: Array<{
    name: string;
    assigneeType: string | null;
    status: string | null;
    expected: ReturnType<typeof describeClosedGate>;
  }> = [
    {
      name: "a human holds it: a real handoff, whatever the status",
      assigneeType: "User",
      status: "open",
      expected: { outcome: "taken_over" },
    },
    {
      name: "a human holds it while still pending",
      assigneeType: "User",
      status: "pending",
      expected: { outcome: "taken_over" },
    },
    {
      name: "escalated out of pending with nobody on it: the ack case",
      assigneeType: null,
      status: "open",
      expected: { outcome: "ownership_lost", status: "open" },
    },
    {
      name: "escalated out of pending while a bot still holds the seat",
      assigneeType: "AgentBot",
      status: "open",
      expected: { outcome: "ownership_lost", status: "open" },
    },
    {
      name: "another party's bot holds it, still pending",
      assigneeType: "AgentBot",
      status: "pending",
      expected: { outcome: "ownership_lost", status: "pending" },
    },
    {
      name: "resolved out from under the turn",
      assigneeType: null,
      status: "resolved",
      expected: { outcome: "ownership_lost", status: "resolved" },
    },
    {
      name: "an unreadable status still names the outcome",
      assigneeType: null,
      status: null,
      expected: { outcome: "ownership_lost", status: "unknown" },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        describeClosedGate({ assigneeType: c.assigneeType, status: c.status }),
      ).toEqual(c.expected);
    });
  }
});
