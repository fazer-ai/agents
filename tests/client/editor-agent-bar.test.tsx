import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  editTab,
  NATIVE_CATALOG,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The editor's bottom bar is about the agent, not the tab (agents#1520): an edit on one tab keeps the
// bar dirty on every other, Save there writes it, and Discard there discards it.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const goTo = async (tab: string) => {
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  await screen.findByRole("tab", { name: tab, selected: true });
};
const save = () =>
  screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const discard = () => screen.queryByRole("button", { name: "Discard" });
const nameField = () => screen.getByLabelText(/^Name/) as HTMLInputElement;

describe("the editor's bar covers the whole agent", () => {
  test("an edit on General keeps the bar dirty on Tools, and Save there writes it", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    await renderEditor(stub, "general");
    editTab("general");
    await goTo("Tools");
    expect(save().disabled).toBe(false);
    expect(discard()).not.toBeNull();

    fireEvent.click(save());
    await waitFor(() => expect(stub.agent.name).toBe("Atendente (editado)"));
    // Only the edited section went out: the grants were not rewritten.
    expect(stub.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      `PATCH /api/v1/agents/${stub.agent.id}`,
    ]);
    await waitFor(() => expect(save().disabled).toBe(true));
    expect(discard()).toBeNull();
  });

  test("Discard on Tools asks first, then puts General back", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    await renderEditor(stub, "general");
    editTab("general");
    await goTo("Tools");
    fireEvent.click(discard() as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Discard all" }));
    await waitFor(() => expect(discard()).toBeNull());
    await goTo("General");
    expect(nameField().value).toBe("Atendente");
    expect(stub.writes).toEqual([]);
  });

  // A tab's own Save rule still holds, now for the whole save: pressed on Tools, it stops before any
  // write, names General and goes there.
  test("a section its own tab cannot save holds a save pressed on another tab", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: NATIVE_CATALOG },
    );
    await renderEditor(stub, "general");
    fireEvent.change(nameField(), { target: { value: "" } });
    await goTo("Tools");
    editTab("tools");
    fireEvent.click(save());
    await screen.findByText(/Fix the General tab before saving/);
    await screen.findByRole("tab", { name: "General", selected: true });
    expect(stub.writes).toEqual([]);
  });
});
