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
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The two ways out of the editor while a save's request is out. A discard confirmed then waits for
// the answer and puts the form back from what the server holds after it, and stops what the save
// had left to write. Leaving the editor ends the save: a late answer opens no tab.

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

const discard = () => screen.queryByRole("button", { name: "Discard" });
const nameField = () => screen.getByLabelText(/^Name/) as HTMLInputElement;

// Holds the first PATCH until `release` is called, then answers it with `answer` (or the stub's).
function holdFirstPatch(stub: EditorStub, answer?: () => Response) {
  const served = globalThis.fetch;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const state = { sent: false, release: () => release() };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PATCH" && !state.sent) {
      state.sent = true;
      await held;
      if (answer) {
        stub.writes.push({ method: "PATCH", path: "", body: {} });
        return answer();
      }
    }
    return served(input, init);
  }) as typeof fetch;
  return state;
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

async function confirmDiscard() {
  fireEvent.click(discard() as HTMLElement);
  fireEvent.click(await screen.findByRole("button", { name: "Discard all" }));
}

describe("Discard while a save's request is out", () => {
  test("a write that lands: the form shows what the server holds, with nothing unsaved", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    const patch = holdFirstPatch(stub);
    await renderEditor(stub, "general");
    fireEvent.change(nameField(), { target: { value: "Recepção" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch.sent).toBe(true));
    await confirmDiscard();
    patch.release();
    await settle();
    expect(stub.agent.name).toBe("Recepção");
    expect(nameField().value).toBe("Recepção");
    expect(discard() === null).toBe(true);
  });

  test("a write that fails: the form shows the stored copy, with nothing unsaved", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    const patch = holdFirstPatch(stub, () =>
      json({ error: "Refused by the server." }, 422),
    );
    await renderEditor(stub, "general");
    fireEvent.change(nameField(), { target: { value: "Recepção" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch.sent).toBe(true));
    await confirmDiscard();
    patch.release();
    await settle();
    expect(stub.agent.name).toBe("Atendente");
    expect(nameField().value).toBe("Atendente");
    expect(discard() === null).toBe(true);
  });

  test("what the save had left to write is not sent", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    const patch = holdFirstPatch(stub);
    await renderEditor(stub, "general");
    fireEvent.change(nameField(), { target: { value: "Recepção" } });
    fireEvent.click(screen.getByRole("tab", { name: "Guardrails" }));
    fireEvent.click(
      await screen.findByRole("switch", { name: /Enable guardrails/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch.sent).toBe(true));
    await confirmDiscard();
    patch.release();
    await settle();
    expect(stub.writes.filter((w) => w.method === "PATCH").length).toBe(1);
    expect(stub.agent.settings).toEqual({});
    expect(discard() === null).toBe(true);
  });
});

describe("Leaving the editor while a save's request is out", () => {
  for (const [name, answer] of [
    ["fails", () => json({ error: "Refused by the server." }, 422)],
    ["lands", undefined],
  ] as const) {
    test(`a write that ${name} after the editor is left opens no tab`, async () => {
      const stub = stubEditorApi({ name: "Atendente" });
      const patch = holdFirstPatch(stub, answer);
      await renderEditor(stub, "general");
      fireEvent.change(nameField(), { target: { value: "Recepção" } });
      fireEvent.click(screen.getByRole("tab", { name: "Guardrails" }));
      fireEvent.click(
        await screen.findByRole("switch", { name: /Enable guardrails/ }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(patch.sent).toBe(true));
      fireEvent.click(screen.getByRole("link", { name: "Back to agents" }));
      await screen.findByText("Agents list");
      patch.release();
      await settle();
      expect(screen.queryByText("Agents list")).not.toBeNull();
      // NOTE: the Guardrails write after General's is the save's, and it ended with the editor.
      expect(stub.writes.filter((w) => w.method === "PATCH").length).toBe(1);
    });
  }
});
