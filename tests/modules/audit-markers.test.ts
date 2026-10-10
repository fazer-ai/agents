import { describe, expect, test } from "bun:test";
import { carriesAuditMarker } from "@/lib/audit/markers";
import { agentUpdateAudit } from "@/modules/agents/audit-projection";
import { markUndisclosed } from "@/modules/audit/projection";

// The console renders a row it did not write, so it has to know every marker a producer can put on
// a projection, nested ones included; a marker it does not know renders an agent edit that moved only
// unread configuration as "this action recorded no field values", the trail denying a mutation it
// holds. This file keeps the list true when the next family adds a marker.
describe("the audit markers a reader has to know", () => {
  // Each producer driven to the change it marks: a write that moved only what the row does not show.
  test("every marker a projection module writes is one the reader finds", () => {
    expect(carriesAuditMarker(markUndisclosed({ name: "x" }))).toBe(true);
    const audit = agentUpdateAudit(
      { settings: { notARealBlock: { a: 1 } } },
      { settings: { notARealBlock: { a: 2 } } },
    );
    expect(audit).not.toBeNull();
    expect(carriesAuditMarker(audit?.before)).toBe(true);
    expect(carriesAuditMarker(audit?.after)).toBe(true);
  });

  test("a marker is found wherever a producer puts it, not only at the top", () => {
    expect(carriesAuditMarker({ undisclosedChanged: true })).toBe(true);
    // NOTE: the settings shape: the marker rides on the FIELD's own projection.
    expect(
      carriesAuditMarker({ settings: { unreadConfigChanged: true } }),
    ).toBe(true);
    expect(
      carriesAuditMarker({ a: [{ b: { unreadConfigChanged: true } }] }),
    ).toBe(true);
    expect(carriesAuditMarker({ name: "x", nested: { n: 1 } })).toBe(false);
    // `true` and only `true`: a field an operator happens to name like a marker is not one.
    expect(carriesAuditMarker({ undisclosedChanged: "yes" })).toBe(false);
    expect(carriesAuditMarker(null)).toBe(false);
    expect(carriesAuditMarker("undisclosedChanged")).toBe(false);
  });
});
