import { describe, expect, test } from "bun:test";
import {
  followUpToForm,
  followUpToStored,
} from "@/client/pages/agents/followUpFormState";
import { readGuardrailsFormState } from "@/client/pages/agents/guardrailsFormState";
import {
  memoryToForm,
  memoryToStored,
} from "@/client/pages/agents/memoryFormState";
import {
  modelFallbackToForm,
  modelFallbackToStored,
} from "@/client/pages/agents/modelFallbackFormState";
import {
  observabilityToForm,
  observabilityToStored,
} from "@/client/pages/agents/observabilityFormState";
import {
  observationToForm,
  observationToStored,
} from "@/client/pages/agents/observationFormState";
import {
  signatureToForm,
  signatureToStored,
} from "@/client/pages/agents/signatureFormState";
import {
  readTtsFormState,
  ttsSettingsFrom,
} from "@/client/pages/agents/ttsFormState";
import {
  assertAgentCreatable,
  assertSettingsClosedValues,
  InvalidSettingsValueError,
} from "@/modules/agents/service";
import CONSOLE_BEHAVIOR_SAVE from "@/tests/fixtures/console-behavior-save-settings.json";

// A CLOSED SETTINGS VALUE THE READER WOULD THROW AWAY IS REFUSED ON REST (#622).
//
// #612, #616 and #618 closed this one field at a time. The rest of the bag had the same hole: REST
// parsed `settings` as a record of unknown, the block's reader replaced an unknown value with its
// default, the runtime acted on the default, and GET echoed what was sent. MCP already refused all of
// it through BEHAVIOR_PATCH_SHAPE, whose documented rule is exactly this question (a value the reader
// throws away is declared; one it honours after measuring must still parse). REST now asks it too.
//
// Asked through `assertAgentCreatable` (the create path, where nothing is stored) and without naming
// a new symbol, so on the base these fail on the assertion rather than on an import.
function refusal(settings: Record<string, unknown>) {
  try {
    assertAgentCreatable({ name: "x", settings });
  } catch (e) {
    return e as { field?: string; statusCode?: number; message: string };
  }
  return null;
}

describe("closed settings values on the create path", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["split.enabled", { split: { enabled: "sim" } }],
    ["tts.mode", { tts: { mode: "sempre" } }],
    ["stt.provider", { stt: { provider: "nao-registrado" } }],
    ["handoff.mode", { handoff: { mode: "talvez" } }],
    ["contactAuth.mode", { contactAuth: { mode: "sempre" } }],
    ["guardrails.input.action", { guardrails: { input: { action: "x" } } }],
    [
      "channelRedirect.resendDelayUnit",
      { channelRedirect: { resendDelayUnit: "semanas" } },
    ],
    [
      "followUp.steps.0.delayUnit",
      { followUp: { steps: [{ delayUnit: "semanas" }] } },
    ],
    ["monitoring.analysis", { monitoring: { analysis: "sempre" } }],
    ["memory.compaction.enabled", { memory: { compaction: { enabled: 1 } } }],
    // Keys the schema declares `never` under `input` are tolerated only with the type the reader
    // reads there, so a value it throws away is still refused (#626's acceptance run: "sim" saved).
    [
      "guardrails.input.checks.promptAdherence",
      { guardrails: { input: { checks: { promptAdherence: "sim" } } } },
    ],
    [
      "guardrails.input.checks.answerRelevance",
      { guardrails: { input: { checks: { answerRelevance: "sim" } } } },
    ],
    [
      "guardrails.input.generationPrompt",
      { guardrails: { input: { generationPrompt: 5 } } },
    ],
  ];
  for (const [path, settings] of cases) {
    test(`${path} outside its domain is refused, naming the path`, () => {
      const err = refusal(settings);
      expect(err?.statusCode).toBe(400);
      expect(err?.field).toBe(path);
    });
  }

  test("valid values that are not the defaults pass", () => {
    expect(
      refusal({
        split: { enabled: false },
        tts: { mode: "mirror" },
        handoff: { mode: "route" },
        contactAuth: { mode: "once" },
        monitoring: { analysis: "on_resolve" },
        followUp: { enabled: true, steps: [{ delayUnit: "hours" }] },
      }),
    ).toBeNull();
  });

  test("an empty block passes: the reader answers it with its defaults", () => {
    expect(refusal({ split: {}, tts: {}, guardrails: {} })).toBeNull();
  });

  test("a key no schema declares still passes, because the readers stay the authority", () => {
    expect(refusal({ split: { somethingNew: 1 } })).toBeNull();
  });
});

// THE CONSOLE IS THE CALLER THAT MUST NEVER BE REFUSED FOR ITS OWN OUTPUT. A boundary that trades the
// silence for a 400 on the editor's own save is the failure this rule could introduce, so two bags the
// console really produces are asked here.
describe("what the console sends", () => {
  // Captured from the running console on 13/09/2026: the body of an ordinary Behavior-tab save. It
  // carries `vision.extractionPrompt: null`, which the reader honours as "use the default prompt".
  test("a Behavior-tab save body passes", () => {
    expect(
      refusal(CONSOLE_BEHAVIOR_SAVE as Record<string, unknown>),
    ).toBeNull();
  });

  // The Guardrails tab sends the READER's output for the block, and that output materialises the two
  // reply-only checks and the generation prompt under `input` too, keys the MCP schema declares `never`.
  test("a Guardrails-tab save of the defaults passes", () => {
    expect(refusal({ guardrails: readGuardrailsFormState({}) })).toBeNull();
    expect(
      refusal({
        guardrails: { ...readGuardrailsFormState({}), enabled: true },
      }),
    ).toBeNull();
  });
});

// Every form pair the editor saves through, asked over its default form. A serializer that starts
// producing a value the schema refuses fails here by name, before an operator's first save does.
describe("each console serializer's default output passes", () => {
  const cases: [string, () => Record<string, unknown>][] = [
    ["followUp", () => ({ followUp: followUpToStored(followUpToForm({})) })],
    ["memory", () => ({ memory: memoryToStored(memoryToForm({})) })],
    [
      "modelFallback",
      () => ({ modelFallback: modelFallbackToStored(modelFallbackToForm({})) }),
    ],
    [
      "observability",
      () => ({ observability: observabilityToStored(observabilityToForm({})) }),
    ],
    [
      "monitoring",
      () => ({ monitoring: observationToStored(observationToForm({})) }),
    ],
    [
      "signature",
      () => ({ signature: signatureToStored(signatureToForm({})) }),
    ],
    ["tts", () => ({ tts: ttsSettingsFrom(readTtsFormState(undefined)) })],
  ];
  for (const [block, bag] of cases) {
    test(block, () => {
      expect(refusal(bag())).toBeNull();
    });
  }
});

describe("assertSettingsClosedValues", () => {
  const caught = (settings: unknown, stored: unknown) => {
    try {
      assertSettingsClosedValues(settings, stored);
    } catch (e) {
      return e as InvalidSettingsValueError;
    }
    return null;
  };

  test("the refusal names the path, what was expected and what was sent", () => {
    const err = caught({ tts: { mode: "sempre" } }, undefined);
    expect(err).toBeInstanceOf(InvalidSettingsValueError);
    expect(err?.field).toBe("tts.mode");
    expect(err?.translationKey).toBe("errors.invalidSettingsValue");
    expect(err?.translationParams?.got).toBe('"sempre"');
    expect(String(err?.translationParams?.expected)).toContain('"mirror"');
  });

  test("null, a number, an array and an object are refused on a closed field", () => {
    for (const bad of [null, 1, ["x"], { a: 1 }]) {
      expect(caught({ split: { enabled: bad } }, undefined)?.field).toBe(
        "split.enabled",
      );
    }
  });

  // A block NAMED as null is an edit of it (#619), which the reader answers with its defaults.
  test("a block named as null passes", () => {
    expect(caught({ split: null, tts: null }, undefined)).toBeNull();
  });

  test("a stored bad value re-sent untouched passes, including a non-primitive and a padded choice", () => {
    const stored = {
      split: { enabled: { sim: true } },
      stt: { provider: " openai " },
      followUp: { steps: [{ delayUnit: ["dias"] }] },
    };
    expect(caught(structuredClone(stored), stored)).toBeNull();
  });

  test("changing one stored bad value names only that path", () => {
    const stored = { split: { enabled: "sim" }, tts: { mode: "sempre" } };
    expect(
      caught({ split: { enabled: "sim" }, tts: { mode: "jamais" } }, stored)
        ?.field,
    ).toBe("tts.mode");
  });

  // The schema's `never`: keys the runtime does not read in that position. Tolerated on REST because
  // the console's Guardrails save materialises them (the describe block above measures that save), but
  // only with the type the reader reads there: anything else is a value it throws away.
  test("a key the schema declares never passes with the type the reader reads there", () => {
    expect(
      caught(
        {
          guardrails: {
            input: { checks: { promptAdherence: true }, generationPrompt: "x" },
          },
        },
        undefined,
      ),
    ).toBeNull();
  });

  test("a never key with another type names the reader's type, not never", () => {
    const err = caught(
      { guardrails: { input: { checks: { promptAdherence: "sim" } } } },
      undefined,
    );
    expect(err?.field).toBe("guardrails.input.checks.promptAdherence");
    expect(err?.translationParams?.expected).toBe("boolean");
    expect(err?.translationParams?.got).toBe('"sim"');
    expect(
      caught(
        { guardrails: { input: { checks: { answerRelevance: "sim" } } } },
        { guardrails: { input: { checks: { answerRelevance: "sim" } } } },
      ),
    ).toBeNull();
  });

  test("a settings bag that is not an object, or absent, is not this rule's business", () => {
    expect(caught(undefined, { split: { enabled: true } })).toBeNull();
    expect(caught([], undefined)).toBeNull();
  });
});
