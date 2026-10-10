import { describe, expect, test } from "bun:test";
import {
  monitoringPatch,
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
    const { decisions: _none, ...read } = readMonitoringConfig(stored);
    expect(observationToStored(observationToForm(stored))).toEqual(read);
  });

  // A key the bag never had stays absent: the reader answers `decisions: null` for a missing key,
  // and writing that null back would store a key nobody set.
  test("an untouched bag round-trips to the reader's defaults", () => {
    const { decisions, ...defaults } = readMonitoringConfig({});
    expect(decisions).toBeNull();
    const written = observationToStored(observationToForm({}));
    expect(written).toEqual(defaults);
    expect(written).not.toHaveProperty("decisions");
    // ...and the runtime reads what was written exactly as it read the empty bag.
    expect(readMonitoringConfig({ monitoring: written })).toEqual(
      readMonitoringConfig({}),
    );
  });

  // `decisions` is the one key written only when there is a block to write; with one, the form
  // carries every key the reader produces, so the next field it grows fails here.
  test("a stored decisions block is written back with every reader key", () => {
    const written = Object.keys(
      observationToStored(
        observationToForm({ monitoring: { decisions: { apply: "shadow" } } }),
      ),
    ).sort();
    expect(written).toEqual(monitoringReaderKeys());
    expect(monitoringReaderKeys()).toEqual(
      Object.keys(readMonitoringConfig({})).sort(),
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
    expect(Object.keys(stored).sort()).toEqual(
      monitoringReaderKeys().filter((k) => k !== "decisions"),
    );
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

  // The save replaces `monitoring` for an agent that HAS the block or is a watcher. An answering
  // agent whose settings never carried it saves without it: an unchanged save writes nothing new.
  test("an answering agent with no monitoring block saves without one", () => {
    expect(monitoringPatch(observationToForm({}), false)).toEqual({});
    expect(monitoringPatch(observationToForm({ other: 1 }), false)).toEqual({});
    expect(monitoringPatch(observationToForm(null), false)).toEqual({});
  });

  test("a watcher, or an agent that already has the block, writes it", () => {
    const fresh = observationToForm({});
    expect(monitoringPatch(fresh, true)).toEqual({
      monitoring: observationToStored(fresh, true),
    });
    const stored = { monitoring: { analysis: "on_resolve" } };
    const had = observationToForm(stored);
    expect(monitoringPatch(had, false)).toEqual({
      monitoring: observationToStored(had, false),
    });
    expect(monitoringPatch(had, false).monitoring?.analysis).toBe("on_resolve");
    // An empty block is still a block the agent had.
    expect(
      monitoringPatch(observationToForm({ monitoring: {} }), false),
    ).toHaveProperty("monitoring");
  });

  test("a watcher on the model engine with no block stores no decisions key", () => {
    const stored = { monitoring: { engine: "llm", analysis: "incremental" } };
    const patch = monitoringPatch(observationToForm(stored), true);
    expect(patch.monitoring).not.toHaveProperty("decisions");
    expect(patch.monitoring?.engine).toBe("llm");
    expect(JSON.stringify(patch)).not.toContain("decisions");
  });
});
