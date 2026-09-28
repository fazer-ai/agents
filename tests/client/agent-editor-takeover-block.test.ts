import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The Behavior save REPLACES each block it names, so a block the save bag stops naming is DELETED
// on the next save and the reader projects its default. For `takeover` that default is ON, so an
// operator's step-back OFF would silently come back on.
// A source test, not a round-trip one: `takeover` is built inline in the save bag inside a
// component closure, and the failure is a deleted line, which no pure function could round-trip.
const PAGE = "src/client/pages/agents/AgentEditorPage.tsx";

describe("the agent editor carries the takeover block through a Behavior save", () => {
  const src = readFileSync(PAGE, "utf8");

  test("the save bag names it", () => {
    expect(src).toContain("takeover: { onHumanReply: takeover.onHumanReply }");
  });

  // NOTE: the other half: a bag that HAS the block has to load into the form, or the save above writes the
  // default over the operator's stored choice.
  test("the reader loads it, defaulting to ON", () => {
    expect(src).toMatch(
      /takeover:\s*\{[\s\S]{0,200}onHumanReply[\s\S]{0,120}!==\s*false/,
    );
  });
});
