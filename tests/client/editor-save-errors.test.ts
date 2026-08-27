import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The server refuses a write whose settings text is over a cap, and the refusal is only actionable
// because it names the field, the length and the limit — a handler that swallows it and shows its
// own generic toast leaves the operator with "could not save" and nothing to shorten. That is how
// the clone path shipped: the assertion was added on the server and the button kept its own message.
//
// Checked on the source because rendering the editor pulls auth, theme, toast and a live catalog,
// and the toast text these handlers produce is the whole subject. apiErrorMessage.test.ts proves the
// extraction itself; this proves nobody writes a new save that forgets to use it.
const SRC = readFileSync("src/client/pages/agents/AgentEditorPage.tsx", "utf8");

// A write to the agent row: what settings text caps are enforced on.
const WRITES = /\.patch\(|\.clone\.post\(/;

function handlers(src: string): { name: string; body: string }[] {
  return src
    .split(/\n {2}(?:async )?function /)
    .slice(1)
    .map((part) => ({
      name: part.slice(0, Math.max(0, part.indexOf("("))),
      body: part,
    }));
}

describe("agent editor save errors", () => {
  // `saveAgent` writes BOTH sections and the held refusal covers one of them. A successful Behavior
  // save carries neither `name` nor `systemPrompt`, so clearing there answers a refusal nothing
  // answered: the operator returns to General to a form that looks clean and is still refused.
  //
  // Source-level for the same reason as the rest of this file — the two sections are two arguments
  // to one function, and the distinction is invisible to anything that only watches the network.
  test("a successful save clears only what the request carried", () => {
    // Since #349 the holder covers every tab, so the question got wider. Scoping it by TAB is not
    // enough and the gap is real: `saveGrants` writes the grant set alone and shares the Tools tab
    // with the handoff, kanban and tool-guidance notes, so a grant-only PUT would clear a refusal
    // about a note it never mentioned. The snapshot the write went out with is the list of what it
    // can answer for.
    expect(SRC.split("refusal.clear()").length - 1).toBe(1);
    const start = SRC.indexOf("function clearRefusalFor");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf("\n  }", start));
    expect(body).toContain("refusal.clear()");
    expect(body).toContain("Object.hasOwn(sent, held)");
    // Never by tab or by target: both read the FIELD rather than the request.
    expect(body).not.toContain("editorTargetFor");

    // And every success path goes through it. The grant-only save answers for nothing and says so
    // with an empty snapshot rather than by skipping the call, so a reader can tell "carried nothing"
    // from "forgot to clear".
    const cleared = [
      ...SRC.matchAll(/(?<!function )clearRefusalFor\((.+?)\)/g),
    ].map((m) => (m[1] as string).trim());
    expect(cleared.sort()).toEqual(["sent", "sent", "sent", "{}"]);
  });

  test("what a save carried is snapshotted before the request goes out", () => {
    // `currentRef` is LIVE. Building the sent map in the catch compares the boxes with themselves,
    // the staleness check can never fire, and a refusal about a value the operator has already
    // changed gets marked on the new one — which is the exact thing `placeRefusal` refuses to do.
    for (const fn of [
      "saveAgent",
      "saveGrants",
      "saveTools",
      "saveGuardrails",
    ]) {
      const start = SRC.indexOf(`async function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const body = SRC.slice(start, SRC.indexOf("\n  }", start));
      const snapshot = body.indexOf("sentFor(");
      const answers = body.indexOf("answerRefusal(");
      if (snapshot === -1) {
        // Only the grant-only save may carry nothing, and then it must say so literally.
        expect(body, fn).toContain("clearRefusalFor({})");
        continue;
      }
      expect(snapshot, `${fn} snapshots after answering`).toBeLessThan(answers);
      // Before the request, not merely before the catch.
      expect(snapshot, `${fn} snapshots after its request`).toBeLessThan(
        body.indexOf("await "),
      );
    }
  });

  // THE SECOND CHANNEL, WHEN THE CONTROL IS NOT ON SCREEN.
  //
  // `placeRefusal` hands back a sentence beside the mark for a value this editor owns and is not
  // drawing, and the sentence has to reach the operator or the save fails into silence. A toast is
  // the wrong container for it twice over — it takes the only copy of the reason away after five
  // seconds, and it cannot carry the way to the control — so the editor renders it as a banner that
  // stays until the refusal is answered.
  //
  // Source-level because mounting this page pulls auth, theme, toast and a live catalog; the mark
  // reaching a box is proved on the tab that CAN be mounted (pages/GuardrailsTab.test.tsx).
  test("the banner carries every refusal nothing else on screen is holding", () => {
    const start = SRC.indexOf("const bannerMessage =");
    expect(start).toBeGreaterThan(-1);
    const decl = SRC.slice(start, SRC.indexOf(";", start));
    // Two sources, and the difference between them is the whole rule: a mark this render is DRAWING
    // says it itself, one it is not drawing is announced, and a sentence with no mark at all has
    // nowhere else to go.
    expect(decl).toContain("heldMessage");
    expect(decl).toContain("heldDrawn");
    expect(decl).toContain("standingRefusal");
    // `heldDrawn` asks the drawn list, never the tab: a section switched off after the refusal landed
    // takes the control away without changing which tab it is on.
    const drawnDecl = SRC.slice(
      SRC.indexOf("const heldDrawn ="),
      SRC.indexOf(";", SRC.indexOf("const heldDrawn =")),
    );
    expect(drawnDecl).toContain("refusalFields.drawn");
    expect(drawnDecl).not.toContain("tab ===");
    // And it is rendered with the jump when there is one to offer.
    const banner = SRC.slice(SRC.indexOf("{bannerMessage && ("));
    const body = banner.slice(0, banner.indexOf("\n            )}"));
    expect(body).toContain("{bannerMessage}");
    expect(body).toContain("goToEditorTarget(bannerTarget)");
  });

  test("nothing the holder hands back is dropped", () => {
    // The first version routed on `editorTargetFor(named)` — whether the refused NAME has a place in
    // this editor — and swallowed the sentence when it did. That reads the field instead of what the
    // hook did with it, and the two come apart: a mapped name can still fail to be placed (the value
    // was edited during the request, the follow-up step no longer exists), and then the sentence went
    // nowhere and no mark existed to render it. A save that fails in silence.
    const start = SRC.indexOf("function answerRefusal");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf("\n  }", start));
    expect(body).toContain("setStandingRefusal");
    expect(body).toContain("refusal.capture(");
    // No branch at all: whatever comes back is kept, and the render decides the container.
    expect(body).not.toContain("editorTargetFor");
    expect(body).not.toContain("if (");
    // This page does not toast a save refusal any more — the banner is the one container, and it
    // stays put while the input is still refused.
    expect(body).not.toContain("showToast");
  });

  test("the tools preflight compares against the stored bag, re-read when forced", () => {
    const start = SRC.indexOf("function settingsTextError");
    expect(start).toBeGreaterThan(-1);
    expect(SRC.slice(start, SRC.indexOf("\n  }", start))).toContain(
      "collectOversizedTextChanges",
    );
    // A forced overwrite follows a 409, so the synced bag is stale by definition: comparing against
    // it can pass a check the PATCH then fails, with the grants PUT already persisted.
    const save = SRC.slice(SRC.indexOf("async function saveTools"));
    const call = save.slice(0, save.indexOf("settingsTextError("));
    expect(call).toContain("force");
    expect(call).toContain("agents({ id }).get()");
  });

  test("every handler that writes the agent shows the server's message", () => {
    const writers = handlers(SRC).filter((h) => WRITES.test(h.body));
    // Guards the parser itself: a rename or a refactor that stops matching would make the offender
    // list empty and this test vacuously green.
    expect(writers.map((h) => h.name).sort()).toEqual([
      "doClone",
      "saveAgent",
      "saveChannelRedirect",
      "saveGuardrails",
      "saveTools",
    ]);
    // The holder is often under a qualified name (`cloneRefusal`), because a page with two forms needs
    // one per form.
    //
    // `refusal.capture` is the same read plus a placement: it answers the server's sentence, or null
    // once that sentence is already rendered at the input it names (#320). A handler that routes
    // through it has not stopped showing what the server said — it has stopped needing a toast.
    //
    // Followed through a NAME, because a page with five saves writes the routing once and calls it
    // from each of them: `answerRefusal` captures, decides between the banner and the toast, and is
    // the only thing any handler here says. Asking for the literal `refusal.capture` inside every
    // handler would demand the duplication the helper exists to remove.
    const routers = handlers(SRC)
      .filter((h) => /apiErrorMessage|[Rr]efusal\.capture/.test(h.body))
      .map((h) => h.name);
    // Guards this half of the parser the same way the list above guards the other: a helper that
    // stops reading the server's message would empty this list and pass every handler below.
    expect(routers).toContain("answerRefusal");
    const shows = new RegExp(
      `apiErrorMessage|[Rr]efusal\\.capture|\\b(?:${routers.join("|")})\\(`,
    );
    expect(
      writers.filter((h) => !shows.test(h.body)).map((h) => h.name),
    ).toEqual([]);
  });
});
