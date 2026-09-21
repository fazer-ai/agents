import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// THE BUTTON THAT ASKS FOR A RANK (issue #753).
//
// `POST /v1/conversations/:id/reengage` asks for `TENANT_ADMIN`, and this page is the one console
// route deliberately NOT admin-gated (`docs/ui.md`): it is the attendant's screen. So "Respond now"
// has to be off for a rank the route will refuse, or an AGENT gets a 403 for pressing a button —
// which reads as a broken product and invites pressing it again on a conversation they will never
// re-engage. The other three ops on the screen stay: they are what an attendant is for.
//
// It is reachable, not hypothetical: the offer is raised by a SUCCESSFUL return-to-AI, which an
// AGENT may do, so before the fence the button appeared for them one click later.
//
// CHECKED ON THE SOURCE, for the reason `conversation-outcomes.test.ts` gives about the same file:
// rendering this page pulls auth, theme, toast, realtime and a live conversation, and what is under
// test is one condition. The rank's own meaning is covered in `tests/api/v1/reengage-role-gate.test.ts`,
// against the real route; what is left here is that nobody drops the condition from the screen.
const SRC = readFileSync("src/client/pages/ConversationDetailPage.tsx", "utf8");

describe("the re-engage button is not offered below TENANT_ADMIN", () => {
  test("the gate is derived from the role hierarchy, not from a comparison with AGENT", () => {
    // `isAdminRole` is `roleAtLeast(role, "TENANT_ADMIN")`, so SUPER_ADMIN passes. A screen written
    // as `role !== "AGENT"` is the spelling `docs/tenancy.md` refuses by name.
    expect(SRC).toContain('import { isAdminRole } from "@/client/lib/roles"');
    expect(SRC).toContain("const mayReengage = isAdminRole(user?.role)");
    expect(SRC).not.toContain('role !== "AGENT"');
  });

  test("BOTH re-engage buttons carry it, and the second one is the trap", () => {
    // The page has two doors to the same endpoint: the header's "Respond now" and the failure
    // card's "Re-engage", which appears whenever the conversation still carries a `lastError`. The
    // card outlives the turn that failed, so an attendant meets it long after — and gating only the
    // header would leave the 403 exactly where it is least expected.
    for (const label of [
      't("conversation.respondNow"',
      '"conversation.reengage.action"',
    ]) {
      const at = SRC.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      const gate = SRC.lastIndexOf("{mayReengage &&", at);
      expect(gate).toBeGreaterThan(-1);
      // No other JSX conditional opens between the gate and the label, so the gate is THIS
      // button's and not one belonging to an earlier block.
      expect(SRC.slice(gate, at).split("&& (").length - 1).toBe(1);
    }
  });

  test("the button's own render condition carries it", () => {
    // The block that renders the offer, found by the label it shows, then read BACKWARDS to the
    // condition that opens it. Anchored on the translation key rather than on a line number so a
    // reflow of the JSX cannot quietly empty the test.
    const label = SRC.indexOf('t("conversation.respondNow"');
    expect(label).toBeGreaterThan(-1);
    const openedAt = SRC.lastIndexOf("{mayReengage &&", label);
    expect(openedAt).toBeGreaterThan(-1);
    // ...and it is THIS button's condition, not one belonging to an earlier block: nothing else
    // opens a JSX conditional between the gate and the label.
    const between = SRC.slice(openedAt, label);
    expect(between).toContain("offerReengage");
    expect(between).toContain('conv.status === "pending"');
    expect(between.split("&& (").length - 1).toBe(1);
  });
});
