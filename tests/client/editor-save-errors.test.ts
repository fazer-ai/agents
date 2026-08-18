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
