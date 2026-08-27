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
  test("a successful save clears the holder only for the section it wrote", () => {
    // Since #349 the holder covers every tab, so the question got wider without changing: the clear
    // is scoped by asking WHERE the standing mark lives and comparing that with the section this save
    // wrote. One call site, inside the one function that asks.
    expect(SRC.split("refusal.clear()").length - 1).toBe(1);
    const start = SRC.indexOf("function clearRefusalFor");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf("\n  }", start));
    expect(body).toContain("refusal.clear()");
    expect(body).toContain("editorTargetFor");
    expect(body).toContain("=== section");

    // And every success path goes through it rather than clearing on its own, which is what the
    // previous version of this rule could not say: it could only speak for the single call site it
    // found. A save that writes a section and clears nothing leaves a refusal standing that the
    // server has stopped making.
    // Call sites only: the declaration reads `clearRefusalFor(section: string)` and would otherwise
    // count itself as a caller that clears every section.
    const cleared = [
      ...SRC.matchAll(/(?<!function )clearRefusalFor\((.+?)\)/g),
    ].map((m) => (m[1] as string).replace(/"/g, ""));
    expect(cleared.sort()).toEqual(["guardrails", "section", "tools", "tools"]);
  });

  // The tools save fires two calls (grants PUT, then agent PATCH), so it checks the bag itself before
  // the first one — otherwise the grants persist and the PATCH is refused. It has to ask the same
  // question the server asks: what does this write CHANGE. Comparing against nothing would refuse a
  // save over text stored before the caps, which is the state the server deliberately lets through.
  //
  // Source-level for the same reason as the rest of this file; the rule itself is covered by
  // agents-text-caps.test.ts, what is left here is the wiring.
  // THE SECOND CHANNEL, WHEN THE CONTROL IS ON ANOTHER TAB.
  //
  // `placeRefusal` hands back a sentence beside the mark for a value this editor owns and is not
  // drawing, and the sentence has to reach the operator or the save fails into silence. A toast is
  // the wrong container for it twice over — it takes the only copy of the reason away after five
  // seconds, and it cannot carry the way to the control — so the editor renders it as a banner that
  // stays until the refusal is answered.
  //
  // Source-level because mounting this page pulls auth, theme, toast and a live catalog; the mark
  // reaching a box is proved on the tab that CAN be mounted (pages/GuardrailsTab.test.tsx).
  test("the off-screen refusal is announced, with the way to the control", () => {
    const start = SRC.indexOf("const refusalAway =");
    expect(start).toBeGreaterThan(-1);
    const decl = SRC.slice(start, SRC.indexOf(";", start));
    // Derived from the holder and from the OPEN TAB, which is what keeps the two channels from ever
    // saying the same thing at the same time: arriving at the tab takes the banner away and leaves
    // the mark, and answering the refusal takes both.
    expect(decl).toContain("heldMessage");
    expect(decl).toContain("heldTarget.tab !== tab");
    // Never stored. A copy in state is a second source of truth that outlives what it describes.
    expect(SRC).not.toContain("setRefusalAway");
    // And it is rendered with the jump, not just the sentence.
    const banner = SRC.slice(SRC.indexOf("{refusalAway && ("));
    const body = banner.slice(0, banner.indexOf("\n            )}"));
    expect(body).toContain("refusalAway.message");
    expect(body).toContain("goToEditorTarget(refusalAway.target)");
  });

  test("a toast fires only for a refusal this editor draws no control for", () => {
    // The other half of the exclusivity: a 403, a conflict or a transport failure names no input of
    // this page's, and for those the toast is still the only channel there is. Toasting a refusal the
    // banner is already showing is the duplicate the mechanism exists to avoid.
    const start = SRC.indexOf("function answerRefusal");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf("\n  }", start));
    expect(body).toContain("editorTargetFor");
    expect(body).toContain('if (!placeable) showToast(left, "error");');
    // Exactly one, so the assertion above speaks for the whole function.
    expect(body.split("showToast(").length - 1).toBe(1);
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
