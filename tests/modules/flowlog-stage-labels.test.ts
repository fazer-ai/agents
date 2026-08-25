// EVERY STAGE IN THE CLOSED VOCABULARY HAS A LABEL, AND THE FENCE THAT KEEPS IT THAT WAY.
//
// `FLOW_STAGES` is read by five places, and four of them derive their list from it directly (the
// alert-channel validator, the /stages endpoint, the MCP enums, the channel picker) — adding a stage
// reaches those for free. The fifth is `flowStageLabel`, which is a switch: a stage with no `case`
// falls through to `default` and the Logs page renders the raw slug in the filter dropdown and on
// every row. Nothing breaks, nothing is red, and the operator reads `contact_auth`.
//
// Measured on `main` while adding the `command` stage for issue #317: 11 labels for 14 stages —
// `vision`, `guardrail` and `memory` were each added by a round that reached the four derived
// readers and not this one. This is the per-call-site shape from the process skill: fixing only the
// stage of the day guarantees the next one is born unlabelled, so the criterion is the sweep.
import { describe, expect, test } from "bun:test";
import { FLOW_STAGES } from "@/modules/flowlog/stages";

const LABELS_FILE = "src/client/lib/flowLabels.ts";

// The `case` values of ONE function in the file. Sliced by function, not read whole: `flowLevelLabel`
// lives in the same source and its cases would otherwise count as stages.
export function labelledCases(source: string, fn: string): string[] {
  const start = source.indexOf(`export function ${fn}(`);
  if (start === -1) return [];
  const rest = source.slice(start + 1);
  const end = rest.indexOf("\nexport function ");
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...body.matchAll(/\bcase\s+"([a-z_]+)"\s*:/g)].map(
    (m) => m[1] as string,
  );
}

describe("the stage label sweep", () => {
  // Control positive: the predicate has to SEE a missing case, and has to stay inside its function.
  test("the predicate reads cases from the function it was asked for", () => {
    const fixture = `
export function flowStageLabel(stage: string, t: TFunction): string {
  switch (stage) {
    case "route":
      return t("logs.stage.route", "Routing");
    case "stt":
      return t("logs.stage.stt", "Transcription");
    default:
      return stage;
  }
}

export function flowLevelLabel(level: string, t: TFunction): string {
  switch (level) {
    case "warn":
      return t("logs.level.warn", "Warning");
    default:
      return level;
  }
}
`;
    expect(labelledCases(fixture, "flowStageLabel")).toEqual(["route", "stt"]);
    expect(labelledCases(fixture, "flowLevelLabel")).toEqual(["warn"]);
    expect(labelledCases(fixture, "nothingHere")).toEqual([]);
  });

  test("every stage in the vocabulary has a label case", async () => {
    // Read at assertion time, never a snapshot: a fence generated from the source it fences goes
    // green against its own copy of yesterday's file.
    const source = await Bun.file(LABELS_FILE).text();
    const labelled = new Set(labelledCases(source, "flowStageLabel"));
    const missing = FLOW_STAGES.filter((s) => !labelled.has(s));
    expect(missing).toEqual([]);
  });

  test("no label case names a stage the vocabulary dropped", async () => {
    const source = await Bun.file(LABELS_FILE).text();
    const known = new Set<string>(FLOW_STAGES);
    const stale = labelledCases(source, "flowStageLabel").filter(
      (s) => !known.has(s),
    );
    expect(stale).toEqual([]);
  });
});
