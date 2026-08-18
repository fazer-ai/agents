import { describe, expect, test } from "bun:test";
import {
  CUSTOM_POLICY_MAX,
  clampOversizedTextInPlace,
  collectOversizedText,
  EXTRACTION_PROMPT_MAX,
  FOLLOW_UP_INSTRUCTIONS_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
  TOOL_INSTRUCTIONS_MAX,
} from "@/modules/agents/text-caps";

// The readers clamp this text on READ (readToolInstructions, readGuardrailsConfig, readVisionConfig,
// readFollowUpConfig), which is invisible to whoever wrote it: the row keeps every character, the
// editor hydrates from the row, and only the model-facing copy is short. This walker is the one place
// that knows where those fields live, so the write boundary and the importer agree with the readers.
const over = (max: number) => "x".repeat(max + 1);
const at = (max: number) => "x".repeat(max);
const paths = (s: unknown) => collectOversizedText(s).map((o) => o.path);

describe("collectOversizedText", () => {
  test("reports the field, its length and the cap it broke", () => {
    const found = collectOversizedText({
      handoff: { instructions: over(TOOL_INSTRUCTIONS_MAX) },
    });
    expect(found).toEqual([
      {
        path: "handoff.instructions",
        length: TOOL_INSTRUCTIONS_MAX + 1,
        max: TOOL_INSTRUCTIONS_MAX,
      },
    ]);
  });

  test("covers every field whose reader clamps operator prose", () => {
    expect(
      paths({
        handoff: { instructions: over(TOOL_INSTRUCTIONS_MAX) },
        kanban: { instructions: over(TOOL_INSTRUCTIONS_MAX) },
        toolGuidance: { assign_label: over(TOOL_INSTRUCTIONS_MAX) },
        guardrails: {
          customPolicy: over(CUSTOM_POLICY_MAX),
          input: { templateMessage: over(TEMPLATE_MESSAGE_MAX) },
          output: { generationPrompt: over(GENERATION_PROMPT_MAX) },
        },
        vision: { extractionPrompt: over(EXTRACTION_PROMPT_MAX) },
        followUp: {
          steps: [
            { instructions: "fine" },
            { instructions: over(FOLLOW_UP_INSTRUCTIONS_MAX) },
          ],
        },
      }).sort(),
    ).toEqual(
      [
        "handoff.instructions",
        "kanban.instructions",
        "toolGuidance.assign_label",
        "guardrails.customPolicy",
        "guardrails.input.templateMessage",
        "guardrails.output.generationPrompt",
        "vision.extractionPrompt",
        "followUp.steps[1].instructions",
      ].sort(),
    );
  });

  test("a value exactly at the cap is not oversized", () => {
    expect(
      paths({
        handoff: { instructions: at(TOOL_INSTRUCTIONS_MAX) },
        guardrails: {
          customPolicy: at(CUSTOM_POLICY_MAX),
          output: { templateMessage: at(TEMPLATE_MESSAGE_MAX) },
        },
        vision: { extractionPrompt: at(EXTRACTION_PROMPT_MAX) },
      }),
    ).toEqual([]);
  });

  test("the reader trims before clamping, so trailing space is not what breaks the cap", () => {
    // readToolInstructions trims first: a value that only exceeds the cap through surrounding
    // whitespace is stored short, and refusing it would refuse a note the model receives whole.
    expect(
      paths({ handoff: { instructions: `  ${at(TOOL_INSTRUCTIONS_MAX)}  ` } }),
    ).toEqual([]);
  });

  test("ignores tool-guidance keys the reader itself drops", () => {
    // readToolGuidance keeps only NATIVE_TOOL_NAMES keys; an unknown key is never read, so capping
    // it would refuse a write over text nothing consumes.
    expect(
      paths({ toolGuidance: { not_a_tool: over(TOOL_INSTRUCTIONS_MAX) } }),
    ).toEqual([]);
  });

  test("survives every malformed shape a settings bag can hold", () => {
    for (const bag of [
      undefined,
      null,
      "string",
      42,
      [1, 2],
      {},
      { handoff: null },
      { handoff: [1, 2] },
      { handoff: { instructions: 42 } },
      { toolGuidance: [over(TOOL_INSTRUCTIONS_MAX)] },
      { followUp: { steps: "nope" } },
      { guardrails: { input: "not a block" } },
      { followUp: { steps: [null, 7, { instructions: null }] } },
    ]) {
      expect(collectOversizedText(bag)).toEqual([]);
    }
  });
});

describe("clampOversizedTextInPlace", () => {
  test("cuts every oversized field to its cap and reports what it cut", () => {
    const bag: Record<string, unknown> = {
      handoff: { mode: "pinned", instructions: over(TOOL_INSTRUCTIONS_MAX) },
      followUp: { steps: [{ instructions: over(FOLLOW_UP_INSTRUCTIONS_MAX) }] },
    };
    const clipped = clampOversizedTextInPlace(bag)
      .map((c) => c.path)
      .sort();
    expect(clipped).toEqual(
      ["followUp.steps[0].instructions", "handoff.instructions"].sort(),
    );
    expect(collectOversizedText(bag)).toEqual([]);
    const ho = bag.handoff as Record<string, unknown>;
    expect((ho.instructions as string).length).toBe(TOOL_INSTRUCTIONS_MAX);
    // The rest of the block survives: a clamp that rebuilds the bag from the fields it knows would
    // drop everything it does not (the shape of the bug in #113).
    expect(ho.mode).toBe("pinned");
  });

  test("leaves a bag with nothing oversized untouched", () => {
    const bag = { handoff: { instructions: at(TOOL_INSTRUCTIONS_MAX) } };
    expect(clampOversizedTextInPlace(bag)).toEqual([]);
    expect(bag.handoff.instructions.length).toBe(TOOL_INSTRUCTIONS_MAX);
  });
});
