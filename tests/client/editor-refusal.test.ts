import { describe, expect, test } from "bun:test";
import {
  editorRefusalFields,
  editorTargetFor,
  followUpStepField,
} from "@/client/lib/editorRefusal";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";
import { collectOversizedTextChanges } from "@/modules/agents/text-caps";

// WHERE A REFUSAL ABOUT A BAG GOES, when the control for it is behind one of eight tabs.
//
// #320 wired every form in the console to put a refusal at the input the server named, and stopped at
// this one: the editor holds `name` and `systemPrompt`, and everything else it writes lives in bags
// edited on another tab. A mark written to a control nobody is looking at is silence, which is the
// one outcome the mechanism may not produce, so the missing half was never the mark — it was knowing
// WHERE the control is, and saying so.
//
// The map that answers it already existed twice, disagreeing. This file is the guard against it
// disagreeing again.

// A settings bag holding every capped field, each one over its cap, so the walker reports the
// complete set of paths a text refusal can name. Built rather than listed: the point of the sweep
// below is to catch the field somebody adds to `text-caps.ts` next week, and a hand-written list
// would be exactly as blind as the map it is checking.
function everyCappedPath(): string[] {
  const long = "x".repeat(4001);
  const bag = {
    handoff: { instructions: long },
    availability: { awayMessage: long },
    contactAuth: { denyMessage: long },
    kanban: { instructions: long },
    toolGuidance: Object.fromEntries(NATIVE_TOOL_NAMES.map((n) => [n, long])),
    guardrails: {
      customPolicy: long,
      input: { templateMessage: long, generationPrompt: long },
      output: { templateMessage: long, generationPrompt: long },
    },
    vision: { extractionPrompt: long },
    followUp: { steps: [{ instructions: long }, { instructions: long }] },
  };
  return collectOversizedTextChanges(bag, undefined).map((o) => o.path);
}

// The thirteen native tools accept a note and the console draws three. The other ten can only have
// been written through REST or MCP, so a refusal about one has nowhere to send anybody — and saying
// "go to the Tools tab" about a control that is not there is worse than saying nothing.
const NO_CONTROL = NATIVE_TOOL_NAMES.filter(
  (n) =>
    !["set_custom_attribute", "assign_label", "update_kanban_task"].includes(n),
).map((n) => `toolGuidance.${n}`);

describe("editorTargetFor", () => {
  test("every capped field either has a place in the editor or is one of the ten with no control", () => {
    // The sweep that would have caught this issue's own finding: `availability.awayMessage` and
    // `contactAuth.denyMessage` are capped, have a textarea on the Behavior tab, and were in neither
    // of the two maps that used to answer this. A warning about either told the operator the console
    // has no field for it.
    const unplaced = everyCappedPath().filter(
      (p) => editorTargetFor(p, { guardrailsEnabled: true }) === null,
    );
    expect(unplaced.sort()).toEqual([...NO_CONTROL].sort());
  });

  test("the two copy fields the customer reads land on their own sections", () => {
    expect(editorTargetFor("availability.awayMessage")).toEqual({
      tab: "behavior",
      sectionId: "availability",
    });
    expect(editorTargetFor("contactAuth.denyMessage")).toEqual({
      tab: "behavior",
      sectionId: "contactAuth",
    });
  });

  test("both spellings of a settings path answer the same place", () => {
    // The wire carries two roots for the same bag: the text producer reports from the settings bag
    // (`guardrails.customPolicy`) and the credential producer from the agent row
    // (`settings.tts.credentialRef`). A reader that trusts one loses the other half of the fields.
    expect(editorTargetFor("settings.vision.extractionPrompt")).toEqual(
      editorTargetFor("vision.extractionPrompt"),
    );
    expect(editorTargetFor("settings.tts.credentialRef")).toEqual({
      tab: "behavior",
      sectionId: "tts",
    });
  });

  test("every credential the agent holds is placed, from the list the server refuses by", () => {
    // Derived from SETTINGS_CREDENTIAL_PATHS rather than restated, so a block that grows a
    // credential next week is placed by construction. `modelConfig` is the eighth and lives on its
    // own column.
    for (const p of SETTINGS_CREDENTIAL_PATHS) {
      const field = `settings.${p.path.join(".")}`;
      expect(
        editorTargetFor(field, { guardrailsEnabled: true }),
        `${field} has no place in the editor`,
      ).toEqual({ tab: p.tab, sectionId: p.sectionId });
    }
    expect(editorTargetFor("modelConfig.credentialRef")).toEqual({
      tab: "general",
      sectionId: "general-model",
    });
  });

  test("with guardrails off, a guardrails field targets the section that is actually mounted", () => {
    // GuardrailsTab draws gr-input/gr-output/gr-policy only while guardrails are ON, so with them off
    // the anchor is not in the DOM and the jump scrolls to nothing. gr-model always mounts and holds
    // the switch that brings the rest back — the same redirect the config-health warning already does.
    expect(editorTargetFor("guardrails.customPolicy")).toEqual({
      tab: "guardrails",
      sectionId: "gr-model",
    });
    expect(
      editorTargetFor("settings.guardrails.credentialRef", {
        guardrailsEnabled: false,
      }),
    ).toEqual({ tab: "guardrails", sectionId: "gr-model" });
    expect(
      editorTargetFor("guardrails.customPolicy", { guardrailsEnabled: true }),
    ).toEqual({ tab: "guardrails", sectionId: "gr-policy" });
  });

  test("a grant id is not an input, and is not placed", () => {
    // `bigOrThrow` names five id fields, and every one of them is filled by a picker from the
    // catalog — measured in ToolGrantsEditor, which builds each grant from `inst.id`. Nothing in the
    // console types one, so the refusal cannot arrive from here and there is no box to mark.
    for (const f of [
      "toolDefinitionId",
      "mcpServerConnectionId",
      "integrationInstanceId",
      "documentTemplateId",
      "knowledgeBaseIds",
    ]) {
      expect(editorTargetFor(f)).toBeNull();
    }
  });
});

describe("editorRefusalFields", () => {
  test("every declared name is drawn by the tab it is declared under", () => {
    // The anti-drift half: the per-tab lists and the target map are two statements about the same
    // thing, and a name that moves in one and not the other sends the operator to the wrong tab.
    for (const tab of [
      "general",
      "behavior",
      "guardrails",
      "tools",
      "channelRedirect",
    ] as const) {
      const { drawn } = editorRefusalFields({ tab, followUpSteps: 2 });
      for (const field of drawn) {
        expect(
          editorTargetFor(field, { guardrailsEnabled: true })?.tab,
          `${field} is declared on ${tab}`,
        ).toBe(tab);
      }
    }
  });

  test("what a tab draws is a subset of what the editor owns", () => {
    const { owned } = editorRefusalFields({ tab: "general", followUpSteps: 3 });
    for (const tab of ["general", "behavior", "guardrails", "tools"] as const) {
      for (const field of editorRefusalFields({ tab, followUpSteps: 3 })
        .drawn) {
        expect(owned, `${field} is drawn but not owned`).toContain(field);
      }
    }
  });

  test("the follow-up notes stop where the editor's step list does", () => {
    // A mark on a step that does not exist is a name nothing renders, which is the silence this
    // whole mechanism is against.
    const { drawn } = editorRefusalFields({
      tab: "behavior",
      followUpSteps: 2,
    });
    expect(drawn).toContain(followUpStepField(0));
    expect(drawn).toContain(followUpStepField(1));
    expect(drawn).not.toContain(followUpStepField(2));
  });
});

describe("the write boundary the tab-gated declaration rests on", () => {
  // The per-tab lists do not carry the switches inside a section (vision off hides the extraction
  // prompt; the gate off hides the deny message). That is exact only because the server refuses text
  // a write INTRODUCES or CHANGES and nothing else — change one of these and its control was on
  // screen. If that ever stops being true, the declaration starts claiming controls the operator
  // cannot see, and this is the test that says so.
  test("a stored oversized value this write does not touch is not refused", () => {
    const long = "x".repeat(5000);
    const stored = { vision: { extractionPrompt: long } };
    expect(collectOversizedTextChanges({ ...stored }, stored)).toEqual([]);
  });

  test("the same value changed IS refused", () => {
    const stored = { vision: { extractionPrompt: "x".repeat(5000) } };
    const next = { vision: { extractionPrompt: "y".repeat(5000) } };
    expect(
      collectOversizedTextChanges(next, stored).map((o) => o.path),
    ).toEqual(["vision.extractionPrompt"]);
  });
});
