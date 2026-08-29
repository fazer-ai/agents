import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The Behavior save REPLACES each block it names with what the form holds, so a block the save bag
// stops naming is not merely un-editable: it is DELETED from the stored settings on the next save,
// and the reader then projects its default. For `takeover` that default is ON, so an operator who
// turned the agent's step-back OFF would find it back on after saving anything else on that tab,
// with nothing anywhere reporting it. That is the same failure `tts.baseURL` had, and the round-trip
// guard over ./memoryFormState is what it produced.
//
// A SOURCE test rather than a round-trip one, because the shape is different: `takeover` is one
// boolean built inline in the save bag, inside a component closure, and the failure mode is a
// deleted line rather than a wrong value. Nothing a pure function could round-trip would see it.
const PAGE = "src/client/pages/agents/AgentEditorPage.tsx";

describe("the agent editor carries the takeover block through a Behavior save", () => {
  const src = readFileSync(PAGE, "utf8");

  test("the save bag names it", () => {
    expect(src).toContain("takeover: { onHumanReply: takeover.onHumanReply }");
  });

  // The other half: a bag that HAS the block has to load into the form, or the save above writes the
  // default over the operator's stored choice on the first Behavior save after they set it.
  test("the reader loads it, defaulting to ON", () => {
    expect(src).toMatch(
      /takeover:\s*\{[\s\S]{0,200}onHumanReply[\s\S]{0,120}!==\s*false/,
    );
  });
});
