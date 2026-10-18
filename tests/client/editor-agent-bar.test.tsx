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
import { focusableIn } from "@/client/pages/agents/saveAttempt";
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
        expect(stub.writes.filter((w) => w.method === "PATCH").length).toBe(2),
      { timeout: 5_000 },
    );
    expect(screen.queryByText(/Fix the Behavior tab/)).toBeNull();
    await screen.findByRole("tab", { name: "General", selected: true });
  });

  // The save writes what was edited when Save was pressed. A General edit made while its write is out
  // stays pending: the second phase writes the rest, not General again.
  test("a General edit made while its write is out is not written by the rest of the save", async () => {
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
    await screen.findByText("Tools updated.");
    const names = stub.writes
      .filter((w) => w.method === "PATCH" && "name" in w.body)
      .map((w) => w.body.name);
    expect(names).toEqual(["Atendente (editado)"]);
    expect(nameField().value).toBe("Outro nome");
    expect(save().disabled).toBe(false);
  });

  // Discard all while a write is out discards what is still waiting: the save reads each section
  // again before writing it, so Guardrails, discarded during Behavior's write, is not sent.
  test("a section discarded while an earlier write is out is not sent", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
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
    await renderEditor(stub, "behavior");
    editTab("behavior");
    await goTo("Guardrails");
    editTab("guardrails");
    fireEvent.click(save());
    await waitFor(() => expect(patchSent).toBe(true));
    fireEvent.click(discard() as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Discard all" }));
    release();
    await waitFor(() => expect(discard()).toBeNull());
    // The continuation runs on the renders after the write lands: let them run.
    for (let i = 0; i < 5; i++) await act(async () => {});
    const patches = stub.writes.filter((w) => w.method === "PATCH");
    expect(patches.length).toBe(1);
    expect(
      (patches[0]?.body.settings as { guardrails?: unknown } | undefined)
        ?.guardrails,
    ).toBeUndefined();
  });

  // Each section is judged again right before its write: the reviewer switched to a provider with no
  // address while Behavior's write was out holds the Knowledge write, and the save says so.
  test("a section edited into a hold while an earlier write is out is not sent", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: { native: [{ name: "open_case_in_inbox" }] } },
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
    await renderEditor(stub, "behavior");
    editTab("behavior");
    await goTo("Knowledge");
    const reviewer = () => {
      const select = document
        .getElementById("kb-review")
        ?.querySelector("select");
      if (!select) throw new Error("the reviewer's provider is not drawn");
      return select;
    };
    fireEvent.change(reviewer(), { target: { value: "anthropic" } });
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());
    await waitFor(() => expect(patchSent).toBe(true));
    fireEvent.change(reviewer(), { target: { value: "openai-compatible" } });
    release();
    await screen.findByText(/Fix the Knowledge tab before saving/);
    expect(stub.writes.filter((w) => w.method === "PATCH").length).toBe(1);
    expect(stub.writes.some((w) => w.method === "PUT")).toBe(false);
  });

  // The grants are one list two tabs edit. A Tools toggle made while the Tools write is out is not
  // written by the Knowledge write that follows (it sends the tools as stored) and stays pending.
  test("a Tools edit made while the Tools write is out is not written by the Knowledge write", async () => {
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
      if ((init?.method ?? "GET") === "PUT" && !putSent) {
        putSent = true;
        await held;
      }
      return served(input, init);
    }) as typeof fetch;
    await renderEditor(stub, "knowledge");
    editTab("knowledge");
    await goTo("Tools");
    editTab("tools");
    fireEvent.click(save());
    await waitFor(() => expect(putSent).toBe(true));
    const card = document.getElementById(nativeToolAnchor("set_labels"));
    if (!card) throw new Error("the set_labels card is not drawn");
    fireEvent.click(focusableIn(card) ?? card);
    release();
    await waitFor(
      () =>
        expect(stub.writes.filter((w) => w.method === "PUT").length).toBe(2),
      { timeout: 5_000 },
    );
    const tools = (body: Record<string, unknown>) =>
      JSON.stringify(
        (body.grants as { source: string; enabledTools?: string[] }[])
          .filter((g) => g.source !== "RAG")
          .map((g) => [g.source, [...(g.enabledTools ?? [])].sort()]),
      );
    const [first, second] = stub.writes.filter((w) => w.method === "PUT");
    expect(tools(second?.body ?? {})).toBe(tools(first?.body ?? {}));
    await waitFor(() => expect(save().disabled).toBe(false));
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

  // Once General is written, the rest judge against what it wrote: a provider switched on General
  // while its write is out stays a pending edit and does not hold Behavior's write.
  test("a General edit made during its write does not hold the sections after it", async () => {
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
    await renderEditor(stub, "behavior");
    editTab("behavior");
    await goTo("General");
    editTab("general");
    fireEvent.click(save());
    await waitFor(() => expect(patchSent).toBe(true));
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "openai" },
    });
    release();
    await waitFor(
      () =>
        expect(stub.writes.filter((w) => w.method === "PATCH").length).toBe(2),
      { timeout: 5_000 },
    );
    expect(screen.queryByText(/Fix the Behavior tab/)).toBeNull();
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

  // A save that does not write General judges against the stored model: a provider switched on
  // General while it runs does not hold the Knowledge reviewer that inherits the stored endpoint.
  test("a General edit made during a save that does not write General holds nothing", async () => {
    const stub = stubEditorApi(
      {
        name: "Atendente",
        modelConfig: {
          provider: "openai-compatible",
          model: "m",
          baseURL: "https://llm.example.com/v1",
        },
      },
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
      if ((init?.method ?? "GET") === "PUT" && !putSent) {
        putSent = true;
        await held;
      }
      return served(input, init);
    }) as typeof fetch;
    await renderEditor(stub, "knowledge");
    const reviewer = document
      .getElementById("kb-review")
      ?.querySelector("select");
    if (!reviewer) throw new Error("the reviewer's provider is not drawn");
    fireEvent.change(reviewer, { target: { value: "openai-compatible" } });
    await waitFor(() => expect(save().disabled).toBe(false));
    await goTo("Tools");
    editTab("tools");
    fireEvent.click(save());
    await waitFor(() => expect(putSent).toBe(true));
    await goTo("General");
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "openai" },
    });
    release();
    await waitFor(
      () =>
        expect(stub.writes.filter((w) => w.method === "PUT").length).toBe(2),
      { timeout: 5_000 },
    );
    expect(screen.queryByText(/Fix the Knowledge tab/)).toBeNull();
  });

  // The save goes back to where Save was pressed only from a tab it opened itself: an operator who
  // moved to General while the Tools write was out stays on General.
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
      if ((init?.method ?? "GET") === "PUT" && !putSent) {
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
    await screen.findByText("Tools updated.");
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  // A recheck the save makes after the operator moved does not erase where they went: switched to
  // Monitoring on General during the Tools write, Knowledge is judged again, and the save ends back
  // on General, not on Tools where Save was pressed.
  test("a recheck after the operator moved still leaves them where they went", async () => {
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
      if ((init?.method ?? "GET") === "PUT" && !putSent) {
        putSent = true;
        await held;
      }
      return served(input, init);
    }) as typeof fetch;
    await renderEditor(stub, "knowledge");
    editTab("knowledge");
    await goTo("Tools");
    editTab("tools");
    fireEvent.click(save());
    await waitFor(() => expect(putSent).toBe(true));
    await goTo("General");
    fireEvent.click(screen.getByRole("radio", { name: /^Monitoring/ }));
    release();
    await waitFor(
      () =>
        expect(stub.writes.filter((w) => w.method === "PUT").length).toBe(2),
      { timeout: 5_000 },
    );
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});
