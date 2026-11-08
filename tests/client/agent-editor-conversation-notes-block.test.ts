import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The tools-used note through the editor: a stored block loads as stored, the operator's flip is what
// the save writes, and the next load reads it back.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const notesSwitch = () =>
  screen.getByRole("switch", {
    name: /Leave a note with the tools used in each turn/,
  });

describe("the agent editor carries the conversationNotes block through a Behavior save", () => {
  test("an agent with no block loads as OFF, and turning it on is saved and read back", async () => {
    const stub = stubEditorApi({ settings: {} });
    await renderEditor(stub, "behavior");
    expect(notesSwitch().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(notesSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastSavedSettings(stub)?.conversationNotes).toEqual({
        toolsUsed: true,
        errors: "off",
      }),
    );
    cleanup();
    await renderEditor(stub, "behavior");
    expect(notesSwitch().getAttribute("aria-checked")).toBe("true");
  });

  test("the errors format is saved as picked and read back, beside the tools-used switch", async () => {
    const stub = stubEditorApi({
      settings: { conversationNotes: { toolsUsed: true, errors: "note" } },
    });
    await renderEditor(stub, "behavior");
    const select = () =>
      screen.getByLabelText(
        /^Errors in the middle of a turn$/,
      ) as HTMLSelectElement;
    expect(select().value).toBe("note");
    fireEvent.change(select(), { target: { value: "activity" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastSavedSettings(stub)?.conversationNotes).toEqual({
        toolsUsed: true,
        errors: "activity",
      }),
    );
    cleanup();
    await renderEditor(stub, "behavior");
    expect(select().value).toBe("activity");
  });

  test("a stored ON loads as ON", async () => {
    const stub = stubEditorApi({
      settings: { conversationNotes: { toolsUsed: true } },
    });
    await renderEditor(stub, "behavior");
    expect(notesSwitch().getAttribute("aria-checked")).toBe("true");
  });
});
