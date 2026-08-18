import { describe, expect, test } from "bun:test";
import {
  CUSTOM_POLICY_MAX,
  clampOversizedTextInPlace,
  collectOversizedText,
  EXTRACTION_PROMPT_MAX,
  FOLLOW_UP_INSTRUCTIONS_MAX,
  FOLLOW_UP_MAX_STEPS,
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

  test("whitespace counts, because the control and the browser count it too", () => {
    // The readers trim before they clamp, so a value that only passes the cap through surrounding
    // whitespace would still be read whole. Measuring the trimmed length here was this walker's first
    // shape and it could not be mirrored on screen: the browser enforces `maxLength` against the RAW
    // value, so a field holding two leading spaces refused the next character while the counter still
    // showed room. One rule everywhere is worth more than accepting a value whose only problem is
    // invisible, and the counter says exactly how much to delete.
    expect(
      paths({ handoff: { instructions: ` ${at(TOOL_INSTRUCTIONS_MAX)}` } }),
    ).toEqual(["handoff.instructions"]);
  });

  test("ignores tool-guidance keys the reader itself drops", () => {
    // readToolGuidance keeps only NATIVE_TOOL_NAMES keys; an unknown key is never read, so capping
    // it would refuse a write over text nothing consumes.
    expect(
      paths({ toolGuidance: { not_a_tool: over(TOOL_INSTRUCTIONS_MAX) } }),
    ).toEqual([]);
  });

  test("ignores follow-up steps past the reader's own limit", () => {
    // readFollowUpConfig slices to FOLLOW_UP_MAX_STEPS before it parses, so an 11th step is text
    // nothing ever reads: refusing a write over it (or warning about it on import) would be about a
    // value the runtime discards. Same rule as the tool-guidance keys above.
    const steps = Array.from({ length: FOLLOW_UP_MAX_STEPS + 2 }, (_, i) => ({
      instructions:
        i >= FOLLOW_UP_MAX_STEPS ? over(FOLLOW_UP_INSTRUCTIONS_MAX) : "fine",
    }));
    expect(paths({ followUp: { steps } })).toEqual([]);
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
  // `slice` counts UTF-16 units, so a cut that lands between the two halves of an astral character
  // leaves an unpaired surrogate. Postgres refuses an unpaired surrogate escape in jsonb outright, so
  // this is the import failing on a note that happens to have an emoji at the wrong offset.
  test("never ends a clip on half of an astral character", () => {
    const bag = {
      handoff: {
        instructions: `${"x".repeat(TOOL_INSTRUCTIONS_MAX - 1)}😀tail`,
      },
    };
    clampOversizedTextInPlace(bag);
    const out = bag.handoff.instructions;
    expect(out.length).toBe(TOOL_INSTRUCTIONS_MAX - 1);
    expect(JSON.parse(JSON.stringify(out))).toBe(out);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  test("keeps an astral character that fits whole", () => {
    const bag = {
      handoff: {
        instructions: `${"x".repeat(TOOL_INSTRUCTIONS_MAX - 2)}😀tail`,
      },
    };
    clampOversizedTextInPlace(bag);
    expect(bag.handoff.instructions.endsWith("😀")).toBe(true);
    expect(bag.handoff.instructions.length).toBe(TOOL_INSTRUCTIONS_MAX);
  });

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
