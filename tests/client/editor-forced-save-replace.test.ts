import { describe, expect, test } from "bun:test";

// Every save of the agent editor that can be forced declares the replacement when it is. The server
// refuses a settings bag that would drop blocks the row holds, and the editor builds its bags from
// the last-synced settings, so a block another writer added is missing from all of them. An
// ordinary save should be refused for that; the "overwrite anyway" retry after a 409 should not
// (the operator chose their copy), and without the declaration it answers 400 on every attempt.
// A source fence, since the question is "does every call site do it": counted per call, so a new
// PATCH without the spread fails here.
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
