/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  type EditorStub,
  editTab,
  NATIVE_CATALOG,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// One Save of the bar says one thing: that the agent was saved, once the whole plan is written, or,
// when it stops after writing part of it, which sections were saved and which are still pending.
// A save of a single section keeps that section's own message.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// How many toasts carry a sentence: each is an item of the toast viewport's list (the screen reader's
// copy of the sentence is not one).
const shown = (text: string) =>
  [...document.querySelectorAll("ol > li")].filter((toast) =>
    toast.textContent?.includes(text),
  ).length;

async function goTo(name: RegExp) {
  fireEvent.click(screen.getByRole("tab", { name }));
  await act(async () => {});
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => {});
}

// General, Behavior and Guardrails edited, then Save pressed on Guardrails.
async function editThree(stub: EditorStub) {
  await renderEditor(stub, "general");
  editTab("general");
  await goTo(/^Behavior/);
  editTab("behavior");
  await goTo(/^Guardrails/);
  editTab("guardrails");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

const PATCHES = (stub: EditorStub) =>
  stub.writes.filter((w) => w.method === "PATCH").length;

describe("one Save, one message", () => {
  test("three sections written: one success message", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    await editThree(stub);
    await waitFor(() => expect(PATCHES(stub)).toBe(3));
    await settle();
    expect(shown("Agent saved.")).toBe(1);
  });

  test("General and Tools written: one success message, and not the Tools one", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: NATIVE_CATALOG },
    );
    await renderEditor(stub, "general");
    editTab("general");
    await goTo(/^Tools/);
    editTab("tools");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(PATCHES(stub)).toBe(2));
    await settle();
    expect(shown("Agent saved.")).toBe(1);
    expect(shown("Tools updated.")).toBe(0);
  });

  test("a section refused after another was written: what was saved and what is pending", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    let n = 0;
    stub.override = (method, path) => {
      if (method !== "PATCH" || path !== "/api/v1/agents/41") return;
      n += 1;
      if (n === 2) return json({ error: "Refused by the server." }, 422);
    };
    await editThree(stub);
    await screen.findByText("Saved: General. Not saved: Behavior, Guardrails.");
    await settle();
    expect(shown("Agent saved.")).toBe(0);
  });

  test("the first section refused: nothing was saved, and no message says so", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    stub.override = (method, path) => {
      if (method === "PATCH" && path === "/api/v1/agents/41")
        return json({ error: "Refused by the server." }, 422);
    };
    await editThree(stub);
    await waitFor(() => expect(PATCHES(stub)).toBe(1));
    await settle();
    expect(shown("Agent saved.")).toBe(0);
    expect(shown("Saved:")).toBe(0);
  });

  test("a single section keeps its own message", async () => {
    const stub = stubEditorApi({}, { catalog: NATIVE_CATALOG });
    await renderEditor(stub, "tools");
    editTab("tools");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Tools updated.");
    await settle();
    expect(shown("Tools updated.")).toBe(1);
    expect(shown("Agent saved.")).toBe(0);
  });
});
