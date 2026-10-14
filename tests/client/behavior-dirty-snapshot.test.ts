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
import {
  editEveryBlock,
  STORED,
  stubWithHours,
} from "../utils/behavior-blocks";

// The dirty snapshot (`sectionSnap.behavior`) lights the tab's dot, enables Discard and arms the
// navigation guard. A block the save writes and the snapshot does not read is edited with no dirty
// marker, and the edit is lost on leaving. Asked of every block the rendered editor writes.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const AGENT_FIELDS = { businessHoursId: null, followUpHoursId: null };

// One value per block over the given keys: the state a snapshot or a save reads.
const stateOver = (
  keys: Iterable<string>,
  over: Record<string, unknown> = {},
) =>
  ({
    ...Object.fromEntries([...keys].map((k) => [k, { enabled: false }])),
    ...over,
  }) as BehaviorState;

const state = (over: Partial<BehaviorState> = {}) =>
  stateOver(BEHAVIOR_BLOCKS, over);

// The blocks the rendered editor writes when every block of the tab is edited through its own control:
// read off the PATCH, so it does not depend on the declared list.
async function blocksTheEditorWrites(): Promise<string[]> {
  const stub = stubWithHours();
  await renderEditor(stub, "behavior");
  await editEveryBlock();
  // The gate turned on with no condition and no endpoint is refused by the save; off, it saves.
  fireEvent.click(
    screen.getByRole("switch", { name: /Only answer authorized contacts/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(lastSavedSettings(stub)).toBeDefined());
  const saved = lastSavedSettings(stub) ?? {};
  return Object.keys(saved).filter(
    (k) => JSON.stringify(saved[k]) !== JSON.stringify(STORED[k]),
  );
}

describe("the Behavior tab's dirty snapshot", () => {
  test("every saved block is in the dirty snapshot, whatever shape it was written in", async () => {
    const written = await blocksTheEditorWrites();
    // Guards the loop: an editor that wrote nothing would pass every case below.
    expect(written.length).toBeGreaterThanOrEqual(18);
    const keys = new Set([
      ...written,
      ...Object.keys(STORED),
      ...BEHAVIOR_BLOCKS,
      "newBlock",
    ]);
    const stored = stateOver(keys);
    const fromForm: Parameters<typeof editedBlocks>[0] = Object.fromEntries(
      [...keys].map((k) => [k, { written: k }]),
    );
    for (const block of keys) {
      const edited = stateOver(keys, { [block]: { enabled: true } });
      const saves = Object.keys(editedBlocks(fromForm, edited, stored, {}));
      if (written.includes(block)) {
        expect(saves, `${block} is written by the editor`).toEqual([block]);
      }
      if (saves.includes(block)) {
        expect(
          behaviorSnapshot(edited, AGENT_FIELDS),
          `${block} is saved and not in the snapshot`,
        ).not.toBe(behaviorSnapshot(stored, AGENT_FIELDS));
      }
    }
    // An undeclared block is never written, even when its state differs.
    expect(
      editedBlocks(
        fromForm,
        stateOver(keys, { newBlock: { text: "edited" } }),
        stored,
        {},
      ),
    ).toEqual({});
  }, 30_000);

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
