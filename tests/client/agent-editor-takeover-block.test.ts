import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The Behavior save REPLACES each block it names, so a block the save bag stops naming is DELETED
// on the next save and the reader projects its default. For `takeover` that default is ON, so an
// operator's step-back OFF would silently come back on.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const takeoverSwitch = () =>
  screen.getByRole("switch", {
    name: /Stop answering when a person replies to the customer/,
  });

async function saveBehavior() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("the agent editor carries the takeover block through a Behavior save", () => {
  test("a stored OFF loads as OFF and is saved as OFF", async () => {
    const stub = stubEditorApi({
      settings: { takeover: { onHumanReply: false } },
    });
    await renderEditor(stub, "behavior");
    expect(takeoverSwitch().getAttribute("aria-checked")).toBe("false");
    await saveBehavior();
    await waitFor(() => expect(lastSavedSettings(stub)).toBeDefined());
    expect(lastSavedSettings(stub)?.takeover).toEqual({ onHumanReply: false });
  });

  test("an agent with no block loads as ON, and an operator's OFF is what the next load reads", async () => {
    const stub = stubEditorApi({ settings: {} });
    await renderEditor(stub, "behavior");
    expect(takeoverSwitch().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(takeoverSwitch());
    await saveBehavior();
    await waitFor(() =>
      expect(lastSavedSettings(stub)?.takeover).toEqual({
        onHumanReply: false,
      }),
    );
    cleanup();
    await renderEditor(stub, "behavior");
    expect(takeoverSwitch().getAttribute("aria-checked")).toBe("false");
  });
});
