import { describe, expect, test } from "bun:test";
import {
  monitoringReaderKeys,
  OBSERVATION_LIMITS,
  observationToForm,
  observationToStored,
} from "@/client/pages/agents/observationFormState";
import { readMonitoringConfig } from "@/modules/observe/settings";

// The Behavior save REPLACES the whole `monitoring` block with what the form holds, so a field the
// form does not carry is DELETED on the next save. Same guard the Memory block has.
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

  // NOTE: A label group left in a stored bag is not carried forward: the taxonomy no longer exists, and
  // the save replaces the block, so the next Behavior save drops it (what it classified into lives
  // in the prompt).
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
      monitoring: {
        window: { messages: 999 },
        debounce: { windowSeconds: 9_999 },
      },
    });
    const stored = observationToStored(form);
    expect(stored.window.messages).toBe(60);
    expect(stored.debounce.windowSeconds).toBe(600);
    expect(stored.debounce.maxWindowSeconds).toBeGreaterThanOrEqual(
      stored.debounce.windowSeconds,
    );
  });

  // The window goes down to zero, which is a setting and not a floor.
  test("a window of 0, 1 or 2 is offered and saved as typed", () => {
    expect(OBSERVATION_LIMITS.secondsMin).toBe(0);
    for (const seconds of ["0", "1", "2"]) {
      const form = {
        ...observationToForm({}),
        windowSeconds: seconds,
      };
      const stored = observationToStored(form);
      expect(stored.debounce.windowSeconds).toBe(Number(seconds));
      expect(observationToForm({ monitoring: stored }).windowSeconds).toBe(
        seconds,
      );
    }
  });

  // Rounded first, -0.5 is a zero and the refusal never happens.
  test("a negative fraction travels unrounded", () => {
    for (const typed of ["-0.5", "-0.1", " -2.4 "]) {
      const stored = observationToStored({
        ...observationToForm({}),
        windowSeconds: typed,
      });
      expect(stored.debounce.windowSeconds).toBe(Number(typed));
      expect(stored.debounce.windowSeconds).toBeLessThan(0);
    }
  });

  test("an emptied or unreadable window is still the default, never a negative", () => {
    for (const typed of ["", "  ", "abc", "-"]) {
      const stored = observationToStored({
        ...observationToForm({}),
        windowSeconds: typed,
      });
      expect(stored.debounce.windowSeconds).toBe(20);
    }
  });
});
