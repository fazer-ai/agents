import { describe, expect, test } from "bun:test";
import { isNudgeOrigin, nudgeOrigin } from "@/graph/nudge-origin";

// Where a proactive turn came from, as the flow line records it and the console reads it.
describe("nudgeOrigin", () => {
  test("each caller's source maps to its own origin", () => {
    expect(nudgeOrigin({ source: "followup" })).toBe("followup");
    // The snoozed ladder's step: its own origin, so the console does not count it against the
    // bot ladder's steps.
    expect(nudgeOrigin({ source: "followup", kind: "snoozed" })).toBe(
      "snoozed",
    );
    expect(nudgeOrigin({ source: "followup", kind: "inactivity" })).toBe(
      "followup",
    );
    expect(nudgeOrigin({ source: "appointment_reminder" })).toBe("reminder");
    expect(nudgeOrigin({ source: "channel-redirect" })).toBe("redirect");
    // The delivery of a document the team approved is the team speaking, not an external system.
    expect(nudgeOrigin({ source: "document_approval" })).toBe("approval");
  });

  test("every other source is an inbound integration's event", () => {
    for (const source of ["GENERIC", "ASAAS", "SOMETHING_NEW"]) {
      expect(nudgeOrigin({ source })).toBe("event");
    }
  });

  test("the reader accepts exactly the five origins", () => {
    for (const o of [
      "followup",
      "snoozed",
      "reminder",
      "redirect",
      "event",
      "approval",
    ]) {
      expect(isNudgeOrigin(o)).toBe(true);
    }
    for (const o of ["tool", "", null, undefined, 1, "Event"]) {
      expect(isNudgeOrigin(o)).toBe(false);
    }
  });
});
