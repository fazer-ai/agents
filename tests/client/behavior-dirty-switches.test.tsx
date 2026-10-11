import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

// Every block the Behavior save writes has to be in the tab's dirty snapshot: one left out is an edit
// the editor does not call unsaved, so leaving the page drops it without asking. Each block's own
// switch is the one edit every block shares, so each is flipped on a fresh editor and the page must
// say it has unsaved changes.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const switches = () => screen.queryAllByRole("switch");

describe("the Behavior tab's dirty snapshot", () => {
  // One full editor render per switch (15 today): close to the default 5s on a quiet machine, so the
  // timeout below keeps a loaded machine from failing it with nothing wrong.
  test("every switch the Behavior tab draws marks the page unsaved", async () => {
    await renderEditor(stubEditorApi({}), "behavior");
    const names = switches().map((s) => s.parentElement?.textContent ?? "");
    // Guards the loop: a render that drew no switch would pass every case below.
    expect(names.length).toBeGreaterThanOrEqual(14);
    cleanup();

    for (let i = 0; i < names.length; i++) {
      await renderEditor(stubEditorApi({}), "behavior");
      expect(screen.queryAllByText("Unsaved changes").length).toBe(0);
      fireEvent.click(switches()[i] as HTMLElement);
      await waitFor(() =>
        expect(
          screen.queryAllByText("Unsaved changes").length,
          `switch ${i} (${names[i]})`,
        ).toBeGreaterThan(0),
      );
      cleanup();
    }
  }, 60_000);
});
