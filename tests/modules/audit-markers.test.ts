import { describe, expect, test } from "bun:test";
import { AUDIT_MARKER_KEYS, carriesAuditMarker } from "@/lib/audit/markers";

// The console renders a row it did not write, so it has to know every marker a producer can put on
// a projection. It knew one of two, and the one it did not know is nested rather than top-level, so
// an agent edit that moved only unread configuration rendered as "this action recorded no field
// values": the trail denying a mutation it holds. The list is the fix; this file is what keeps it
// true when the next family adds a marker.
describe("the audit markers a reader has to know", () => {
  test("every marker a projection module writes is on the list", async () => {
    const producers = [
      "../../src/modules/audit/projection.ts",
      "../../src/modules/agents/audit-projection.ts",
    ];
    const found = new Set<string>();
    for (const rel of producers) {
      const src = await Bun.file(new URL(rel, import.meta.url)).text();
      // Comment lines stripped first: both modules DISCUSS the other's marker by name, and a fence
      // that counts prose finds markers nobody writes.
      const code = src.replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/(\w+Changed)\s*:\s*true/g)) {
        found.add(m[1] as string);
      }
    }
    // Worthless if it matched nothing, which is how a rename turns this green forever.
    expect(found.size).toBeGreaterThanOrEqual(2);
    expect([...found].sort()).toEqual([...AUDIT_MARKER_KEYS].sort());
  });

  test("a marker is found wherever a producer puts it, not only at the top", () => {
    expect(carriesAuditMarker({ undisclosedChanged: true })).toBe(true);
    // #394's shape: the marker rides on the FIELD's own projection.
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
