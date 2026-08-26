import { describe, expect, test } from "bun:test";
import { debugModesFrom } from "@/modules/flowlog/debug-mode";
import {
  FULL_DETAIL_ARM_HOURS,
  FULL_DETAIL_MAX_HOURS,
  isFullDetailWindowOpen,
  readObservabilityConfig,
} from "@/modules/flowlog/settings";

// TWO facts about the console's "recording more than the default" warning that no type can hold,
// and both were review findings rather than guesses.
//
// 1. It must read what the SERVER is doing, not what the form is about to ask it to do. Driven by
//    the form, flipping the tool-values switch off makes the warning disappear on the touch — while
//    the server is still storing the customer's PII, and an operator who leaves without saving takes
//    that answer with them. The opposite is a false positive on a switch just turned on.
// 2. It must go through the shared derivation rather than spell the same `||` out again. A switch
//    added to `readDebugModes` would light the indicator everywhere except in a copy, and a copy in
//    a `.tsx` is invisible to every test that covers that module.
//
// Both are properties of the SOURCE, so the source is what is read. The alternative — rendering the
// component — would cover (1) and could not see (2) at all.

const SOURCE = await Bun.file(
  new URL("../../src/client/pages/agents/BehaviorTab.tsx", import.meta.url),
).text();

const EDITOR_SOURCE = await Bun.file(
  new URL("../../src/client/pages/agents/AgentEditorPage.tsx", import.meta.url),
).text();

// The memo, from its opening to the end of its dependency array.
function warningMemo(source: string): string {
  const at = source.indexOf("const debugModesOn = useMemo(");
  if (at === -1) return "";
  const end = source.indexOf("]);", at);
  return end === -1 ? "" : source.slice(at, end + 3);
}

describe("the debug warning reads the server's state, through the shared derivation", () => {
  const memo = warningMemo(SOURCE);

  // The control for every assertion below: they all pass vacuously against an empty string.
  test("the memo is still there to read", () => {
    expect(memo.length).toBeGreaterThan(100);
    expect(memo).toContain("debugModesOn");
  });

  test("it reads the saved config and not the form", () => {
    expect(memo).toContain("savedObservability");
    // `observability` is the form state, and it is a SUBSTRING of `savedObservability`, so the
    // check has to be for the bare identifier — matched by a word boundary that a preceding
    // `saved` defeats.
    expect(/(?<![A-Za-z])observability\b/.test(memo)).toBe(false);
  });

  test("it calls the shared derivation", () => {
    expect(memo).toContain("debugModesFrom(");
  });

  // The copy this fence exists to prevent, in miniature: the warning must not test the individual
  // switches to decide whether ANYTHING is on. Reading the fields to build the LIST is fine — that
  // is labelling, not deciding — so what is forbidden is a second condition over the raw config.
  test("it does not re-derive the condition from the raw inputs", () => {
    expect(memo).not.toContain("savedObservability.logToolValues");
    expect(memo).not.toContain("savedObservability.fullDetail");
    // The tenant flag as a BARE identifier appears exactly twice, and both are structural: once as
    // the argument to the derivation, once in the dependency array. A third would be a label branch
    // reading the raw prop instead of the derivation's own field, which is the copy again. Matched
    // bare on purpose — `m.langfuseSendContent` is the derivation's field and is the correct read.
    expect(
      memo.match(/(?<![.A-Za-z])langfuseSendContent\b/g)?.length ?? 0,
    ).toBe(2);
    // Every label branch reads a field of the derivation's result.
    expect(memo.split("if (m.").length - 1).toBe(3);
  });

  // And the derivation it delegates to answers the way the warning needs, for each switch alone.
  test("the derivation lights on any one switch", () => {
    const off = readObservabilityConfig({});
    const values = readObservabilityConfig({
      observability: { logToolValues: true },
    });
    const armed = readObservabilityConfig({
      observability: {
        fullDetailUntil: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(debugModesFrom(off, false).any).toBe(false);
    expect(debugModesFrom(values, false).any).toBe(true);
    expect(debugModesFrom(armed, false).any).toBe(true);
    expect(debugModesFrom(off, true).any).toBe(true);
  });
});

// Two more properties of the warning, both review findings, both about a state that changes with
// nothing being clicked.
describe("the warning stops claiming the mode is on once the window closes", () => {
  const armed = (msAhead: number) =>
    readObservabilityConfig(
      {
        observability: {
          fullDetailUntil: new Date(Date.now() + msAhead).toISOString(),
        },
      },
      new Date(),
    );

  test("an already-read config is re-judged against the instant it is given", () => {
    const cfg = armed(60_000);
    expect(debugModesFrom(cfg, false, new Date()).fullDetail).toBe(true);
    // Same config object, a minute later: the window closed and nothing had to re-read it. This is
    // the editor left open past the deadline.
    expect(
      debugModesFrom(cfg, false, new Date(Date.now() + 120_000)).fullDetail,
    ).toBe(false);
    expect(debugModesFrom(cfg, false, new Date(Date.now() + 120_000)).any).toBe(
      false,
    );
  });

  // The wiring the property above needs, which no type carries: the component has to pass its own
  // ticking instant, and it has to schedule the tick at the deadline.
  test("the component re-judges at a scheduled instant", () => {
    const memo = warningMemo(SOURCE);
    expect(memo).toContain("judgedAt");
    expect(SOURCE).toContain("setJudgedAt(serverNowDate())");
    expect(SOURCE).toContain("savedObservability.fullDetailUntil?.getTime()");
  });
});

// The deadline is computed from the OPERATOR's clock and judged against the SERVER's. Arming for
// exactly the maximum makes any forward skew push the value past the reader's bound, and the reader
// then refuses it silently — a switch that turns on in the browser and arms nothing.
describe("the console arms for less than the ceiling, and the gap is the skew it tolerates", () => {
  test("the armed window is strictly shorter than the bound", () => {
    expect(FULL_DETAIL_ARM_HOURS).toBeLessThan(FULL_DETAIL_MAX_HOURS);
    expect(FULL_DETAIL_ARM_HOURS).toBeGreaterThan(0);
  });

  test("a browser ahead by the whole margin still arms", () => {
    const skew = (FULL_DETAIL_MAX_HOURS - FULL_DETAIL_ARM_HOURS) * 3_600_000;
    const serverNow = new Date();
    // What the console stores, computed on a clock that is ahead by the margin.
    const armed = new Date(
      serverNow.getTime() + skew + FULL_DETAIL_ARM_HOURS * 3_600_000,
    ).toISOString();
    expect(
      readObservabilityConfig(
        { observability: { fullDetailUntil: armed } },
        serverNow,
      ).fullDetail,
    ).toBe(true);
  });

  test("arming for the ceiling itself would not survive any forward skew", () => {
    const serverNow = new Date();
    const armed = new Date(
      serverNow.getTime() + 1000 + FULL_DETAIL_MAX_HOURS * 3_600_000,
    ).toISOString();
    expect(
      readObservabilityConfig(
        { observability: { fullDetailUntil: armed } },
        serverNow,
      ).fullDetail,
    ).toBe(false);
  });

  test("the component arms with the shorter constant", () => {
    expect(SOURCE).toContain("FULL_DETAIL_ARM_HOURS * 3_600_000");
    expect(SOURCE).not.toContain("FULL_DETAIL_MAX_HOURS");
  });
});

// Two more states that change with nothing being clicked, and both were review findings about the
// SAME frozen instant.
describe("the editor re-judges the window instead of freezing at mount", () => {
  test("a deadline armed later is not measured against a stale instant", () => {
    // The tab was opened this morning; the operator arms the mode this evening. Judged against the
    // mount-time instant, the fresh deadline reads as more than the ceiling ahead — the reader's own
    // far-side bound — and the warning would stay silent for the whole window just armed.
    const mounted = new Date();
    const armedLater = new Date(
      mounted.getTime() + 13 * 3_600_000 + FULL_DETAIL_ARM_HOURS * 3_600_000,
    );
    const cfg = {
      logToolValues: false,
      fullDetail: true,
      fullDetailUntil: armedLater,
    };
    expect(debugModesFrom(cfg, false, mounted).fullDetail).toBe(false);
    // Re-judged at the moment it was armed, it reads as on, which is what the effect below buys.
    const armedAt = new Date(mounted.getTime() + 13 * 3_600_000);
    expect(debugModesFrom(cfg, false, armedAt).fullDetail).toBe(true);
  });

  test("the component refreshes its instant when a deadline changes, not only when one expires", () => {
    // The refresh is keyed on BOTH deadlines. Keyed on nothing (a mount-only effect) it would leave
    // the instant frozen at page load, which is the bug this replaced: the initial state is already
    // `serverNowDate()`, so a mount-only refresh does nothing at all.
    // Anchored at the start of the line, because the failure this guards against is a statement
    // that is still THERE and no longer runs — an `if (…)` in front of it matches any check that
    // starts at the call.
    expect(
      /\n {4}setJudgedAt\(serverNowDate\(\)\);\n {2}\}, \[savedUntilMs, formUntilMs\]\);/.test(
        SOURCE,
      ),
    ).toBe(true);
  });

  test("the scheduler re-runs after each timer, so the later deadline is not lost", () => {
    // It arms the EARLIER of the two deadlines. Without `judgedAt` in its dependencies nothing
    // changes when that timer fires, so the effect never runs again and the later deadline is never
    // scheduled — a form window of 12h under a saved window of 20h would leave the warning standing
    // after the saved one closed.
    expect(SOURCE).toContain("}, [savedUntilMs, formUntilMs, judgedAt]);");
  });

  test("the switch is derived from the deadline, and from the FORM's", () => {
    // Two facts, and they pull in opposite directions. Derived, because frozen at the read the
    // switch stays checked past its own deadline, shows a hint naming a moment that has gone, and
    // needs two clicks to re-arm. And from the FORM's deadline, not the saved one, because the
    // switch is where the operator's not-yet-saved choice lives — reading the saved deadline would
    // make it spring back off the instant they turned it on.
    const at = SOURCE.indexOf("checked={isFullDetailWindowOpen(");
    expect(at).toBeGreaterThan(-1);
    const block = SOURCE.slice(at, at + 200);
    expect(block).toContain("observability.fullDetailUntil");
    expect(/(?<![A-Za-z])savedObservability/.test(block)).toBe(false);
    expect(SOURCE).not.toContain("checked={observability.fullDetail}");
  });

  test("the derivation the switch uses closes the window on time", () => {
    const until = new Date(Date.now() + 60_000);
    expect(isFullDetailWindowOpen(until, new Date())).toBe(true);
    expect(isFullDetailWindowOpen(until, new Date(Date.now() + 120_000))).toBe(
      false,
    );
  });
});

describe("the editor never claims more than it can back up", () => {
  test("the hint is gated on the window, not on the deadline being non-null", () => {
    // An expired deadline is still a `Date`, so a truthiness check leaves "On until <a moment that
    // has gone>. Save to apply." standing under a switch the same timer just unchecked.
    expect(SOURCE).toContain(
      "{isFullDetailWindowOpen(observability.fullDetailUntil, judgedAt)",
    );
    expect(SOURCE).not.toContain("{observability.fullDetailUntil\n");
  });

  test("the tenant read is not awaited with the editor's own load", () => {
    // The warning is allowed to say less when this read fails; it is not allowed to hold the editor
    // open or send it to the page-level error state, which is what sharing the load's `Promise.all`
    // would do with a slow or refused optional request.
    const src = EDITOR_SOURCE;
    const at = src.indexOf("const [agentRes, tsRes, hoursRes");
    expect(at).toBeGreaterThan(-1);
    const load = src.slice(at, src.indexOf("]);", at));
    expect(load).not.toContain("tenant-settings");
    // And it still happens, with its own failure path.
    expect(src).toContain('api.api.v1["tenant-settings"]');
    expect(src).toContain("setLangfuseSendContent(null)");
  });
});

// The deadline is chosen in the browser and enforced by the server, and the two only agree if the
// browser stops reading its own clock for it. This is a property of the SOURCE for the same reason
// the two above are: a `Date.now()` added back into any of these six places would be correct
// TypeScript, would pass every rendering test (the test's clock is the component's clock), and would
// only be wrong on an operator's machine.
const API_SOURCE = await Bun.file(
  new URL("../../src/client/lib/api.ts", import.meta.url),
).text();

describe("the debug window is judged on the server's clock, not the browser's", () => {
  test("no bare clock read is left in the editor", () => {
    // Every clock read in this file belongs to the debug window: the judged instant, the two timer
    // deltas and the armed deadline. `new Date(x)` with an argument is not a clock read.
    expect(SOURCE).not.toContain("Date.now()");
    expect(SOURCE).not.toContain("new Date()");
  });

  test("it reads the offset one, and takes it from `serverClock`", () => {
    expect(SOURCE).toContain(
      'import { serverNow, serverNowDate } from "@/client/lib/serverClock";',
    );
    // The arming site specifically: this is the one whose error is a window of the wrong LENGTH,
    // rather than a warning that stops at the wrong moment.
    expect(SOURCE).toContain(
      "new Date(serverNow() + FULL_DETAIL_ARM_HOURS * 3_600_000)",
    );
  });

  test("the offset is fed by every response, before the status branch", () => {
    // A 401 and a 429 carry the same `Date`, and the page makes plenty of both. Reading the header
    // only on the success path would leave the offset at whatever the last 200 said, which on a
    // freshly opened editor can be nothing at all.
    const at = API_SOURCE.indexOf("onResponse: (response) => {");
    expect(at).toBeGreaterThan(-1);
    const before = API_SOURCE.slice(
      at,
      API_SOURCE.indexOf("if (response.status", at),
    );
    expect(before).toContain("noteServerDate(response);");
  });
});

describe("the editor says which deadline it is talking about", () => {
  test("`Save to apply` is gated on the form deadline differing from the saved one", () => {
    // An armed-and-saved window that still said "Save to apply" contradicted the warning above it —
    // which speaks for the server — and left an operator no way to tell a mode that is RUNNING from
    // one that is merely typed.
    const at = SOURCE.indexOf(
      "{isFullDetailWindowOpen(observability.fullDetailUntil, judgedAt)",
    );
    expect(at).toBeGreaterThan(-1);
    const block = SOURCE.slice(at, at + 700);
    expect(block).toContain("formUntilMs === savedUntilMs");
    expect(block).toContain('t("editor.observabilityFullDetailUntil"');
    expect(block).toContain('t("editor.observabilityFullDetailUntilUnsaved"');
  });

  test("neither sentence promises a save the other one already had", async () => {
    const en = JSON.parse(
      await Bun.file(
        new URL("../../src/client/locales/en.json", import.meta.url),
      ).text(),
    ) as { editor: Record<string, string> };
    expect(en.editor.observabilityFullDetailUntil).not.toContain("save");
    expect(en.editor.observabilityFullDetailUntil).not.toContain("Save");
    expect(en.editor.observabilityFullDetailUntilUnsaved).toContain("save");
    // Both name the moment, because both are answering "until when".
    expect(en.editor.observabilityFullDetailUntil).toContain("{{when}}");
    expect(en.editor.observabilityFullDetailUntilUnsaved).toContain("{{when}}");
  });
});

// The census, because the question is "which reads of the window run in a BROWSER", not "does
// BehaviorTab use the offset". Judging the window in the component was one of two, and the one that
// was missed is the one that PERSISTS: `observabilityToForm` decodes the deadline on load, so a
// window it reads as expired becomes the `null` that the next save of any unrelated Behavior field
// writes back. Every server-side reader is already on the server's clock by construction; a third
// client-side one added later is not, and would be invisible to every test above.
describe("every client-side read of the window is on the server's clock", () => {
  test("there are exactly two, and neither reads the browser's clock", async () => {
    const dir = new URL("../../src/client/", import.meta.url).pathname;
    const files = (
      await Array.fromAsync(
        new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: dir, absolute: true }),
      )
    ).sort();
    const touching: string[] = [];
    for (const f of files) {
      const text = await Bun.file(f).text();
      if (
        /readObservabilityConfig|debugModesFrom|readDebugModes|isFullDetailWindowOpen/.test(
          text,
        )
      ) {
        touching.push(f.slice(dir.length));
        // Same rule for whichever file it is: the instant has to come from `serverClock`.
        expect(text).not.toContain("Date.now()");
        expect(text).not.toContain("new Date()");
        expect(text).toContain("@/client/lib/serverClock");
      }
    }
    expect(touching).toEqual([
      "pages/agents/BehaviorTab.tsx",
      "pages/agents/observabilityFormState.ts",
    ]);
  });
});
