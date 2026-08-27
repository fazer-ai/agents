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
    // about a note it never mentioned.
    const start = SRC.indexOf("function clearRefusalFor");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf("\n  }", start));
    expect(body).toContain("Object.hasOwn(sent, held)");
    // And the VALUE, not only the path. `sent` is read from the patch, so a Behavior save carries
    // `guardrails.customPolicy` from the last-synced bag — the stored value, not the edit the server
    // refused. Presence alone would let that save answer a refusal it never re-sent.
    expect(body).toContain("now.at(held, sent[held])");
    // Through a ref, never the closure: a save handler closes over the render that launched it, and
    // this page's saves are long enough for another tab's save to fail while one is in flight. An
    // older success answering from its own render would clear a refusal that arrived after it — and
    // `at` is memoized on the hold, so even the comparison would be the stale one.
    expect(body).toContain("refusalRef.current");
    expect(body).toContain("refusedSaveRef.current");
    expect(body).not.toContain("refusal.field");
    // A sentence the holder could place NOWHERE has no value to compare, so it is answered by the
    // section that produced it.
    expect(body).toContain("refusedSaveRef.current?.section === section");
    // Never by tab or by target: both read the FIELD rather than the request.
    expect(body).not.toContain("editorTargetFor");

    // And every success path goes through it. The grant-only save answers for nothing and says so
    // with an empty snapshot rather than by skipping the call, so a reader can tell "carried nothing"
    // from "forgot to clear".
    const cleared = [
      ...SRC.matchAll(/(?<!function )clearRefusalFor\(([^)]*)\)/g),
    ].map((m) => (m[1] as string).replace(/\s+/g, " ").trim());
    expect(cleared.sort()).toEqual([
      '"guardrails", sent',
      '"knowledge", {}',
      '"tools", sent',
      "section, sent",
    ]);
    // The section a save answers for is the FORM it belongs to, not the tab its fields print on:
    // `saveGrants` is the Knowledge tab's save (its only caller passes `dirty.knowledge`), and
    // calling it `tools` let a successful Tools save clear a Knowledge failure still unsaved.
    const grants = SRC.slice(SRC.indexOf("async function saveGrants("));
    const grantsBody = grants.slice(0, grants.indexOf("\n  }"));
    expect(grantsBody).toContain('clearRefusalFor("knowledge", {})');
  });

  test("the page keeps no copy of the sentence", () => {
    // The rule three rounds of review arrived at the hard way. A page that stores the sentence beside
    // a holder that is already storing it has two sources of truth for one fact, and they drift in
    // ways nothing on screen can show: the copy outlives the mark it duplicates (round 3), it is
    // tagged with the wrong owner (round 3), a second refusal about the SAME field leaves the first
    // copy standing because the field identity never changed (round 6). Each was fixed at its site
    // and the next round found the next one; what closed it was giving the sentence one home.
    expect(SRC).not.toContain("standingRefusal");
    // What the page does keep is what the HOLDER cannot know: which form's write failed, and the name
    // the server used. Neither is a sentence, and neither is read unless the holder has one.
    const start = SRC.indexOf("const [refusedSave, setRefusedSave]");
    expect(start).toBeGreaterThan(-1);
    expect(
      SRC.slice(start, SRC.indexOf("} | null>(null)", start)),
    ).not.toContain("message");
  });

  // THE SECOND CHANNEL, FOR A REFUSAL NO INPUT ON SCREEN IS CARRYING.
  //
  // A toast is the wrong container for it twice over — it takes the only copy of the reason away
  // after five seconds, and it cannot carry the way to the control — so the editor renders it above
  // the tabs, where it stays until the refusal is answered.
  //
  // Source-level because mounting this page pulls auth, theme, toast and a live catalog; the mark
  // reaching a box is proved on the tab that CAN be mounted (pages/GuardrailsTab.test.tsx).
  test("the banner carries every standing refusal, unconditionally", () => {
    const start = SRC.indexOf("const bannerMessage =");
    expect(start).toBeGreaterThan(-1);
    const decl = SRC.slice(start, SRC.indexOf(";", start));
    // No visibility test of any kind. Two earlier versions asked whether the marked control was on
    // screen — first by tab, then by tab plus each section's switch — and each one missed a way a
    // control can be hidden that lives inside the tab components: a guardrails field turned off by
    // its own action, a native-tool note in a collapsed card. Every miss reads as a failed save with
    // nothing on screen saying so, and the list is not this file's to close.
    expect(decl).toContain("refusal.message");
    expect(decl).not.toContain("drawn");
    expect(decl).not.toContain("tab ===");
    // A PLACED mark is still asked for through `at`, which is what makes it expire with the value.
    expect(decl).toContain("heldMessage");

    // The jump is the part that is conditional, and only on there being somewhere to send anyone.
    const target = SRC.slice(
      SRC.indexOf("const bannerTarget ="),
      SRC.indexOf(";", SRC.indexOf("const bannerTarget =")),
    );
    expect(target).toContain("heldTarget.tab !== tab");

    const banner = SRC.slice(SRC.indexOf("{bannerMessage && ("));
    const body = banner.slice(0, banner.indexOf("\n            )}"));
    expect(body).toContain("{bannerMessage}");
    expect(body).toContain("goToEditorTarget(bannerTarget)");
    // And it says WHY when it offers no way: `toolGuidance` takes a note for thirteen native tools
    // and the console draws three, so a refusal about one of the other ten is about a value no
    // screen here edits. The server's sentence names the field and cannot know that.
    expect(body).toContain("bannerNoControl");
    const noControl = SRC.slice(
      SRC.indexOf("const bannerNoControl ="),
      SRC.indexOf(";", SRC.indexOf("const bannerNoControl =")),
    );
    expect(noControl).toContain("editorTargetFor");
    // Never for a refusal about no input at all, where there is no value to go and change.
    expect(noControl).toContain("refusedSave?.named != null");
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
    expect(body).toContain("refusal.capture(");
    // The holder keeps the sentence; the page records only which save failed and what it named.
    expect(body).toContain("setRefusedSave");
    expect(body).not.toContain("editorTargetFor");
    // This page does not toast a save refusal any more — the banner is the one container, and it
    // stays put while the input is still refused.
    expect(body).not.toContain("showToast");
  });

  test("the banner is brought into view, once per sentence", () => {
    // It sits above the tabs and the button that produced it does not: Behavior and Tools are long
    // and their Save lives in a sticky bar at the bottom. Dropping the toast (round 2) took away the
    // thing that answered from down there, so without this a sighted operator watches the save stop
    // and sees nothing. `role="alert"` covers the screen reader; this is the other half.
    const start = SRC.indexOf("const bannerRef =");
    expect(start).toBeGreaterThan(-1);
    const effect = SRC.slice(start, SRC.indexOf("}, [bannerMessage]);", start));
    expect(effect).toContain("scrollIntoView");
    // Once per SENTENCE. The banner stays up until the refusal is answered, so re-scrolling on every
    // render would take the page out from under whoever is fixing the value.
    expect(effect).toContain("announcedRef.current === bannerMessage");
    expect(SRC).toContain("ref={bannerRef}");
  });

  test("every mark is read from the one place that holds its value", () => {
    // `at` compares what it is handed against the value the mark was placed on, and that value came
    // from `currentRef`. A reading that re-derives it from the state variable states the same fact a
    // second time, and round 7 proved they drift: `currentRef` learned to normalize the way the wire
    // does and the readings kept passing raw, so a refused follow-up note with surrounding
    // whitespace matched nothing and the step got no inline error.
    // Balanced, because one reading nests a call of its own (`followUpStepField(i)`) and a lazy
    // regex would stop at the first `)` and read half of it.
    const readings: string[] = [];
    for (const m of SRC.matchAll(/refusal\.at\(/g)) {
      let i = (m.index as number) + m[0].length;
      let depth = 1;
      const from = i;
      while (i < SRC.length && depth > 0) {
        const c = SRC[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        i++;
      }
      readings.push(
        SRC.slice(from, i - 1)
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
    expect(readings.length).toBeGreaterThan(20);
    for (const call of readings) {
      expect(call, call).toContain("currentRef.current[");
    }
  });

  test("what the boxes hold is normalized the way the wire is", () => {
    // `sent` is read off the patch and `current` off this map, so a value the patch trims and the map
    // keeps raw reads as "edited while the request was out" — and the refusal lands in the banner
    // instead of on the textarea it is about, over nothing but surrounding whitespace.
    const start = SRC.indexOf("currentRef.current = {");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf("\n  };", start));
    for (const [field, writer] of [
      ["availability.awayMessage", "awayMessage.trim()"],
      ["contactAuth.denyMessage", "contactAuth.denyMessage.trim()"],
      // Through the writer itself rather than a second spelling of what it does.
      ["followUp", "followUpToStored(followUp)"],
      ["vision.extractionPrompt", "DEFAULT_EXTRACTION_PROMPT"],
    ] as const) {
      expect(body, field).toContain(writer);
    }
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
