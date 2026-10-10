// EVERY STAGE IN THE CLOSED VOCABULARY HAS A LABEL.
//
// `FLOW_STAGES` is read by five places, and four derive their list from it directly (the
// alert-channel validator, the /stages endpoint, the MCP enums, the channel picker), so a new stage
// reaches them for free. The fifth is `flowStageLabel`, a switch: a stage with no `case` falls through
// to `default` and the Logs page renders the raw slug (`contact_auth`) with nothing red. So every
// stage in the vocabulary is labelled through the function itself.
import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { flowStageLabel } from "@/client/lib/flowLabels";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { FLOW_STAGES } from "@/modules/flowlog/stages";

// Answers with the key it was asked for, so the label shows which catalog entry the stage reads.
const keyOf = ((key: string) => key) as unknown as TFunction;

describe("the stage labels", () => {
  test("every stage in the vocabulary is labelled from its own catalog entry", () => {
    const unlabelled = FLOW_STAGES.filter(
      (stage) => flowStageLabel(stage, keyOf) !== `logs.stage.${stage}`,
    );
    expect(unlabelled).toEqual([]);
  });

  // The other direction: a stage the vocabulary dropped keeps its label only while its copy stays in
  // the catalogs, so every stage the catalogs carry copy for has to still be one.
  test("no stage the catalogs carry copy for has left the vocabulary", () => {
    const known = new Set<string>(FLOW_STAGES);
    for (const catalog of [en, ptBR]) {
      const stale = Object.keys(catalog.logs.stage).filter(
        (stage) => !known.has(stage),
      );
      expect(stale).toEqual([]);
    }
  });

  // The control: a slug outside the vocabulary is what `default` answers with, so the test above is
  // measuring the cases and not a function that labels everything.
  test("a stage outside the vocabulary comes back as its raw slug", () => {
    expect(flowStageLabel("not_a_stage", keyOf)).toBe("not_a_stage");
  });
});
