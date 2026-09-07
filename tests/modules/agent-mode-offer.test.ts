import { describe, expect, test } from "bun:test";
import {
  AGENT_MODES,
  isMonitoring,
  normalizeAgentMode,
  SELECTABLE_AGENT_MODES,
} from "@/modules/agents/mode";

// WHAT A WRITE MAY SET IS NOT WHAT A READ MAY SEE, while `monitoring` waits for its output.
//
// The mode ships in the code and is held back from every offer until an agent can be bound as an
// observer BESIDE the inbox's responder (#476) and something writes the verdict back (#477). Until
// then `Inbox.agentId` is one column, so an operator choosing it gets an inbox nobody answers and
// nothing to read.
//
// This file is the reminder. When the mode goes back on offer these tests go red, and the fix is to
// delete `SELECTABLE_AGENT_MODES` and point the four write boundaries at `AGENT_MODES` again.

describe("the modes on offer", () => {
  test("does not offer monitoring", () => {
    expect(SELECTABLE_AGENT_MODES).not.toContain("monitoring");
  });

  // EVERY OFFERED MODE IS A REAL ONE, which is the direction that would break silently: a value the
  // offer carries and the reader does not becomes `production` at the fallback below.
  test("offers only modes the reader knows", () => {
    for (const m of SELECTABLE_AGENT_MODES) {
      expect(AGENT_MODES).toContain(m);
      expect(normalizeAgentMode(m)).toBe(m);
    }
  });
});

// AND THE READER STILL KNOWS IT, which is the whole reason the offer is a separate list.
//
// Dropping `monitoring` from `AGENT_MODES` is the one-line version of this change and it silences
// nobody: `normalizeAgentMode` answers `production` for a value it does not know, so an agent an
// operator had set to monitoring would come back answering customers on the upgrade that hid the
// mode. These two assertions are what make that a red test rather than a released defect.
describe("what the reader still recognizes", () => {
  test("a stored monitoring row is not read as production", () => {
    expect(normalizeAgentMode("monitoring")).toBe("monitoring");
    expect(isMonitoring(normalizeAgentMode("monitoring"))).toBe(true);
  });

  test("the reader's set is the offer plus exactly what is held back", () => {
    expect(AGENT_MODES).toContain("monitoring");
    const held = AGENT_MODES.filter(
      (m) => !(SELECTABLE_AGENT_MODES as readonly string[]).includes(m),
    );
    expect(held).toEqual(["monitoring"]);
  });
});
