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

  // A hold is judged when its tab is drawn, and what it reads can change while it is not: here the
  // fallback model is checked only on the language model. Switched to questions and rules on General,
  // the save goes to Behavior to judge again, finds nothing holding it, and writes.
  test("a hold that no longer stands on its tab does not stop the save", async () => {
    const stub = stubEditorApi({
      name: "Observador",
      mode: "monitoring",
      settings: {
        modelFallback: { provider: "gemini", model: "" },
        monitoring: {
          engine: "llm",
          decisions: {
            provider: "typesafe",
            credentialRef: "vault:12",
            questions: [
              { name: "pede_reembolso", type: "yes_no", instructions: "Pede?" },
            ],
            rules: [
              {
                when: [{ question: "pede_reembolso", minProbability: 0.7 }],
                action: { tool: "set_labels", args: { add: ["reembolso"] } },
              },
            ],
          },
        },
      },
    });
    await renderEditor(stub, "behavior");
    editTab("behavior");
    await waitFor(() => expect(save().disabled).toBe(true));
    await goTo("General");
    fireEvent.click(
      await waitFor(() => {
        const el = document.querySelector<HTMLElement>(
          '[data-testid="engine-decisions"]',
        );
        if (!el) throw new Error("the engine cards are not there yet");
        return el;
      }),
    );
    fireEvent.click(save());
    await waitFor(() =>
      expect(stub.writes.some((w) => w.method === "PATCH")).toBe(true),
    );
    expect(screen.queryByText(/Fix the Behavior tab/)).toBeNull();
  });

  // A watcher draws no Guardrails tab: an edit made there before the switch to Monitoring is not
  // written by the save that switches, and the save says so instead of reading as done.
  test("an edit on a tab the new mode does not draw stays unsaved, and the save says so", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    await renderEditor(stub, "guardrails");
    editTab("guardrails");
    await goTo("General");
    fireEvent.click(screen.getByRole("radio", { name: /^Monitoring/ }));
    fireEvent.click(save());
    await screen.findByText(/Changes on Guardrails were not saved/);
    const written = stub.writes.filter((w) => w.method === "PATCH");
    expect(written.length).toBe(1);
    expect(
      (written[0]?.body.settings as { guardrails?: unknown } | undefined)
        ?.guardrails,
    ).toBeUndefined();
    expect(save().disabled).toBe(false);
  });

  // The Tools write replaces the shared grant set when it lands. A Knowledge edit made while it was out
  // is newer than what it wrote, so it stays on screen, and unsaved.
  test("a Knowledge edit made while the Tools write is out survives it", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      {
        catalog: {
          ...NATIVE_CATALOG,
          rag: [{ name: "search_knowledge" }, { name: "suggest_kb_entry" }],
          knowledgeBases: [{ id: "5", name: "FAQ" }],
        },
      },
    );
    const served = globalThis.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let putSent = false;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "PUT" && !putSent) {
        putSent = true;
        await held;
      }
      return served(input, init);
    }) as typeof fetch;
    await renderEditor(stub, "tools");
    editTab("tools");
    await goTo("Knowledge");
    const retrieval = () =>
      screen.getByRole("switch", { name: "Enable knowledge retrieval" });
    const before = retrieval().getAttribute("aria-checked");
    fireEvent.click(save());
    await waitFor(() => expect(putSent).toBe(true));
    fireEvent.click(retrieval());
    release();
    await screen.findByText("Tools updated.");
    expect(retrieval().getAttribute("aria-checked")).not.toBe(before);
    expect(
      screen
        .getByRole("tab", { name: /Knowledge/ })
        .querySelector(".bg-warning"),
    ).not.toBeNull();
  });

  // The decision setup goes out with General whichever tab draws it: switched to the language model,
  // the save writes it and says nothing about Questions and rules being left behind.
  test("switching a watcher to the language model saves without a left-behind warning", async () => {
    const stub = stubEditorApi({
      name: "Observador",
      mode: "monitoring",
      settings: {
        monitoring: {
          engine: "decisions",
          decisions: {
            provider: "typesafe",
            credentialRef: "vault:12",
            questions: [
              { name: "pede_reembolso", type: "yes_no", instructions: "Pede?" },
            ],
            rules: [
              {
                when: [{ question: "pede_reembolso", minProbability: 0.7 }],
                action: { tool: "set_labels", args: { add: ["reembolso"] } },
              },
            ],
          },
        },
      },
    });
    await renderEditor(stub, "general");
    fireEvent.click(
      await waitFor(() => {
        const el = document.querySelector<HTMLElement>(
          '[data-testid="engine-llm"]',
        );
        if (!el) throw new Error("the engine cards are not there yet");
        return el;
      }),
    );
    fireEvent.click(save());
    await waitFor(() =>
      expect(stub.writes.some((w) => w.method === "PATCH")).toBe(true),
    );
    await waitFor(() => expect(save().disabled).toBe(true));
    expect(screen.queryByText(/were not saved/)).toBeNull();
  });
});
