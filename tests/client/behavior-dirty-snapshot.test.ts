import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  BEHAVIOR_BLOCKS,
  type BehaviorState,
  behaviorSnapshot,
  editedBlocks,
} from "@/client/pages/agents/behaviorSave";
import { lastSavedSettings, renderEditor } from "../utils/agent-editor";
import {
  changeTo,
  editEveryBlock,
  FIELD_EDITS,
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

  // Each edit `editEveryBlock` makes, alone on a fresh editor opened on STORED: it has to mark the tab
  // and enable Save, the save has to send it, and the post-save sync has to clear the mark.
  test("each block's edit alone marks the tab unsaved, is what the save sends, and saving clears the mark", async () => {
    await renderEditor(stubWithHours(), "behavior");
    const switchNames = screen
      .getAllByRole("switch")
      .map((s) => s.parentElement?.textContent ?? "");
    expect(switchNames.length).toBeGreaterThanOrEqual(14);
    cleanup();
    const edits = [
      ...FIELD_EDITS,
      ...switchNames.map((name, i) => ({
        name: `switch ${i} (${name})`,
        run: () => {
          fireEvent.click(screen.getAllByRole("switch")[i] as HTMLElement);
          // The gate turned on alone is refused by the save, so it is saved with an endpoint to ask.
          if (name.includes("Only answer authorized contacts")) {
            fireEvent.click(
              screen.getByRole("switch", { name: /Ask an external endpoint/ }),
            );
            changeTo(
              screen.getByLabelText(/^Authorization URL/) as HTMLInputElement,
              "https://auth.example.com/check",
            );
          }
        },
      })),
    ];
    const sent = new Set<string>();
    const failures: string[] = [];
    for (const edit of edits) {
      const stub = stubWithHours();
      const before = { ...stub.agent };
      await renderEditor(stub, "behavior");
      await edit.run();
      const marked = await waitFor(() => {
        if (screen.queryAllByText("Unsaved changes").length === 0)
          throw new Error("unmarked");
      }).then(
        () => true,
        () => false,
      );
      const save = screen.getByRole("button", { name: "Save" });
      if (!marked || save.hasAttribute("disabled")) {
        failures.push(`${edit.name}: not marked, or Save disabled`);
        cleanup();
        continue;
      }
      fireEvent.click(save);
      await waitFor(() =>
        expect(stub.writes.some((w) => w.method === "PATCH")).toBe(true),
      );
      const patch = stub.writes.find((w) => w.method === "PATCH")?.body ?? {};
      const settings = (patch.settings ?? {}) as Record<string, unknown>;
      const changed = [
        ...Object.keys(settings).filter(
          (k) => JSON.stringify(settings[k]) !== JSON.stringify(STORED[k]),
        ),
        ...["businessHoursId", "followUpHoursId"].filter(
          (k) => k in patch && patch[k] !== before[k],
        ),
      ];
      if (changed.length !== 1) {
        failures.push(`${edit.name}: sent ${JSON.stringify(changed)}`);
      }
      for (const k of changed) sent.add(k);
      await waitFor(() =>
        expect(screen.queryAllByText("Unsaved changes").length).toBe(0),
      );
      expect(save.hasAttribute("disabled"), `${edit.name}: Save after`).toBe(
        true,
      );
      cleanup();
    }
    expect(failures).toEqual([]);
    // Guards the loop: the single edits reach most blocks, not a couple.
    expect(sent.size).toBeGreaterThanOrEqual(18);
  }, 180_000);
});
