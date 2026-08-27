import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { firstRefusalAt, settlesRefusal } from "@/client/lib/fieldRefusal";

// The server refuses a write whose settings text is over a cap, and the refusal is only actionable
// because it names the field, the length and the limit — a handler that swallows it and shows its
// own generic toast leaves the operator with "could not save" and nothing to shorten. That is how
// the clone path shipped: the assertion was added on the server and the button kept its own message.
//
// Checked on the source because rendering the editor pulls auth, theme, toast and a live catalog,
// and the toast text these handlers produce is the whole subject. apiErrorMessage.test.ts proves the
// extraction itself; this proves nobody writes a new save that forgets to use it.
const SRC = readFileSync("src/client/pages/agents/AgentEditorPage.tsx", "utf8");

// SLICING THE SOURCE, WITH THE ANCHOR PROVED TO EXIST.
//
// `String.indexOf` answers -1 for something that is not there, and -1 is a legal argument to
// `slice`: it silently means "one character from the end", and a `slice(start, -1)` where the END
// anchor is missing runs to the end of the FILE. Every assertion made against that span then passes
// on some unrelated code further down, which is a fence that reports green while guarding nothing.
//
// Round 1 of review on #425 found exactly that: this file looked for `hasRefusalRow` while the page
// declared `hasStandingRefusal`, so the "banner is brought into view" span covered most of the
// remainder of the file and would have been satisfied by any later `scrollIntoView`. A rename is all
// it takes, which is why the guard cannot be "remember to check".
function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start + from.length);
  expect(end, `closing anchor not found after ${from}: ${to}`).toBeGreaterThan(
    -1,
  );
  return src.slice(start, end);
}

// The same proof for a span that runs to the end of what it opens.
function after(src: string, from: string): string {
  const start = src.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  return src.slice(start);
}

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
  test("a section is settled by one rule, whether it saved or discarded", () => {
    // Both answer the same thing — the values that section owns are no longer in dispute — and
    // written twice they drifted at once: the save half required the write to have carried the
    // refused VALUE, which is false exactly when the operator has done what the refusal asked, so a
    // corrected save left the stale hold in place and the mark came back the next time they typed
    // the old value.
    expect(SRC).not.toContain("clearRefusalFor");
    expect(SRC).not.toContain("discardRefusalFor");
    const body = between(SRC, "function settleRefusalFor", "\n  }");

    // By the tab that DRAWS the value, not by what the request serialized: a Behavior save spreads
    // the last-synced `settings`, so it carries `guardrails.customPolicy` holding what is STORED
    // rather than the edit the Guardrails tab still has unsaved. The rule itself is `settlesRefusal`
    // and is tested by behaviour below; what is asked here is that this is the function used.
    expect(body).toContain("settlesRefusal({");
    expect(body).toContain("drawnBy: held ? (target?.tab ?? null) : null");
    expect(body).not.toContain("Object.hasOwn(sent");
    // A refusal the holder could place nowhere is about a SAVE, so its own section answers it. With
    // one holder per writing form (#415) "its own section" is the holder being visited, not a single
    // page-level record: `owner` is the loop's holder and `settled` is the form that just settled.
    expect(body).toContain("owner,");
    expect(body).toContain("settled: section,");
    // And it reaches ALL of them, which is the half the per-form split does not get for free. A
    // refusal does not stay inside the section that produced it, so a Behavior save refused about a
    // Guardrails path is answered by saving GUARDRAILS, and that mark is sitting in the Behavior
    // holder. Settling only the saving form's own holder would leave it standing on a value the
    // server has since accepted.
    expect(body).toContain("for (const owner of REFUSAL_SECTIONS)");
    // Through refs, never the closure: a save handler closes over the render that launched it, and
    // this page's saves are long enough for another tab's save to fail while one is in flight.
    expect(body).toContain("refusalRef.current");
    expect(body).not.toContain("refusal.field");

    // Every settling path goes through it: six saves and six discards. `channelRedirect` appears
    // twice since #415: it settles on its own successful save now, where before only its discard
    // did, because it did not take part in the refusal mechanism at all.
    const settled = [
      ...SRC.matchAll(/(?<!function )settleRefusalFor\(([^)]*)\)/g),
    ].map((m) => (m[1] as string).replace(/"/g, ""));
    expect(settled.sort()).toEqual([
      "behavior",
      "channelRedirect",
      "channelRedirect",
      "general",
      "guardrails",
      "guardrails",
      "knowledge",
      "knowledge",
      "section",
      "tools",
      "tools",
    ]);
    // Discard-all settles every section at once, which is now six holders rather than one.
    // Whitespace-insensitive: the formatter breaks this across lines once the body grows, and a
    // guard pinned to one spelling of it would go red on a reformat that changed nothing.
    expect(SRC.replace(/\s+/g, " ")).toContain(
      "for (const owner of REFUSAL_SECTIONS) refusalRef.current[owner]?.clear();",
    );
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
    expect(
      between(SRC, "const [refusedSave, setRefusedSave]", ">({});"),
    ).not.toContain("message");
    // Keyed by section since #415, because a single record meant the second refused save erased what
    // the first had to say about a different form.
    expect(SRC).toContain(
      "Partial<Record<RefusalSection, { named: string | null } | null>>",
    );
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
    const decl = between(SRC, "const refusalRows =", "\n  });");
    // No visibility test of any kind. Two earlier versions asked whether the marked control was on
    // screen — first by tab, then by tab plus each section's switch — and each one missed a way a
    // control can be hidden that lives inside the tab components: a guardrails field turned off by
    // its own action, a native-tool note in a collapsed card. Every miss reads as a failed save with
    // nothing on screen saying so, and the list is not this file's to close.
    expect(decl).toContain("holder.message");
    expect(decl).not.toContain("drawn");
    // A PLACED mark is still asked for through `at`, which is what makes it expire with the value.
    expect(decl).toContain("holder.at(held");
    // EVERY holder, not the newest: two forms can each be refused about something different, and a
    // banner that showed one of them would be the erasure #415 is about, moved into the render.
    expect(decl).toContain("REFUSAL_SECTIONS.flatMap");

    // The jump is the part that is conditional, and only on there being somewhere to send anyone.
    expect(decl).toContain("target.tab !== tab");
    // From the mark when there is one and from the name the server used when there is not: a refusal
    // this editor cannot MARK can still be about a value it draws, and a tool precondition is edited
    // as a list so there is no single box to put the sentence in.
    expect(decl).toContain("editorTargetFor(named");

    const body = between(
      SRC,
      "{refusalRows.length > 0 && (",
      "\n            )}",
    );
    expect(body).toContain("{entry.message}");
    expect(body).toContain("goToEditorTarget(entry.target)");
    // And it says WHY when it offers no way: `toolGuidance` takes a note for thirteen native tools
    // and the console draws three, so a refusal about one of the other ten is about a value no
    // screen here edits. The server's sentence names the field and cannot know that.
    expect(body).toContain("entry.noControl");
    // Said only where it can be PROVED, never read off the map having no entry: absence proves
    // nothing about the console, and the map WAS missing `settings.modelFallback.model` and
    // `observability.fullDetailUntil`, both of which have a visible control. The banner told the
    // operator the opposite of the truth about them. Never for a refusal about no input at all,
    // where there is no value to go and change.
    expect(decl).toContain("hasNoConsoleControl(named)");
    expect(decl).toContain("!held && named != null");
  });

  test("nothing the holder hands back is dropped", () => {
    // The first version routed on `editorTargetFor(named)` — whether the refused NAME has a place in
    // this editor — and swallowed the sentence when it did. That reads the field instead of what the
    // hook did with it, and the two come apart: a mapped name can still fail to be placed (the value
    // was edited during the request, the follow-up step no longer exists), and then the sentence went
    // nowhere and no mark existed to render it. A save that fails in silence.
    const body = between(SRC, "function answerRefusal", "\n  }");
    // The holder of the form that WROTE, which is the whole of #415: one page-wide holder meant the
    // second refused save overwrote the first. Indexed at the call site rather than through a local,
    // which is what lets the fence in field-refusal-fence.test.ts prove every declared holder is
    // reachable, the same move that made the wait checkable in #419.
    expect(body).toContain("refusals[section].capture(");
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
    const effect = between(
      SRC,
      "const bannerRef =",
      "}, [hasRefusalRow, refusalSeq]);",
    );
    expect(effect).toContain("scrollIntoView");
    // Once per ANSWERED REQUEST, counted rather than compared by text. The banner stays up until the
    // refusal is answered, so re-scrolling every render would take the page out from under whoever is
    // fixing the value — but keying on the sentence made two transport failures in a row, which say
    // the same thing, announce once: the second looked like it did not happen.
    expect(effect).toContain("announcedRef.current === refusalSeq");
    expect(SRC).toContain("setRefusalSeq((n) => n + 1)");
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
    const body = between(SRC, "currentRef.current = {", "\n  };");
    for (const [field, writer] of [
      ["availability.awayMessage", "awayMessage.trim()"],
      ["contactAuth.denyMessage", "contactAuth.denyMessage.trim()"],
      // Through the writer itself rather than a second spelling of what it does.
      ["followUp", "followUpToStored(followUp)"],
      ["vision.extractionPrompt", "DEFAULT_EXTRACTION_PROMPT"],
      ["handoff.instructions", "serializeHandoff(handoff).instructions"],
      ["kanban.instructions", "kanbanInstructions.trim()"],
      ["toolGuidance.assign_label", "labelInstructions.trim()"],
    ] as const) {
      expect(body, field).toContain(writer);
    }
  });

  test("the tools preflight compares against the stored bag, re-read when forced", () => {
    expect(between(SRC, "function settingsTextError", "\n  }")).toContain(
      "collectOversizedTextChanges",
    );
    // A forced overwrite follows a 409, so the synced bag is stale by definition: comparing against
    // it can pass a check the PATCH then fails, with the grants PUT already persisted.
    const save = after(SRC, "async function saveTools");
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
      .filter((h) =>
        /apiErrorMessage|[Rr]efusal(?:s\[section\])?\.capture/.test(h.body),
      )
      .map((h) => h.name);
    // Guards this half of the parser the same way the list above guards the other: a helper that
    // stops reading the server's message would empty this list and pass every handler below.
    expect(routers).toContain("answerRefusal");
    const shows = new RegExp(
      `apiErrorMessage|[Rr]efusal(?:s\\[section\\])?\\.capture|\\b(?:${routers.join("|")})\\(`,
    );
    expect(
      writers.filter((h) => !shows.test(h.body)).map((h) => h.name),
    ).toEqual([]);
  });
});

// ONE REFUSAL PER FORM THAT WRITES (#415).
//
// The editor has six independently savable forms and had ONE holder, and `capture` is also the
// clear. Refuse a Behavior save, switch to Guardrails, refuse that one, and the first sentence is
// gone: the operator comes back to a Behavior form that looks clean and is still refused. No
// concurrency needed for it, though the tabs do stay live during a save.
//
// Source-level for the same reason the rest of this file is: mounting this page pulls auth, theme,
// toast and a live catalog. What is asserted here is the SHAPE that makes the erasure impossible,
// not a rendering of it.
describe("one refusal per form that writes", () => {
  test("every writing form has its own holder, and they share the field lists", () => {
    const holders = [
      ...SRC.matchAll(/const (\w+Refusal) = useFieldRefusal\(/g),
    ].map((m) => m[1]);
    // The clone dialog is a form too and keeps its own, which is the same rule and not this list.
    expect(holders).toEqual([
      "generalRefusal",
      "behaviorRefusal",
      "knowledgeRefusal",
      "toolsRefusal",
      "guardrailsRefusal",
      "channelRedirectRefusal",
      "cloneRefusal",
    ]);
    // The SAME drawn/owned lists, because a refusal does not stay inside the section that produced
    // it: `saveAgent("behavior")` sends the whole settings bag and can be refused about
    // `guardrails.output.templateMessage`, whose control the Guardrails tab draws. Per-section lists
    // would leave a holder unable to place the refusal its own save provoked.
    const shared = [
      ...SRC.matchAll(
        /useFieldRefusal\(\s*refusalFields\.drawn,\s*refusalFields\.owned,?\s*\)/g,
      ),
    ];
    expect(shared).toHaveLength(6);
  });

  test("the section a refusal is filed under is the form that wrote, not the tab it lands on", () => {
    // Typed rather than loose strings: a section name matching no holder would be a holder nothing
    // ever captures into, which is silent.
    const decl = between(SRC, "type RefusalSection =", ";");
    for (const section of [
      "general",
      "behavior",
      "knowledge",
      "tools",
      "guardrails",
      "channelRedirect",
    ]) {
      expect(decl).toContain(`"${section}"`);
    }
  });

  test("every holder is asked before a control is left unmarked", () => {
    // Behaviour, not shape. This was a source check for the text of the loop, and the mutation
    // battery walked straight through it: narrowing the loop to its first entry leaves that text in
    // place, so the guard stayed green while five of the six holders went unread. The rule lives in
    // `firstRefusalAt` now and is asked to answer.
    const silent = () => null;
    const says = (what: string) => () => what;
    expect(
      firstRefusalAt([silent, silent, says("from the sixth")], "f", 1),
    ).toBe("from the sixth");
    // First match wins: one control draws one value, so the older sentence is the one already shown.
    expect(firstRefusalAt([says("first"), says("second")], "f", 1)).toBe(
      "first",
    );
    expect(firstRefusalAt([silent, silent], "f", 1)).toBeNull();
    expect(firstRefusalAt([], "f", 1)).toBeNull();
    // And the page hands it every holder rather than a slice of them.
    expect(SRC).toContain(
      "REFUSAL_SECTIONS.map((section) => refusals[section].at)",
    );
  });

  test("a refusal is settled by the tab that draws it, whichever form wrote it", () => {
    // The half the per-form split does not get for free, and the one the issue's plan would have
    // got wrong: it proposed that `clearRefusalFor` lose its section argument because "the holder IS
    // the section". Measured against this case, that drops a mark the server has already accepted.
    //
    // Behavior save refused about a Guardrails path: the operator fixes it on Guardrails and saves
    // THERE, and the mark is sitting in the Behavior holder.
    expect(
      settlesRefusal({
        drawnBy: "guardrails",
        owner: "behavior",
        settled: "guardrails",
      }),
    ).toBe(true);
    // Saving Behavior again does NOT settle it: the value belongs to the Guardrails tab, and a
    // Behavior save spreads the last-synced settings rather than the edit still unsaved there.
    expect(
      settlesRefusal({
        drawnBy: "guardrails",
        owner: "behavior",
        settled: "behavior",
      }),
    ).toBe(false);
    // A refusal the holder could place nowhere is about a SAVE rather than a value, so its own
    // section answers it, and nobody else's does.
    expect(
      settlesRefusal({ drawnBy: null, owner: "tools", settled: "tools" }),
    ).toBe(true);
    expect(
      settlesRefusal({ drawnBy: null, owner: "tools", settled: "general" }),
    ).toBe(false);
  });

  test("the form that only toasted its refusal now answers like the others", () => {
    // `saveChannelRedirect` writes the whole settings bag and its catch showed a bare toast, so a
    // refusal naming a value this editor draws came back with no mark and nothing to jump to. That
    // is the defect #349 fixed, at the one form #349 did not reach.
    const body = between(SRC, "async function saveChannelRedirect", "\n  }");
    expect(body).toContain("answerRefusal(");
    expect(body).toContain('"channelRedirect"');
    expect(body).toContain('settleRefusalFor("channelRedirect")');
    // Snapshotted before the request goes out, never read from the live ref in the catch: comparing
    // `currentRef` with itself there can never fire the staleness check.
    expect(body).toContain("sent = sentFor(patch)");
    // And it stops being a toast, which is the container that takes the only copy of the reason away
    // after five seconds while the input it is about is still refused. Asserted against what the
    // catch actually READS rather than against a spelling of the old call: round 1 of review caught
    // the first version pinning a formatting that never existed, so reintroducing the toast beside
    // `answerRefusal` would have left this green and reported the failure twice.
    const cr = between(SRC, "async function saveChannelRedirect", "\n  }");
    const catchBody = cr.slice(cr.indexOf("} catch ("));
    expect(catchBody).not.toContain("apiErrorMessage(");
    expect(catchBody).not.toContain("showToast(");
  });
});
