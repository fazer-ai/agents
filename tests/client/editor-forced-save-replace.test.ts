import { describe, expect, test } from "bun:test";

// EVERY SAVE OF THE AGENT EDITOR THAT CAN BE FORCED DECLARES THE REPLACEMENT WHEN IT IS (#614).
//
// The server refuses a settings bag that would drop blocks the row holds, and the editor's bags are
// built from the last-synced settings, so a block another writer added after the load is missing
// from all of them. An ordinary save should be refused for that. The "overwrite anyway" retry after a
// 409 should not: the operator chose their copy, and a retry that does not say so answers 400 on
// every attempt with nothing on screen they can change. Review round 1 found it on the four PATCH
// sites of this page, none of which sent the word.
//
// A source fence rather than a rendered test, for the reason this repo's other fences give: the
// question is "does every call site do it", and a new save added next month is the case that
// matters. Counted per call, so a fifth PATCH without the spread fails here by name of the file.
const SRC = await Bun.file(
  "src/client/pages/agents/AgentEditorPage.tsx",
).text();

// The argument of each `.agents({ id }).patch(...)` call, up to its closing paren on its own line or
// the identifier it was handed.
function patchCalls(src: string): string[] {
  const out: string[] = [];
  const marker = ".agents({ id }).patch(";
  let at = src.indexOf(marker);
  while (at !== -1) {
    const open = at + marker.length;
    let depth = 1;
    let i = open;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    out.push(src.substring(open, i - 1));
    at = src.indexOf(marker, i);
  }
  return out;
}

describe("forced saves in AgentEditorPage", () => {
  const calls = patchCalls(SRC);

  test("the page still has the four PATCH sites this fence was written against", () => {
    // Not a ceiling: a fifth site is fine, as long as it passes the test below.
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  test("each one carries replaceFor(force), inline or in the object it was handed", () => {
    for (const arg of calls) {
      const inline = arg.includes("...replaceFor(force)");
      // `saveChannelRedirect` builds `patch` first and hands the identifier over.
      const named =
        /^\s*patch\s*$/.test(arg) &&
        /const patch = \{[^;]*\.\.\.replaceFor\(force\)/s.test(SRC);
      expect({ arg: arg.trim().slice(0, 80), ok: inline || named }).toEqual({
        arg: arg.trim().slice(0, 80),
        ok: true,
      });
    }
  });

  test("replaceFor declares nothing on an ordinary save", () => {
    expect(SRC).toMatch(
      /const replaceFor = \(force: boolean\) =>\s*force \? \{ settingsMode: "replace" as const \} : \{\};/,
    );
  });
});
