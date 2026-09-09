import { describe, expect, test } from "bun:test";
import {
  monitoringReaderKeys,
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
      },
    };
    expect(observationToStored(observationToForm(stored))).toEqual(
      readMonitoringConfig(stored),
    );
  });

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

  // A LABEL GROUP LEFT IN A STORED BAG IS NOT CARRIED FORWARD (issue #568). The taxonomy is gone,
  // and the save replaces the block, so an agent configured before this change loses it on the next
  // Behavior save — which is the intent: what it classified into now lives in its prompt.
  test("a stored taxonomy is not read back, and does not survive a save", () => {
    const legacy = {
      monitoring: {
        analysis: "incremental",
        labelGroups: [{ name: "assunto", exclusive: true, values: ["a", "b"] }],
        noteOnChange: false,
      },
    };
    const stored = observationToStored(observationToForm(legacy));
    expect(Object.keys(stored).sort()).toEqual(monitoringReaderKeys());
    expect(stored).not.toHaveProperty("labelGroups");
    expect(stored).not.toHaveProperty("noteOnChange");
  });

  // The numbers the server tolerates and the reader then narrows: shown narrowed immediately, so
  // the operator is never told "saved" while the runtime runs something else.
  test("an out-of-range window is normalized to what the reader keeps", () => {
    const form = observationToForm({
      monitoring: { window: { messages: 999 }, debounce: { windowSeconds: 1 } },
    });
    const stored = observationToStored(form);
    expect(stored.window.messages).toBe(60);
    expect(stored.debounce.windowSeconds).toBe(3);
    expect(stored.debounce.maxWindowSeconds).toBeGreaterThanOrEqual(
      stored.debounce.windowSeconds,
    );
  });
});
