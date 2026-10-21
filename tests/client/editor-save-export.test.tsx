/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { PROTECTED_LABELS_MAX } from "@/modules/agents/tool-guidance";
import {
  type EditorStub,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// "Save and export" runs the bar's save: the same plan, checks and lock, every hold judged before the
// first write, and the file asked for only once every section is written. Its dialog cannot be closed
// while it writes, and it refuses a draft the save would leave pending, since the file would lack it.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const nameField = () => screen.getByLabelText(/^Name/) as HTMLInputElement;
const writes = (stub: EditorStub) =>
  stub.writes.filter((w) => w.method !== "GET");
const exported = (stub: EditorStub) =>
  stub.requests.some((r) => r.endsWith("/export"));

// Holds the first PATCH until `release` is called.
function holdFirstPatch() {
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
    }
    return served(input, init);
  }) as typeof fetch;
  return state;
}

async function openExport(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  return await screen.findByRole("dialog");
}

const saveAndExport = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", {
    name: "Save and export",
  }) as HTMLButtonElement;

async function goTo(name: RegExp) {
  fireEvent.click(screen.getByRole("tab", { name }));
  await act(async () => {});
}

describe("Save and export", () => {
  test("cannot be closed while it writes, and asks for the file after the writes", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    const patch = holdFirstPatch();
    await renderEditor(stub, "general");
    fireEvent.change(nameField(), { target: { value: "Recepção" } });
    const dialog = await openExport();
    fireEvent.click(saveAndExport(dialog));
    await waitFor(() => expect(patch.sent).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog") === null).toBe(false);
    expect(exported(stub)).toBe(false);
    patch.release();
    await waitFor(() => expect(exported(stub)).toBe(true));
    const lastWrite = stub.requests.findLastIndex((r) => r.startsWith("PATCH"));
    const file = stub.requests.findIndex((r) => r.endsWith("/export"));
    expect(lastWrite).toBeLessThan(file);
    expect(stub.agent.name).toBe("Recepção");
  });

  test("does not run beside a save of the bar", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    const patch = holdFirstPatch();
    await renderEditor(stub, "general");
    fireEvent.change(nameField(), { target: { value: "Recepção" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch.sent).toBe(true));
    const dialog = await openExport();
    expect(saveAndExport(dialog).disabled).toBe(true);
    fireEvent.click(saveAndExport(dialog));
    patch.release();
    await waitFor(() => expect(stub.agent.name).toBe("Recepção"));
    await act(async () => {});
    expect(writes(stub).length).toBe(1);
    expect(exported(stub)).toBe(false);
  });

  // Two presses inside one batch reach the handler before the button re-renders disabled: the second
  // finds the first save running and starts nothing.
  test("a second press while a save is starting starts no second save", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    const patch = holdFirstPatch();
    await renderEditor(stub, "general");
    fireEvent.change(nameField(), { target: { value: "Recepção" } });
    const save = screen.getByRole("button", { name: "Save" });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await waitFor(() => expect(patch.sent).toBe(true));
    patch.release();
    await waitFor(() => expect(stub.agent.name).toBe("Recepção"));
    await act(async () => {});
    expect(writes(stub).length).toBe(1);
  });

  test("refuses a Guardrails draft the agent's mode hides, before any write", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    await renderEditor(stub, "guardrails");
    fireEvent.click(screen.getByRole("switch", { name: /Enable guardrails/ }));
    await goTo(/^General/);
    fireEvent.click(screen.getByRole("radio", { name: /^Monitoring/ }));
    const dialog = await openExport();
    fireEvent.click(saveAndExport(dialog));
    await screen.findByText(/would not be in the file/);
    await act(async () => {});
    expect(writes(stub)).toEqual([]);
    expect(exported(stub)).toBe(false);
  });

  test("a Tools check that fails holds General's write too", async () => {
    const LABELS = { native: [{ name: "set_labels" }] };
    const stub = stubEditorApi(
      { name: "Atendente" },
      {
        catalog: LABELS,
        grants: [
          {
            source: "NATIVE",
            enabledTools: ["set_labels"],
            knowledgeBaseIds: [],
          },
        ],
      },
    );
    await renderEditor(stub, "tools");
    fireEvent.click(
      screen.getByRole("button", { name: "Settings", expanded: false }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Labels off limits" }),
      {
        target: {
          value: Array.from(
            { length: PROTECTED_LABELS_MAX + 1 },
            (_, i) => `l${i}`,
          ).join(", "),
        },
      },
    );
    await goTo(/^General/);
    fireEvent.change(nameField(), { target: { value: "Recepção" } });
    const dialog = await openExport();
    fireEvent.click(saveAndExport(dialog));
    await screen.findAllByText(
      new RegExp(`takes at most ${PROTECTED_LABELS_MAX} labels`),
    );
    await act(async () => {});
    expect(writes(stub)).toEqual([]);
    expect(exported(stub)).toBe(false);
  });

  test("a reviewer with no endpoint holds the export, before any write", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: { native: [{ name: "open_case_in_inbox" }] } },
    );
    await renderEditor(stub, "knowledge");
    const select = document
      .getElementById("kb-review")
      ?.querySelector("select") as HTMLSelectElement;
    const compatible = [...select.options].find((o) =>
      /compatible/i.test(o.textContent ?? ""),
    );
    if (!compatible) throw new Error("no OpenAI-compatible option");
    fireEvent.change(select, { target: { value: compatible.value } });
    await act(async () => {});
    await goTo(/^General/);
    fireEvent.change(nameField(), { target: { value: "Recepção" } });
    const dialog = await openExport();
    fireEvent.click(saveAndExport(dialog));
    await waitFor(() =>
      expect(
        screen.getAllByText(/cannot be saved as it is/).length,
      ).toBeGreaterThan(0),
    );
    await act(async () => {});
    expect(writes(stub)).toEqual([]);
    expect(exported(stub)).toBe(false);
  });
});
