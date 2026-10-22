/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { nativeToolAnchor } from "@/client/pages/agents/editorTabs";
import { focusableIn } from "@/client/pages/agents/saveAttempt";
import {
  type EditorStub,
  editTab,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// One Save writes the whole agent in ONE request: every edited section's part, and the whole grant
// set when Tools or Knowledge is among them. The server applies all of it or none of it, so the
// editor is either saved or exactly as it was before Save, with one message either way.

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

const CATALOG = { native: [{ name: "set_labels" }, { name: "private_note" }] };
const RAG_CATALOG = {
  ...CATALOG,
  rag: [{ name: "search_knowledge" }, { name: "suggest_kb_entry" }],
  knowledgeBases: [{ id: "5", name: "FAQ" }],
};
const GRANTED = [
  { source: "NATIVE", enabledTools: ["set_labels"], knowledgeBaseIds: [] },
];

// How many toasts carry a sentence: each is an item of the toast viewport's list (the screen reader's
// copy of the sentence is not one).
const shown = (text: string) =>
  [...document.querySelectorAll("ol > li")].filter((toast) =>
    toast.textContent?.includes(text),
  ).length;

// By text, not by role: a role query reads the accessible name of every node, and with the tool
// settings open the editor is large enough for a polled one to exhaust the test runner.
const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  );

function privateNoteOn(): boolean {
  const card = document.getElementById(nativeToolAnchor("private_note"));
  const control = focusableIn(card);
  if (!control) throw new Error("the private_note card is not drawn");
  const aria = control.getAttribute("aria-checked");
  return aria !== null
    ? aria === "true"
    : (control as HTMLInputElement).checked;
}

async function goTo(name: RegExp) {
  fireEvent.click(screen.getByRole("tab", { name }));
  await act(async () => {});
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => {});
}

// General, Behavior, Guardrails and Tools edited, then Save pressed on Tools.
async function editFour(stub: EditorStub) {
  await renderEditor(stub, "general");
  editTab("general");
  await goTo(/^Behavior/);
  editTab("behavior");
  await goTo(/^Guardrails/);
  editTab("guardrails");
  await goTo(/^Tools/);
  editTab("tools");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

const dirtyTabs = () =>
  ["General", "Behavior", "Guardrails", "Tools"].filter(
    (name) =>
      screen
        .getByRole("tab", { name: new RegExp(`^${name}`) })
        .querySelector(".bg-warning") !== null,
  );

describe("one Save, one request", () => {
  test("every edited section goes out in one PATCH, the grants with it, and says so once", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: CATALOG, grants: GRANTED },
    );
    await editFour(stub);
    await screen.findByText("Agent saved.");
    await settle();
    expect(stub.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PATCH /api/v1/agents/41",
    ]);
    const body = stub.writes[0]?.body ?? {};
    expect(body.name).toBe("Atendente (editado)");
    // Behavior's part carries its schedules beside its blocks.
    expect("businessHoursId" in body).toBe(true);
    expect(Object.keys(body.settings as Record<string, unknown>)).toContain(
      "guardrails",
    );
    expect(
      (body.grants as { enabledTools: string[] }[]).flatMap(
        (g) => g.enabledTools,
      ),
    ).toContain("private_note");
    expect(shown("Agent saved.")).toBe(1);
    expect(shown("Tools updated.")).toBe(0);
    expect(dirtyTabs()).toEqual([]);
  });

  test("a refused save writes nothing and leaves every section pending", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: CATALOG, grants: GRANTED },
    );
    stub.override = (method, path) => {
      if (method === "PATCH" && path === "/api/v1/agents/41")
        return json({ error: "Refused by the server." }, 422);
    };
    await editFour(stub);
    await waitFor(() => expect(stub.writes).toHaveLength(1));
    await settle();
    expect(shown("Agent saved.")).toBe(0);
    expect(stub.agent.name).toBe("Atendente");
    expect(dirtyTabs()).toEqual(["General", "Behavior", "Guardrails", "Tools"]);
    expect(buttonNamed("Discard")).toBeDefined();
  });

  test("a conflict writes nothing and asks once", async () => {
    const stub = stubEditorApi(
      { name: "Atendente" },
      { catalog: CATALOG, grants: GRANTED },
    );
    stub.override = (method, path) => {
      if (method === "PATCH" && path === "/api/v1/agents/41")
        return json({ error: "changed" }, 409);
    };
    await editFour(stub);
    await waitFor(() => expect(stub.writes).toHaveLength(1));
    await settle();
    expect(shown("This agent was changed elsewhere")).toBe(1);
    expect(dirtyTabs()).toEqual(["General", "Behavior", "Guardrails", "Tools"]);
  });

  test("a Tools save is the PATCH alone, carrying the grants", async () => {
    const stub = stubEditorApi({}, { catalog: CATALOG, grants: GRANTED });
    await renderEditor(stub, "tools");
    editTab("tools");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Agent saved.");
    expect(stub.writes.map((w) => w.method)).toEqual(["PATCH"]);
    expect(stub.writes[0]?.body.grants).toBeDefined();
    expect(stub.writes[0]?.body.transferWithSummary).toBe(false);
  });

  test("a save that writes no Tools or Knowledge part sends no grants", async () => {
    const stub = stubEditorApi({}, { catalog: CATALOG, grants: GRANTED });
    await renderEditor(stub, "general");
    editTab("general");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Agent saved.");
    expect("grants" in (stub.writes[0]?.body ?? {})).toBe(false);
  });

  test("the grants as the server wrote them are the editor's copy", async () => {
    const stub = stubEditorApi({}, { catalog: CATALOG, grants: GRANTED });
    await renderEditor(stub, "tools");
    editTab("tools");
    stub.override = (method, path) => {
      if (method !== "PATCH" || path !== "/api/v1/agents/41") return;
      return json({
        agent: stub.agent,
        toolSelection: {
          grants: [
            {
              source: "NATIVE",
              enabledTools: ["private_note"],
              knowledgeBaseIds: [],
              toolDefinitionId: null,
              mcpServerConnectionId: null,
              integrationInstanceId: null,
              documentTemplateId: null,
              codeToolDefinitionId: null,
            },
          ],
          catalog: {
            ...CATALOG,
            rag: [],
            toolDefinitions: [],
            mcpConnections: [],
            integrationInstances: [],
            codeTools: [],
            documentTemplates: [],
            knowledgeBases: [],
          },
          agentUpdatedAt: stub.agent.updatedAt,
        },
      });
    };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Agent saved.");
    await waitFor(() => expect(buttonNamed("Discard")).toBeUndefined());
    expect(privateNoteOn()).toBe(true);
  });

  test("a Redirect edit goes out in the settings bag", async () => {
    const stub = stubEditorApi({});
    await renderEditor(stub, "channelRedirect");
    editTab("channelRedirect");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Agent saved.");
    expect(
      Object.keys((stub.writes[0]?.body.settings ?? {}) as object),
    ).toContain("channelRedirect");
  });

  test("a Knowledge edit sends its half of the set from the form", async () => {
    const stub = stubEditorApi({}, { catalog: RAG_CATALOG, grants: GRANTED });
    await renderEditor(stub, "knowledge");
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable knowledge retrieval" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Agent saved.");
    const sent = stub.writes[0]?.body.grants as { source: string }[];
    expect(sent.map((g) => g.source).sort()).toEqual(["NATIVE", "RAG"]);
  });
});

// The answer lands on a form the operator may have edited since the request went out: each tab takes
// it back only when it was not, so an edit made meanwhile stays on screen, and unsaved.
describe("an edit made while the save is out", () => {
  function holdPatch() {
    const served = globalThis.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const state = { sent: false, release: () => release() };
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "PATCH" && !state.sent) {
        state.sent = true;
        await held;
      }
      return served(input, init);
    }) as typeof fetch;
    return state;
  }

  test("on Tools stays, and Tools stays unsaved", async () => {
    const stub = stubEditorApi({}, { catalog: CATALOG, grants: GRANTED });
    await renderEditor(stub, "tools");
    editTab("tools");
    const patch = holdPatch();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch.sent).toBe(true));
    editTab("tools");
    patch.release();
    await screen.findByText("Agent saved.");
    await settle();
    expect(privateNoteOn()).toBe(false);
    expect(
      screen.getByRole("tab", { name: /^Tools/ }).querySelector(".bg-warning"),
    ).not.toBeNull();
  });

  test("on Knowledge stays, and Knowledge stays unsaved", async () => {
    const stub = stubEditorApi({}, { catalog: RAG_CATALOG, grants: GRANTED });
    await renderEditor(stub, "knowledge");
    const retrieval = () =>
      screen.getByRole("switch", { name: "Enable knowledge retrieval" });
    fireEvent.click(retrieval());
    const patch = holdPatch();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch.sent).toBe(true));
    fireEvent.click(retrieval());
    patch.release();
    await screen.findByText("Agent saved.");
    await settle();
    expect(retrieval().getAttribute("aria-checked")).toBe("false");
    expect(
      screen
        .getByRole("tab", { name: /^Knowledge/ })
        .querySelector(".bg-warning"),
    ).not.toBeNull();
  });
});
