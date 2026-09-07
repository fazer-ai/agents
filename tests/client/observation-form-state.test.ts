import { describe, expect, test } from "bun:test";
import {
  groupIncomplete,
  monitoringReaderKeys,
  OBSERVATION_LIMITS,
  observationToForm,
  observationToStored,
} from "@/client/pages/agents/observationFormState";
import { readMonitoringConfig } from "@/modules/observe/settings";

// The Behavior save REPLACES the whole `monitoring` block with what the form holds (issue #494), so
// a field the form does not carry is DELETED on the next save. Same guard the Memory block has.
describe("agent editor observation round-trip", () => {
  test("a configured watcher survives form → stored → form", () => {
    const stored = {
      monitoring: {
        analysis: "on_resolve",
        window: { messages: 30 },
        debounce: { windowSeconds: 10, maxWindowSeconds: 45 },
        labelGroups: [
          {
            name: "assunto",
            exclusive: true,
            values: ["cancelamento", "compra-de-ingresso"],
          },
          { name: "sinais", exclusive: false, values: ["urgente"] },
        ],
        noteOnChange: false,
      },
    };
    const round = observationToStored(observationToForm(stored));
    expect(round).toEqual(readMonitoringConfig(stored));
  });

  // An agent switched to monitoring and never configured stores the defaults it already ran on:
  // no group, so observation stays off, and the numbers the reader would have supplied anyway.
  test("an untouched bag round-trips to the reader's defaults", () => {
    expect(observationToStored(observationToForm({}))).toEqual(
      readMonitoringConfig({}),
    );
  });

  // The guard that catches the NEXT field: `monitoring` growing a key the form does not carry
  // fails here, when it is added, rather than as a value that disappears on an operator's save.
  test("the form carries every key the reader produces", () => {
    const written = Object.keys(
      observationToStored(observationToForm({})),
    ).sort();
    expect(written).toEqual(monitoringReaderKeys());
    expect(monitoringReaderKeys()).toEqual(
      Object.keys(readMonitoringConfig({})).sort(),
    );
  });

  // What the operator types is a box of lines; what the runtime reads is a list. Blank lines and
  // repeats are the editor's to drop, and a group with nothing to pick from is not a group.
  test("values are read per line, and an incomplete group is left out of the stored block", () => {
    const form = observationToForm({});
    form.groups = [
      { name: " assunto ", exclusive: true, values: "a\n\n b \na\n" },
      { name: "", exclusive: true, values: "x" },
      { name: "vazio", exclusive: false, values: " \n" },
    ];
    expect(groupIncomplete(form.groups[0] as never)).toBe(false);
    expect(groupIncomplete(form.groups[1] as never)).toBe(true);
    expect(groupIncomplete(form.groups[2] as never)).toBe(true);
    expect(observationToStored(form).labelGroups).toEqual([
      { name: "assunto", exclusive: true, values: ["a", "b"] },
    ]);
  });

  // A ceiling typed below the window is raised to it, the way the reader raises it on load, so the
  // form never stores what it would not read back.
  test("the burst ceiling never stores below the window", () => {
    const form = observationToForm({});
    form.windowSeconds = "40";
    form.maxWindowSeconds = "10";
    expect(observationToStored(form).debounce).toEqual({
      windowSeconds: 40,
      maxWindowSeconds: 40,
    });
  });
});

// WHAT IS SAVED IS WHAT WILL BE READ (issue #494 review, round 1). The numeric inputs carry
// `min`/`max`, which the browser enforces on submit and the ordinary Save button does not go
// through; a values box is capped in CHARACTERS, so a paste of short lines walks straight past the
// 40-value limit. Both cases used to be stored, answered "saved", and then silently narrowed by the
// reload that follows — the operator's screen and the runtime disagreeing about a configuration
// neither of them reported changing.
describe("the serializer stores only what the runtime will read", () => {
  const form = (over: Partial<ReturnType<typeof observationToForm>>) => ({
    ...observationToForm({}),
    ...over,
  });

  test("windows out of range are stored clamped, not as typed", () => {
    const out = observationToStored(
      form({
        windowMessages: "999",
        windowSeconds: "999",
        maxWindowSeconds: "999",
      }),
    );
    expect(out.window.messages).toBe(OBSERVATION_LIMITS.windowMessagesMax);
    expect(out.debounce.windowSeconds).toBe(OBSERVATION_LIMITS.secondsMax);
    expect(out.debounce.maxWindowSeconds).toBe(OBSERVATION_LIMITS.secondsMax);
    // ...and below the floor the same way, which is the direction a cleared-then-typed field takes.
    const low = observationToStored(
      form({ windowMessages: "1", windowSeconds: "0", maxWindowSeconds: "0" }),
    );
    expect(low.window.messages).toBe(OBSERVATION_LIMITS.windowMessagesMin);
    expect(low.debounce.windowSeconds).toBe(OBSERVATION_LIMITS.secondsMin);
  });

  test("a group longer than the cap is stored at the cap", () => {
    const many = Array.from({ length: 60 }, (_, i) => `v${i}`);
    const out = observationToStored(
      form({
        groups: [{ name: "assunto", exclusive: true, values: many.join("\n") }],
      }),
    );
    expect(out.labelGroups[0]?.values).toEqual(
      many.slice(0, OBSERVATION_LIMITS.valuesMax),
    );
  });

  // ...and more groups than the reader keeps are cut the same way, by the same call.
  test("more groups than the cap are stored at the cap", () => {
    const out = observationToStored(
      form({
        groups: Array.from({ length: 9 }, (_, i) => ({
          name: `g${i}`,
          exclusive: true,
          values: `v${i}`,
        })),
      }),
    );
    expect(out.labelGroups).toHaveLength(OBSERVATION_LIMITS.groupsMax);
  });
});

// ...AND WHAT THE SERVER REFUSES IS NOT NORMALIZED AWAY (issue #494 review, round 2). The write
// boundary rejects a duplicate group name, a value shared between groups, a reserved name and an
// over-long name or value, each with its own message. Passing the draft through the lenient reader
// first DELETED the offending entry and sent a bag the server was happy with, so the save succeeded,
// the group vanished, and nobody was told why — one silent narrowing traded for another.
describe("the serializer preserves what the write boundary judges", () => {
  const form = (over: Partial<ReturnType<typeof observationToForm>>) => ({
    ...observationToForm({}),
    ...over,
  });

  test("two groups with the same name reach the server", () => {
    const out = observationToStored(
      form({
        groups: [
          { name: "assunto", exclusive: true, values: "a" },
          { name: "assunto", exclusive: false, values: "b" },
        ],
      }),
    );
    expect(out.labelGroups.map((g) => g.name)).toEqual(["assunto", "assunto"]);
  });

  test("a value shared between groups reaches the server", () => {
    const out = observationToStored(
      form({
        groups: [
          { name: "a", exclusive: true, values: "x\ny" },
          { name: "b", exclusive: false, values: "x\nz" },
        ],
      }),
    );
    expect(out.labelGroups[1]?.values).toEqual(["x", "z"]);
  });

  test("a reserved name and an over-long value reach the server", () => {
    const long = "l".repeat(OBSERVATION_LIMITS.valueChars + 5);
    const out = observationToStored(
      form({
        groups: [
          // Reserved: the reader drops it, the server names it.
          { name: "agente-off", exclusive: true, values: "a" },
          { name: "assunto", exclusive: true, values: long },
        ],
      }),
    );
    expect(out.labelGroups.map((g) => g.name)).toEqual([
      "agente-off",
      "assunto",
    ]);
    expect(out.labelGroups[1]?.values).toEqual([long]);
  });
});
