import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { invalidateVault } from "@/client/lib/vaultCache";
import { nativeToolAnchor } from "@/client/pages/agents/editorTabs";
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

  // The save replaces the shared grant set when it lands. A Knowledge edit made while it was out is
  // newer than what it wrote, so it stays on screen, and unsaved.
  test("a Knowledge edit made while the save is out survives it", async () => {
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
      if ((init?.method ?? "GET") === "PATCH" && !putSent) {
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
    await screen.findByText("Agent saved.");
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

  // Behavior judges its fallback against the model this save writes, General's draft: a fallback that
  // inherited the old provider's endpoint has none under the new one, so Behavior holds the whole save
  // and General is not written either.
  test("a hold General's draft creates on another tab keeps the whole save back", async () => {
    const stub = stubEditorApi({
      name: "Atendente",
      modelConfig: {
        provider: "openai-compatible",
        model: "m",
        baseURL: "https://llm.example.com/v1",
      },
      settings: {
        modelFallback: {
          provider: "openai-compatible",
          model: "m",
          baseURL: null,
        },
      },
    });
    await renderEditor(stub, "behavior");
    editTab("behavior");
    await waitFor(() => expect(save().disabled).toBe(false));
    await goTo("General");
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "openai" },
    });
    fireEvent.click(save());
    await screen.findByText(/Fix the Behavior tab before saving/, undefined, {
      timeout: 5_000,
    });
    expect(stub.writes.filter((w) => w.method === "PATCH")).toEqual([]);
  });

  // The engine cards are General's even when only the decision setup changed: General's own hold (an
  // endpoint that is not a URL) stops a save pressed on Tools, and the switch is not written.
  test("General's hold covers an engine switch saved from another tab", async () => {
    const stub = stubEditorApi(
      {
        name: "Observador",
        mode: "monitoring",
        modelConfig: {
          provider: "openai-compatible",
          model: "m",
          baseURL: "not a url",
        },
        settings: {
          monitoring: {
            engine: "decisions",
            decisions: {
              provider: "typesafe",
              credentialRef: "vault:12",
              questions: [
                {
                  name: "pede_reembolso",
                  type: "yes_no",
                  instructions: "Pede?",
                },
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
      },
      { catalog: NATIVE_CATALOG },
    );
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
    await waitFor(() => expect(save().disabled).toBe(true));
    await goTo("Tools");
    editTab("tools");
    fireEvent.click(save());
    await screen.findByText(/Fix the General tab before saving/);
    expect(stub.writes).toEqual([]);
  });

  // Behavior judges its fallback against General's draft: a fallback that had no endpoint to inherit
  // under the stored provider inherits the new one, and the whole save goes through.
  test("a hold General's draft resolves on another tab does not stop the save", async () => {
    const stub = stubEditorApi({
      name: "Atendente",
      modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      settings: {
        modelFallback: {
          provider: "openai-compatible",
          model: "m",
          baseURL: null,
        },
      },
    });
    await renderEditor(stub, "behavior");
    editTab("behavior");
    await waitFor(() => expect(save().disabled).toBe(true));
    await goTo("General");
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "openai-compatible" },
    });
    fireEvent.change(await screen.findByLabelText("Base URL"), {
      target: { value: "https://llm.example.com/v1" },
    });
    fireEvent.click(save());
    await waitFor(
      () =>
        expect(stub.writes.filter((w) => w.method === "PATCH").length).toBe(1),
      { timeout: 5_000 },
    );
    expect(screen.queryByText(/Fix the Behavior tab/)).toBeNull();
    await screen.findByRole("tab", { name: "General", selected: true });
  });

  // The save went to Behavior to judge it again, then sent its write; the operator who moves to Tools
  // while it is out stays there, though the save would have taken them back from Behavior.
  test("a tab chosen while the write is out is kept after a recheck trip", async () => {
    const stub = stubEditorApi({
      name: "Atendente",
      modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      settings: {
        modelFallback: {
          provider: "openai-compatible",
          model: "m",
          baseURL: null,
        },
      },
    });
    await renderEditor(stub, "behavior");
    editTab("behavior");
    await waitFor(() => expect(save().disabled).toBe(true));
    await goTo("General");
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "openai-compatible" },
    });
    fireEvent.change(await screen.findByLabelText("Base URL"), {
      target: { value: "https://llm.example.com/v1" },
    });
    const served = globalThis.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let patchSent = false;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "PATCH" && !patchSent) {
        patchSent = true;
        await held;
      }
      return served(input, init);
    }) as typeof fetch;
    fireEvent.click(save());
    await waitFor(() => expect(patchSent).toBe(true), { timeout: 5_000 });
    await goTo("Tools");
    release();
    await screen.findByText("Agent saved.");
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(
      screen.getByRole("tab", { name: "Tools" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  // The save writes what was edited when Save was pressed. A General edit made while it is out stays
  // pending, on screen, and the answer does not overwrite it.
  test("a General edit made while the save is out stays pending", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: NATIVE_CATALOG },
    );
    const served = globalThis.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let patchSent = false;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "PATCH" && !patchSent) {
        patchSent = true;
        await held;
      }
      return served(input, init);
    }) as typeof fetch;
    await renderEditor(stub, "tools");
    editTab("tools");
    await goTo("General");
    editTab("general");
    fireEvent.click(save());
    await waitFor(() => expect(patchSent).toBe(true));
    fireEvent.change(nameField(), { target: { value: "Outro nome" } });
    release();
    await screen.findByText("Agent saved.");
    const names = stub.writes
      .filter((w) => w.method === "PATCH" && "name" in w.body)
      .map((w) => w.body.name);
    expect(names).toEqual(["Atendente (editado)"]);
    expect(nameField().value).toBe("Outro nome");
    expect(save().disabled).toBe(false);
  });

  // The vault answers on its own clock. Its answer, arriving after Behavior was left, makes the
  // fallback's credential send an endpoint Anthropic never dials: the save goes back to Behavior to
  // judge it again, and stops there.
  test("a hold the vault's late answer creates on a tab left before it is caught", async () => {
    invalidateVault();
    let answer: () => void = () => {};
    const vaultAnswered = new Promise<void>((r) => {
      answer = r;
    });
    const stub = stubEditorApi({
      name: "Atendente",
      modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      settings: {
        modelFallback: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          credentialRef: "vault:5",
        },
      },
    });
    stub.override = (method, path) =>
      method === "GET" && path === "/api/v1/vault"
        ? vaultAnswered.then(() =>
            Response.json({
              entries: [
                {
                  id: 5,
                  name: "proxy",
                  kind: null,
                  baseUrl: "https://proxy.example.com/v1",
                },
              ],
            }),
          )
        : undefined;
    await renderEditor(stub, "behavior");
    editTab("behavior");
    await waitFor(() => expect(save().disabled).toBe(false));
    await goTo("Tools");
    answer();
    for (let i = 0; i < 5; i++) await act(async () => {});
    fireEvent.click(save());
    await screen.findByText(/Fix the Behavior tab before saving/);
    expect(
      stub.writes.filter((w) => w.method === "PATCH" || w.method === "PUT"),
    ).toEqual([]);
    invalidateVault();
  });

  // A hold on a tab edited before Save keeps every section back, General included, even when General
  // comes first in the write order (the contact-authentication gate left empty, here).
  test("a hold on a later tab keeps an earlier section from being written", async () => {
    const stub = stubEditorApi({
      name: "Atendente",
      settings: {
        modelFallback: {
          provider: "openai-compatible",
          model: "m",
          baseURL: null,
        },
      },
    });
    await renderEditor(stub, "behavior");
    editTab("behavior");
    await waitFor(() => expect(save().disabled).toBe(true));
    await goTo("General");
    editTab("general");
    fireEvent.click(save());
    await screen.findByText(/Fix the Behavior tab before saving/);
    expect(stub.writes.filter((w) => w.method === "PATCH")).toEqual([]);
    await goTo("General");
    expect(nameField().value).toBe("Atendente (editado)");
  });

  // The Tools save's own checks hold no button on its tab, so the bar runs them before anything is
  // written: too many protected labels keep General's edit from going out too.
  test("a Tools check that fails keeps the whole save back", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: NATIVE_CATALOG },
    );
    await renderEditor(stub, "tools");
    const card = document.getElementById(nativeToolAnchor("set_labels"));
    const open = card?.querySelector<HTMLElement>("[aria-expanded]");
    if (!open) throw new Error("the set_labels card has no settings toggle");
    fireEvent.click(open);
    const field = await screen.findByLabelText(/Labels off limits/);
    fireEvent.change(field, {
      target: {
        value: Array.from({ length: 60 }, (_, i) => `l${i}`).join(", "),
      },
    });
    await goTo("General");
    editTab("general");
    fireEvent.click(save());
    await screen.findByText(/Fix the Tools tab before saving/);
    expect(
      stub.writes.filter((w) => w.method === "PATCH" || w.method === "PUT"),
    ).toEqual([]);
  });

  // The save goes back to where Save was pressed only from a tab it opened itself: an operator who
  // moved to General while the save was out stays on General.
  test("a tab the operator moved to during the save is where the save leaves them", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: NATIVE_CATALOG },
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
      if ((init?.method ?? "GET") === "PATCH" && !putSent) {
        putSent = true;
        await held;
      }
      return served(input, init);
    }) as typeof fetch;
    await renderEditor(stub, "tools");
    editTab("tools");
    fireEvent.click(save());
    await waitFor(() => expect(putSent).toBe(true));
    await goTo("General");
    release();
    await screen.findByText("Agent saved.");
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});
