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
  // The tools save fires two calls (grants PUT, then agent PATCH), so it checks the bag itself before
  // the first one — otherwise the grants persist and the PATCH is refused. It has to ask the same
  // question the server asks: what does this write CHANGE. Comparing against nothing would refuse a
  // save over text stored before the caps, which is the state the server deliberately lets through.
  //
  // Source-level for the same reason as the rest of this file; the rule itself is covered by
  // agents-text-caps.test.ts, what is left here is the wiring.
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
    expect(
      writers
        .filter((h) => !h.body.includes("apiErrorMessage"))
        .map((h) => h.name),
    ).toEqual([]);
  });
});
