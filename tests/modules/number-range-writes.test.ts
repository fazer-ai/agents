import { describe, expect, test } from "bun:test";
import {
  assertSettingsClosedValues,
  dropUnusableImportedSettingsInPlace,
} from "@/modules/agents/service";
import { readDecisionsConfig } from "@/modules/decisions/config";
import { parseDocumentStyle } from "@/modules/documents/blocks";
import {
  parseVariants,
  variantWriteSchema,
} from "@/modules/experiments/service";
import { assertIntegrationWritable } from "@/modules/integrations/service";

// A number outside its range is refused where it is written, instead of stored as typed and run as
// the reader's clamp, with the editor showing one value and the agent running another.

function refusedAt(fn: () => void) {
  try {
    fn();
  } catch (e) {
    const err = e as { field?: string; statusCode?: number };
    return { field: err.field, status: err.statusCode };
  }
  return null;
}

const settingsWrite = (settings: unknown, stored?: unknown) =>
  refusedAt(() => assertSettingsClosedValues(settings, stored));

describe("settings: only what the write introduces or changes", () => {
  test("a stored out-of-range number re-sent intact saves, so an old agent is not locked", () => {
    const stored = { debounce: { windowSeconds: -10, maxMessagesPerBurst: 5 } };
    expect(settingsWrite(structuredClone(stored), stored)).toBeNull();
  });

  test("changing it to another out-of-range number is refused with 422", () => {
    const stored = { debounce: { windowSeconds: -10 } };
    expect(settingsWrite({ debounce: { windowSeconds: -11 } }, stored)).toEqual(
      { field: "debounce.windowSeconds", status: 422 },
    );
  });
});

// The voice agent's call numbers landed with only the reader's clamp: 9999 seconds stored, a call cut at
// an hour, and the editor showing 9999.
describe("a voice agent's call numbers", () => {
  test("out of range is refused, and a legacy row re-sent intact saves", () => {
    expect(settingsWrite({ calls: { maxDurationSecs: 9999 } })).toEqual({
      field: "calls.maxDurationSecs",
      status: 422,
    });
    expect(settingsWrite({ calls: { silenceEndCallSecs: 12.5 } })?.field).toBe(
      "calls.silenceEndCallSecs",
    );
    const legacy = { calls: { speed: 3 } };
    expect(settingsWrite(structuredClone(legacy), legacy)).toBeNull();
  });
});

describe("a delay's range follows its unit", () => {
  const step = (delayValue: number, delayUnit: string) => ({
    followUp: { steps: [{ delayValue, delayUnit }] },
  });

  test("30 days and 720 hours pass, the ceiling in each unit", () => {
    expect(settingsWrite(step(30, "days"))).toBeNull();
    expect(settingsWrite(step(720, "hours"))).toBeNull();
  });

  // The value alone is under the minutes ceiling, so only the unit-aware check refuses it.
  test("31 days and 721 hours are refused at the value", () => {
    expect(settingsWrite(step(31, "days"))).toEqual({
      field: "followUp.steps.0.delayValue",
      status: 422,
    });
    expect(settingsWrite(step(721, "hours"))?.field).toBe(
      "followUp.steps.0.delayValue",
    );
  });

  // The value is what the boundary compares, but the unit is half of what it means: a stored 40
  // minutes changed to 40 days is a change, though the value did not move.
  test("changing only the unit is a change of the delay", () => {
    const stored = {
      channelRedirect: { resendDelayValue: 40, resendDelayUnit: "minutes" },
    };
    expect(
      settingsWrite(
        { channelRedirect: { resendDelayValue: 40, resendDelayUnit: "days" } },
        stored,
      ),
    ).toEqual({ field: "channelRedirect.resendDelayValue", status: 422 });
    const legacy = {
      channelRedirect: { resendDelayValue: 40, resendDelayUnit: "days" },
    };
    expect(settingsWrite(structuredClone(legacy), legacy)).toBeNull();
  });

  // A fraction is refused by the value's own schema, which knows nothing of the unit, so without the
  // pair on that issue too a stored 1.5 minutes turned into 1.5 days would pass as legacy.
  test("changing only the unit of a stored fraction is refused", () => {
    const stored = step(1.5, "minutes");
    expect(settingsWrite(step(1.5, "days"), stored)).toEqual({
      field: "followUp.steps.0.delayValue",
      status: 422,
    });
    expect(settingsWrite(structuredClone(stored), stored)).toBeNull();
  });

  // zod skips a block's refinement once another field of it fails, so the pairs are asked on their own:
  // a legacy fraction in the same block does not let a changed delay through.
  test("a changed delay is refused even when another stored field of the block is invalid", () => {
    const stored = {
      channelRedirect: {
        maxResends: 1.5,
        resendDelayValue: 40,
        resendDelayUnit: "minutes",
      },
    };
    expect(
      settingsWrite(
        {
          channelRedirect: {
            maxResends: 1.5,
            resendDelayValue: 40,
            resendDelayUnit: "days",
          },
        },
        stored,
      ),
    ).toEqual({ field: "channelRedirect.resendDelayValue", status: 422 });
  });

  // A stored fraction already fails at the value's path; changing its unit is still a change.
  test("a legacy fraction whose unit is changed is refused", () => {
    const stored = {
      channelRedirect: { resendDelayValue: 40.5, resendDelayUnit: "minutes" },
    };
    expect(
      settingsWrite(
        {
          channelRedirect: { resendDelayValue: 40.5, resendDelayUnit: "days" },
        },
        stored,
      )?.status,
    ).toBe(422);
    expect(settingsWrite(structuredClone(stored), stored)).toBeNull();
  });

  test("a channel redirect delay is held to its own unit too", () => {
    expect(
      settingsWrite({
        channelRedirect: { resendDelayValue: 31, resendDelayUnit: "days" },
      }),
    ).toEqual({ field: "channelRedirect.resendDelayValue", status: 422 });
  });
});

// The engine/block rule is a refinement of the monitoring block, skipped by zod once a field of the
// block fails, so a legacy fraction stored there must not let `decisions` through without its block.
test("switching to the decisions engine without a block is refused beside a legacy fraction", () => {
  const stored = { monitoring: { engine: "llm", window: { messages: 4.5 } } };
  expect(
    settingsWrite(
      { monitoring: { engine: "decisions", window: { messages: 4.5 } } },
      stored,
    )?.field,
  ).toBe("monitoring.engine");
  expect(settingsWrite(structuredClone(stored), stored)).toBeNull();
});

// `0` or a range: the range's verdict sits inside the union's branch, and it is still a number refused.
test("a fraction in a number that also takes 0 is refused as a number, and an import reads it", () => {
  expect(settingsWrite({ limits: { maxHistoryTokens: 2500.5 } })).toEqual({
    field: "limits.maxHistoryTokens",
    status: 422,
  });
  const settings = { limits: { maxHistoryTokens: 2500.5 } };
  dropUnusableImportedSettingsInPlace(settings);
  expect(settings.limits.maxHistoryTokens).toBe(2501);
});

// An import does not refuse a bundle whole over one field: it pulls the number to the edge the
// runtime would have run on, so the imported agent shows what it does.
describe("an import clamps instead of refusing", () => {
  test("out-of-range numbers come in at the nearest edge", () => {
    const settings = {
      debounce: { windowSeconds: -10 },
      followUp: { steps: [{ delayValue: 90, delayUnit: "days" }] },
    };
    dropUnusableImportedSettingsInPlace(settings);
    expect(settings.debounce.windowSeconds).toBe(3);
    expect(settings.followUp.steps[0]?.delayValue).toBe(30);
  });
});

describe("Google Calendar config numbers", () => {
  const write = (
    config: Record<string, unknown>,
    stored?: Record<string, unknown>,
  ) =>
    refusedAt(() =>
      assertIntegrationWritable("GOOGLE_CALENDAR", { config }, stored),
    );

  test("an appointment length outside 5-480 is refused with 422 naming it", () => {
    expect(write({ slotDurationMinutes: -10 })).toEqual({
      field: "config.slotDurationMinutes",
      status: 422,
    });
  });

  test("a length stored out of range saves when re-sent, and changing it to another is refused", () => {
    const stored = { slotDurationMinutes: 900 };
    expect(write({ slotDurationMinutes: 900 }, stored)).toBeNull();
    expect(write({ slotDurationMinutes: 901 }, stored)?.status).toBe(422);
  });

  test("a fraction of a minute is refused, a whole number at the edge passes", () => {
    expect(write({ minLeadMinutes: 2.5 })?.field).toBe("config.minLeadMinutes");
    expect(
      write({ minLeadMinutes: 0, slotGranularityMinutes: 240 }),
    ).toBeNull();
  });

  test("null is 'let the AI choose', not a length", () => {
    expect(write({ slotDurationMinutes: null })).toBeNull();
  });

  test("a reminder offset the write adds is checked, one already stored is not", () => {
    expect(
      write({ appointmentReminders: { offsetsHours: [24, 0] } })?.field,
    ).toBe("config.appointmentReminders.offsetsHours[1]");
    expect(
      write(
        { appointmentReminders: { offsetsHours: [24, 0] } },
        { appointmentReminders: { offsetsHours: [0] } },
      ),
    ).toBeNull();
  });

  test("another catalog's config is not read as a calendar's", () => {
    expect(
      refusedAt(() =>
        assertIntegrationWritable("GENERIC", {
          config: { slotDurationMinutes: -10 },
        }),
      ),
    ).toBeNull();
  });
});

// A variant's weight is capped where it is written; the reader of a stored experiment keeps a weight
// from before the cap, or the experiment would silently stop applying.
test("an experiment weight above the cap is refused on write and still read from a stored row", () => {
  expect(variantWriteSchema.safeParse({ key: "a", weight: 5000 }).success).toBe(
    false,
  );
  expect(
    parseVariants([
      { key: "a", weight: 5000 },
      { key: "b", weight: 5000 },
    ]),
  ).toHaveLength(2);
});

// The reader drops a null step, so the out-of-range one sits at another index in its reading: the
// clamp is read from the step itself, and the row stores what the runtime runs on.
test("an import clamps a step that follows a null one", () => {
  const settings = {
    followUp: { steps: [null, { delayValue: -1, delayUnit: "minutes" }] },
  };
  dropUnusableImportedSettingsInPlace(settings);
  expect(settings.followUp.steps).toEqual([
    { delayValue: 1, delayUnit: "minutes" },
  ]);
});

// Each out-of-range value is read alone from a copy narrowed to its path, never from a clone of the
// whole block, so a bundle of thousands of steps imports in linear time (a full clone per value took
// seconds and held the import's transaction).
test("an import of thousands of out-of-range steps stays linear", () => {
  const steps = Array.from({ length: 8000 }, () => ({
    delayValue: -1,
    delayUnit: "minutes",
  }));
  const settings = { followUp: { steps } };
  const started = performance.now();
  dropUnusableImportedSettingsInPlace(settings);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(settings.followUp.steps[7999]?.delayValue).toBe(1);
});

// The reader of a stored style keeps the nearest size: reading the bounded schema there would turn a
// stored 20 into the default instead of 14.
test("a stored base font size outside 8-14 reads at the nearest edge", () => {
  expect(parseDocumentStyle({ baseFontSize: 20 }).baseFontSize).toBe(14);
  expect(parseDocumentStyle({ baseFontSize: 2 }).baseFontSize).toBe(8);
});

// A level is read only on a score question; on any other one it was always dropped, so a stray one
// stored before the cap still reads, while a write that introduces it is refused.
test("a stray level past the cap on a yes_no condition still reads, and is refused on write", () => {
  const decisions = {
    provider: "typesafe",
    credentialRef: "vault:1",
    questions: [{ name: "quer_cancelar", type: "yes_no", instructions: "x" }],
    rules: [
      {
        when: [
          { question: "quer_cancelar", minProbability: 0.7, maxLevel: 50 },
        ],
        action: { tool: "set_labels", args: { add: ["x"] } },
      },
    ],
  };
  expect(readDecisionsConfig({ decisions }).ok).toBe(true);
  expect(
    settingsWrite({ monitoring: { engine: "decisions", decisions } })?.field,
  ).toBe("monitoring.decisions.rules.0.when.0.maxLevel");
});

// A fraction is refused naming the value the caller sent, not the type it has.
test("a fraction is refused quoting the fraction", () => {
  let message = "";
  try {
    assertSettingsClosedValues(
      { debounce: { maxMessagesPerBurst: 2.5 } },
      undefined,
    );
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("got 2.5");
});
