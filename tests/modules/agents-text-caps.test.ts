import { describe, expect, test } from "bun:test";
import {
  CUSTOM_POLICY_MAX,
  clampOversizedTextInPlace,
  collectOversizedTextChanges,
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
// Nothing stored before: every oversized value is one this write introduces, which is what the
// walker itself is being measured on here.
const oversized = (s: unknown) => collectOversizedTextChanges(s, undefined);
const paths = (s: unknown) => oversized(s).map((o) => o.path);

describe("the settings text walker", () => {
  test("reports the field, its length and the cap it broke", () => {
    const found = oversized({
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
      expect(oversized(bag)).toEqual([]);
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
    expect(oversized(bag)).toEqual([]);
    const ho = bag.handoff as Record<string, unknown>;
    expect((ho.instructions as string).length).toBe(TOOL_INSTRUCTIONS_MAX);
    // The rest of the block survives: a clamp that rebuilds the bag from the fields it knows would
    // drop everything it does not (the shape of the bug in #113).
    expect(ho.mode).toBe("pinned");
  });

  // Every reader trims before it applies its cap, so an imported value that is only over because of
  // leading whitespace loses nothing at the runtime. Clipping the raw string would throw away as many
  // real characters as there were spaces — content the reader would have kept.
  test("clips what the reader would keep, not the whitespace in front of it", () => {
    const rule = "r".repeat(TOOL_INSTRUCTIONS_MAX);
    const bag: Record<string, unknown> = {
      handoff: { instructions: `${" ".repeat(100)}${rule}` },
    };
    // Nothing of substance is over the cap, so nothing is reported as clipped.
    expect(clampOversizedTextInPlace(bag)).toEqual([]);
    expect((bag.handoff as Record<string, string>).instructions).toBe(rule);
  });

  test("still clips when the text itself is over the cap", () => {
    const bag: Record<string, unknown> = {
      handoff: {
        instructions: `  ${"r".repeat(TOOL_INSTRUCTIONS_MAX + 50)}  `,
      },
    };
    expect(clampOversizedTextInPlace(bag).map((c) => c.path)).toEqual([
      "handoff.instructions",
    ]);
    const kept = (bag.handoff as Record<string, string>).instructions ?? "";
    expect(kept).toHaveLength(TOOL_INSTRUCTIONS_MAX);
    expect(kept.startsWith("r")).toBe(true);
  });

  test("leaves a bag with nothing oversized untouched", () => {
    const bag = { handoff: { instructions: at(TOOL_INSTRUCTIONS_MAX) } };
    expect(clampOversizedTextInPlace(bag)).toEqual([]);
    expect(bag.handoff.instructions.length).toBe(TOOL_INSTRUCTIONS_MAX);
  });
});

// What a write is allowed to be refused for: the text it INTRODUCES or CHANGES. A value stored before
// the caps existed cannot be refused, because every field carrying one can be invisible in the editor
// — a native-tool note with no control at all (`private_note`), or a section whose fields only render
// when it is switched on — so the refusal would name something the operator has no way to shorten,
// on every tab, forever. The reader still clamps that value on the way to the model, which is where
// it always mattered.
describe("settings text caps: what a write changes", () => {
  const changed = (next: unknown, prev: unknown) =>
    collectOversizedTextChanges(next, prev).map((o) => o.path);

  test("an untouched oversized value is not the write's problem", () => {
    const legacy = { handoff: { instructions: over(TOOL_INSTRUCTIONS_MAX) } };
    expect(
      changed({ ...legacy, kanban: { instructions: "move it" } }, legacy),
    ).toEqual([]);
  });

  test("editing an oversized value still refuses, even when it gets shorter", () => {
    const prev = {
      handoff: { instructions: "y".repeat(TOOL_INSTRUCTIONS_MAX + 500) },
    };
    const next = {
      handoff: { instructions: "y".repeat(TOOL_INSTRUCTIONS_MAX + 100) },
    };
    expect(changed(next, prev)).toEqual(["handoff.instructions"]);
  });

  test("a new oversized value refuses whether or not the field existed", () => {
    expect(
      changed({ kanban: { instructions: over(TOOL_INSTRUCTIONS_MAX) } }, {}),
    ).toEqual(["kanban.instructions"]);
    expect(
      changed(
        { vision: { extractionPrompt: over(EXTRACTION_PROMPT_MAX) } },
        { vision: { extractionPrompt: "short" } },
      ),
    ).toEqual(["vision.extractionPrompt"]);
  });

  test("a note for a tool the editor has no control for is left alone once stored", () => {
    const legacy = {
      toolGuidance: { private_note: over(TOOL_INSTRUCTIONS_MAX) },
    };
    expect(changed(legacy, legacy)).toEqual([]);
    expect(oversized(legacy)).toEqual(
      ["toolGuidance.private_note"].map((path) => ({
        path,
        length: TOOL_INSTRUCTIONS_MAX + 1,
        max: TOOL_INSTRUCTIONS_MAX,
      })),
    );
  });

  // The editor trims these fields when it serializes the form, so an untouched legacy value stored
  // with surrounding whitespace comes back as a DIFFERENT string. Comparing raw would call that an
  // edit and refuse a save the operator never made — on a tab that may not even show the field.
  test("whitespace the readers discard is not an edit", () => {
    const body = "w".repeat(TOOL_INSTRUCTIONS_MAX + 200);
    const prev = { handoff: { instructions: `  ${body}  ` } };
    const next = { handoff: { instructions: body } };
    expect(changed(next, prev)).toEqual([]);
    expect(changed({ handoff: { instructions: `${body}!` } }, prev)).toEqual([
      "handoff.instructions",
    ]);
  });

  test("no previous bag means every oversized value is new", () => {
    const bag = { guardrails: { customPolicy: over(CUSTOM_POLICY_MAX) } };
    expect(changed(bag, undefined)).toEqual(["guardrails.customPolicy"]);
    expect(changed(bag, "not a bag")).toEqual(["guardrails.customPolicy"]);
  });

  test("follow-up steps compare per position, like the reader reads them", () => {
    const step = (instructions: string) => ({ delayValue: 30, instructions });
    const prev = {
      followUp: { steps: [step("a"), step(over(FOLLOW_UP_INSTRUCTIONS_MAX))] },
    };
    expect(changed(prev, prev)).toEqual([]);
    // Removing the first step shifts the oversized one into position 0, which reads as a change. The
    // operator is inside that section to have done it, so the field is on screen and actionable.
    const shifted = {
      followUp: { steps: [step(over(FOLLOW_UP_INSTRUCTIONS_MAX))] },
    };
    expect(changed(shifted, prev)).toEqual(["followUp.steps[0].instructions"]);
  });
});
