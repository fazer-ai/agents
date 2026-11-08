import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The conversationNotes block through the editor: a stored block loads as stored (the old switch as
// the private note it posted), the operator's picks are what the save writes, and the next load reads
// them back.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const select = (label: RegExp) =>
  screen.getByLabelText(label) as HTMLSelectElement;
const TOOLS = /^Tools used in each turn$/;
const ERRORS = /^Errors in the middle of a turn$/;

describe("the agent editor carries the conversationNotes block through a Behavior save", () => {
  test("an agent with no block loads as off, and the picks are saved and read back", async () => {
    const stub = stubEditorApi({ settings: {} });
    await renderEditor(stub, "behavior");
    expect(select(TOOLS).value).toBe("off");
    expect(select(ERRORS).value).toBe("off");
    fireEvent.change(select(TOOLS), { target: { value: "activity" } });
    fireEvent.change(select(ERRORS), { target: { value: "note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastSavedSettings(stub)?.conversationNotes).toEqual({
        toolsUsed: "activity",
        errors: "note",
      }),
    );
    cleanup();
    await renderEditor(stub, "behavior");
    expect(select(TOOLS).value).toBe("activity");
    expect(select(ERRORS).value).toBe("note");
  });

  test("the switch stored before the formats loads as the private note, and saves as the format", async () => {
    const stub = stubEditorApi({
      settings: { conversationNotes: { toolsUsed: true } },
    });
    await renderEditor(stub, "behavior");
    expect(select(TOOLS).value).toBe("note");
    fireEvent.change(select(ERRORS), { target: { value: "activity" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastSavedSettings(stub)?.conversationNotes).toEqual({
        toolsUsed: "note",
        errors: "activity",
      }),
    );
  });
});
