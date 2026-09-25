import { describe, expect, test } from "bun:test";
import { isNudgeOrigin, nudgeOrigin } from "@/graph/nudge-origin";

// Issue #846: where a proactive turn came from, as the flow line records it and the console reads it.
describe("nudgeOrigin", () => {
  test("each caller's source maps to its own origin", () => {
    expect(nudgeOrigin({ source: "followup" })).toBe("followup");
    expect(nudgeOrigin({ source: "appointment_reminder" })).toBe("reminder");
    expect(nudgeOrigin({ source: "channel-redirect" })).toBe("redirect");
  });

  test("every other source is an inbound integration's event", () => {
    for (const source of ["GENERIC", "ASAAS", "SOMETHING_NEW"]) {
      expect(nudgeOrigin({ source })).toBe("event");
    }
  });

  test("the reader accepts exactly the four origins", () => {
    for (const o of ["followup", "reminder", "redirect", "event"]) {
      expect(isNudgeOrigin(o)).toBe(true);
    }
    for (const o of ["tool", "", null, undefined, 1, "Event"]) {
      expect(isNudgeOrigin(o)).toBe(false);
    }
  });
});
