import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  BEHAVIOR_BLOCKS,
  type BehaviorState,
  behaviorSnapshot,
  editedBlocks,
} from "@/client/pages/agents/behaviorSave";
import {
  editTab,
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The dirty snapshot (`sectionSnap.behavior`) lights the tab's dot, enables Discard and arms the
// navigation guard. A block the save writes and the snapshot does not read is edited with no dirty
// marker, and the edit is lost on leaving. Both read one declared list of blocks, so a block is
// saved only when it is also compared.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const state = (over: Partial<BehaviorState> = {}): BehaviorState => ({
  ...(Object.fromEntries(
    BEHAVIOR_BLOCKS.map((k) => [k, { enabled: false }]),
  ) as BehaviorState),
  ...over,
});

const AGENT_FIELDS = { businessHoursId: null, followUpHoursId: null };

describe("the Behavior tab's dirty snapshot", () => {
  test("every saved block is in the dirty snapshot, whatever shape it was written in", () => {
    const stored = state();
    // Every declared block, and one the type would refuse: what a save that slipped past it holds.
    const fromForm: Parameters<typeof editedBlocks>[0] = Object.fromEntries([
      ...BEHAVIOR_BLOCKS.map((k) => [k, { written: k }]),
      ["newBlock", { text: "nobody compares this" }],
    ]);
    for (const block of BEHAVIOR_BLOCKS) {
      const edited = state({ [block]: { enabled: true } });
      expect(
        behaviorSnapshot(edited, AGENT_FIELDS),
        `${block} is not in the snapshot`,
      ).not.toBe(behaviorSnapshot(stored, AGENT_FIELDS));
      expect(
        Object.keys(editedBlocks(fromForm, edited, stored, {})),
        `${block} is not the one block saved`,
      ).toEqual([block]);
    }
    // An undeclared block is never written: not when no state carries it, and not when one does and
    // it differs, since the snapshot would not read that state.
    expect(editedBlocks(fromForm, stored, stored, {})).toEqual({});
    const withNew = {
      ...stored,
      newBlock: { text: "edited" },
    } as BehaviorState;
    expect(editedBlocks(fromForm, withNew, stored, {})).toEqual({});
  });

  test("the fields saved outside the settings are in the snapshot too", () => {
    const base = behaviorSnapshot(state(), AGENT_FIELDS);
    expect(
      behaviorSnapshot(state(), { ...AGENT_FIELDS, businessHoursId: "bh-1" }),
    ).not.toBe(base);
    expect(behaviorSnapshot(state(), { ...AGENT_FIELDS })).toBe(base);
  });

  test("an edit marks the tab unsaved, the save writes that block alone, and saving clears the mark", async () => {
    const stub = stubEditorApi({ settings: {} });
    await renderEditor(stub, "behavior");
    expect(screen.queryAllByText("Unsaved changes").length).toBe(0);
    editTab("behavior");
    await waitFor(() =>
      expect(screen.queryAllByText("Unsaved changes").length).toBeGreaterThan(
        0,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Agent saved.");
    const saved = Object.keys(lastSavedSettings(stub) ?? {});
    expect(saved.length).toBe(1);
    expect(BEHAVIOR_BLOCKS as readonly string[]).toContain(saved[0] as string);
    await waitFor(() =>
      expect(screen.queryAllByText("Unsaved changes").length).toBe(0),
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
