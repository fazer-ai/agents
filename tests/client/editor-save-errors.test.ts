import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { firstRefusalAt, settlesRefusal } from "@/client/lib/fieldRefusal";

// The server refuses a write whose settings text is over a cap, and the refusal is only actionable
// because it names the field, the length and the limit: a handler that shows its own generic toast
// leaves the operator with "could not save" and nothing to shorten.
// Checked on the source because rendering the editor pulls auth, theme, toast and a live catalog,
// and the toast text these handlers produce is the whole subject. lib/apiError.test.ts proves the
// extraction itself; this proves every save uses it.
const SRC = readFileSync("src/client/pages/agents/AgentEditorPage.tsx", "utf8");

// Slicing the source, with the anchor proved to exist. `String.indexOf` answers -1 for a missing
// anchor, and -1 is a legal argument to `slice` ("one character from the end"), so a missing END
// anchor runs the span to the end of the FILE and every assertion passes on unrelated code. A rename
// is all it takes, which is why the guard cannot be "remember to check".
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
  // NOTE: `saveAgent` writes BOTH sections and the held refusal covers one of them. A successful Behavior
  // save carries neither `name` nor `systemPrompt`, so clearing there answers a refusal nothing
  // answered: the operator returns to General to a form that looks clean and is still refused.
  // Source-level: the two sections are two arguments to one function, invisible to the network.
  test("a section is settled by one rule, whether it saved or discarded", () => {
    // NOTE: both answer the same thing (the values that section owns are no longer in dispute), so
    // they share one rule. Requiring the write to have carried the refused VALUE would be false
    // exactly when the operator did what the refusal asked, leaving a stale hold that comes back.
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
    // NOTE: a refusal the holder could place nowhere is about a SAVE, so its own section answers it.
    // With one holder per writing form, `owner` is the loop's holder and `settled` is the form that
    // just settled.
    expect(body).toContain("owner,");
    expect(body).toContain("settled: section,");
    // NOTE: and it reaches ALL of them: a refusal does not stay inside the section that produced it,
    // so a Behavior save refused about a Guardrails path is answered by saving GUARDRAILS while the
    // mark sits in the Behavior holder. Settling only the saving form's own holder would leave it
    // standing on a value the server has since accepted.
    expect(body).toContain("for (const owner of REFUSAL_SECTIONS)");
    // Through refs, never the closure: a save handler closes over the render that launched it, and
    // this page's saves are long enough for another tab's save to fail while one is in flight.
    expect(body).toContain("refusalRef.current");
    expect(body).not.toContain("refusal.field");

    // NOTE: every settling path goes through it: six saves and six discards. `channelRedirect`
    // appears twice: it settles on its own successful save and on its discard.
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
    // NOTE: discard-all settles every section at once: six holders.
    // Whitespace-insensitive: the formatter breaks this across lines once the body grows, and a
    // guard pinned to one spelling of it would go red on a reformat that changed nothing.
    expect(SRC.replace(/\s+/g, " ")).toContain(
      "for (const owner of REFUSAL_SECTIONS) refusalRef.current[owner]?.clear();",
    );
  });

  test("the page keeps no copy of the sentence", () => {
    // NOTE: the sentence has one home, the holder. A page that also stores it beside the holder has
    // two sources of truth that drift invisibly: the copy outlives the mark, carries the wrong owner,
    // or survives a second refusal about the same field.
    expect(SRC).not.toContain("standingRefusal");
    // What the page does keep is what the HOLDER cannot know: which form's write failed, and the name
    // the server used. Neither is a sentence, and neither is read unless the holder has one.
    expect(
      between(SRC, "const [refusedSave, setRefusedSave]", ">({});"),
    ).not.toContain("message");
    // NOTE: keyed by section, because a single record would let the second refused save erase what
    // the first had to say about a different form.
    expect(SRC).toContain(
      "Partial<Record<RefusalSection, { named: string | null } | null>>",
    );
  });

  // NOTE: the second channel, for a refusal no input on screen is carrying. A toast is wrong for it twice
  // over (it takes the only copy of the reason away after five seconds, and cannot carry the way to
  // the control), so the editor renders it above the tabs until the refusal is answered.
  // Source-level because mounting this page pulls auth, theme, toast and a live catalog; the mark
  // reaching a box is proved on a tab that CAN be mounted (pages/GuardrailsTab.test.tsx).
  test("the banner carries every standing refusal, unconditionally", () => {
    const decl = between(SRC, "const refusalRows =", "\n  });");
    // NOTE: no visibility test of any kind: a control can be hidden in ways that live inside the tab
    // components (a guardrails field switched off, a native-tool note in a collapsed card), and
    // every miss would read as a failed save with nothing on screen.
    expect(decl).toContain("holder.message");
    expect(decl).not.toContain("drawn");
    // A PLACED mark is still asked for through `at`, which is what makes it expire with the value.
    expect(decl).toContain("holder.at(held");
    // NOTE: EVERY holder, not the newest: two forms can each be refused about something different,
    // and a banner showing one of them would erase the other.
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
    // NOTE: it says WHY when it offers no way: `toolGuidance` takes a note for thirteen native tools
    // and the console draws three, so a refusal about one of the other ten is about a value no
    // screen here edits. The server's sentence names the field and cannot know that.
    expect(body).toContain("entry.noControl");
    // NOTE: said only where it can be PROVED, never read off the map having no entry: absence proves
    // nothing (a missing map entry can sit beside a visible control), and a wrong "API only" tells
    // the operator the opposite of the truth. Never for a refusal about no input at all.
    expect(decl).toContain("hasNoConsoleControl(named)");
    expect(decl).toContain("!held && named != null");
  });

  test("nothing the holder hands back is dropped", () => {
    // NOTE: routed on what the hook did with the refusal, not on `editorTargetFor(named)`: a mapped
    // name can still fail to be placed (the value was edited during the request, the follow-up step
    // no longer exists), and routing on the name would then drop the sentence with no mark to show.
    const body = between(SRC, "function answerRefusal", "\n  }");
    // NOTE: the holder of the form that WROTE: one page-wide holder would let the second refused save
    // overwrite the first. Indexed at the call site rather than through a local, which lets the
    // fence in field-refusal-fence.test.ts prove every declared holder is reachable.
    expect(body).toContain("refusals[section].capture(");
    // The holder keeps the sentence; the page records only which save failed and what it named.
    expect(body).toContain("setRefusedSave");
    expect(body).not.toContain("editorTargetFor");
    // NOTE: this page does not toast a save refusal: the banner is the one container, and it stays
    // put while the input is still refused.
    expect(body).not.toContain("showToast");
  });

  test("the banner is brought into view, once per sentence", () => {
    // NOTE: it sits above the tabs and the button that produced it does not: Behavior and Tools are
    // long and their Save lives in a sticky bar at the bottom, so without the scroll a sighted
    // operator sees nothing answer. `role="alert"` covers the screen reader; this is the other half.
    const effect = between(
      SRC,
      "const bannerRef =",
      "}, [hasRefusalRow, refusalSeq]);",
    );
    expect(effect).toContain("scrollIntoView");
    // NOTE: once per ANSWERED REQUEST, counted rather than compared by text. The banner stays up until the
    // refusal is answered, so re-scrolling every render would take the page out from under whoever is
    // fixing the value, and keying on the sentence would make a second identical transport failure
    // look like it did not happen.
    expect(effect).toContain("announcedRef.current === refusalSeq");
    expect(SRC).toContain("setRefusalSeq((n) => n + 1)");
    expect(SRC).toContain("ref={bannerRef}");
  });

  test("every mark is read from the one place that holds its value", () => {
    // NOTE: `at` compares against the value the mark was placed on, which came from `currentRef`
    // (normalized the way the wire is). A reading that re-derives it from the state variable would
    // drift from it, e.g. surrounding whitespace would match nothing and lose the inline error.
    // Balanced, because one reading nests a call (`followUpStepField(i)`) and a lazy regex would stop
    // at the first `)`.
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
    // NOTE: `sent` is read off the patch and `current` off this map, so a value the patch trims and the map
    // keeps raw reads as "edited while the request was out", and the refusal lands in the banner
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
      ["toolGuidance.set_labels", "labelInstructions.trim()"],
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

  test("the protected-label ceiling is checked BEFORE the grants PUT", () => {
    // NOTE: the grants PUT goes first, so a PATCH refused for an over-ceiling guard would leave
    // `set_labels` enabled with the protection the operator typed not stored: the tool armed and
    // the fence missing, the one ordering that must not happen.
    const save = after(SRC, "async function saveTools");
    const putAt = save.indexOf('["tool-selections"].put(');
    expect(putAt).toBeGreaterThan(-1);
    const before = save.slice(0, putAt);
    expect(before).toContain("protectedLabelsError(");
    // And it compares against the stored list, so a legacy over-ceiling value does not block a save
    // that never touched it.
    expect(between(SRC, "function protectedLabelsError", "\n  }")).toContain(
      "PROTECTED_LABELS_MAX",
    );
    expect(between(SRC, "function protectedLabelsError", "\n  }")).toContain(
      "stored",
    );
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
    // NOTE: the holder is often under a qualified name (`cloneRefusal`), because a page with two forms needs
    // one per form. `refusal.capture` answers the server's sentence, or null once it is already
    // rendered at the input it names: routing through it still shows what the server said.
    // Followed through a NAME, because the routing is written once (`answerRefusal` captures and
    // picks banner or toast) and called from each save; asking for the literal `refusal.capture`
    // inside every handler would demand the duplication the helper removes.
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

// One refusal per form that writes. The editor has six independently savable forms, and `capture`
// is also the clear, so a single holder would lose the Behavior refusal when Guardrails is refused
// next, leaving a form that looks clean and is still refused.
// Source-level for the same reason the rest of this file is: mounting this page pulls auth, theme,
// toast and a live catalog. Asserted is the SHAPE that makes the erasure impossible.
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
    // NOTE: behaviour, not shape: a source check on the loop's text survives narrowing the loop to
    // its first entry. The rule lives in `firstRefusalAt` and is asked to answer.
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
    // NOTE: the half the per-form split does not get for free: `clearRefusalFor` keeps its section
    // argument, because the holder is not the section. A Behavior save refused about a Guardrails
    // path is fixed on Guardrails and saved THERE, while the mark sits in the Behavior holder.
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
    // NOTE: `saveChannelRedirect` writes the whole settings bag, so its catch routes the refusal
    // like every other save: a bare toast would leave a value this editor draws with no mark and
    // nothing to jump to.
    const body = between(SRC, "async function saveChannelRedirect", "\n  }");
    expect(body).toContain("answerRefusal(");
    expect(body).toContain('"channelRedirect"');
    expect(body).toContain('settleRefusalFor("channelRedirect")');
    // Snapshotted before the request goes out, never read from the live ref in the catch: comparing
    // `currentRef` with itself there can never fire the staleness check.
    expect(body).toContain("sent = sentFor(patch)");
    // NOTE: and it is not a toast, which takes the only copy of the reason away after five seconds
    // while the input is still refused. Asserted against what the catch actually READS, so a toast
    // reintroduced beside `answerRefusal` fails here.
    const cr = between(SRC, "async function saveChannelRedirect", "\n  }");
    const catchBody = cr.slice(cr.indexOf("} catch ("));
    expect(catchBody).not.toContain("apiErrorMessage(");
    expect(catchBody).not.toContain("showToast(");
  });
});
