/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { nativeToolAnchor } from "@/client/pages/agents/editorTabs";
import { focusableIn } from "@/client/pages/agents/saveAttempt";
import {
  type EditorStub,
  editTab,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The Tools save is two requests, the grants PUT and then the settings PATCH. When the PUT goes
// through and the PATCH does not, the grants are in effect on the server, so they are the editor's
// copy from then on: a discard puts them back as written, and only the settings stay unsaved.

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
const GRANTED = [
  { source: "NATIVE", enabledTools: ["set_labels"], knowledgeBaseIds: [] },
];
const PARTIAL = "The tool selection was saved, but the tool settings were not.";

// Whether the private-note card reads as granted.
function privateNoteOn(): boolean {
  const card = document.getElementById(nativeToolAnchor("private_note"));
  const control = focusableIn(card);
  if (!control) throw new Error("the private_note card is not drawn");
  const aria = control.getAttribute("aria-checked");
  return aria !== null
    ? aria === "true"
    : (control as HTMLInputElement).checked;
}

// The grants the server holds after the last PUT.
const storedTools = (stub: EditorStub) =>
  [...stub.writes].reverse().find((w) => w.method === "PUT")?.body.grants as
    | { enabledTools?: string[] }[]
    | undefined;

// By text, not by role: a role query reads the accessible name of every node, and with the tool
// settings open the editor is large enough for a polled one to exhaust the test runner.
const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  );

// The bar's Discard, confirmed: it puts back every tab.
async function discardAll() {
  fireEvent.click(buttonNamed("Discard") as HTMLElement);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === "Discard all",
    ) as HTMLElement,
  );
  await waitFor(() => expect(buttonNamed("Discard")).toBeUndefined());
}

// Grants private_note and fills the labels off limits, then saves with the PATCH answered by `refusal`.
async function saveWithRefusedPatch(refusal: Response): Promise<EditorStub> {
  const stub = stubEditorApi({}, { catalog: CATALOG, grants: GRANTED });
  await renderEditor(stub, "tools");
  editTab("tools");
  fireEvent.click(
    screen.getByRole("button", { name: "Settings", expanded: false }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Labels off limits" }), {
    target: { value: "vip" },
  });
  let pending = true;
  stub.override = (method, path) => {
    if (!pending || method !== "PATCH" || path !== `/api/v1/agents/41`) return;
    pending = false;
    return refusal;
  };
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(PARTIAL);
  expect(stub.writes.map((w) => w.method)).toEqual(["PUT", "PATCH"]);
  expect(
    storedTools(stub)?.some((g) => g.enabledTools?.includes("private_note")),
  ).toBe(true);
  return stub;
}

describe("a Tools save whose PATCH fails after the grants PUT", () => {
  for (const [name, refusal] of [
    ["a refusal", () => json({ error: "Refused by the server." }, 400)],
    ["a conflict", () => json({ error: "changed" }, 409)],
  ] as const) {
    test(`${name}: the written grants are the editor's copy, and the settings stay unsaved`, async () => {
      await saveWithRefusedPatch(refusal());
      expect(privateNoteOn()).toBe(true);
      // NOTE: the labels are still the operator's edit, so the editor is not clean.
      expect(buttonNamed("Discard")).toBeDefined();
      await discardAll();
      expect(privateNoteOn()).toBe(true);
      expect(
        (
          screen.getByRole("textbox", {
            name: "Labels off limits",
          }) as HTMLInputElement
        ).value,
      ).toBe("");
    });
  }

  test("the grant change alone leaves nothing unsaved once the PUT went through", async () => {
    const stub = stubEditorApi({}, { catalog: CATALOG, grants: GRANTED });
    await renderEditor(stub, "tools");
    editTab("tools");
    stub.override = (method, path) => {
      if (method === "PATCH" && path === "/api/v1/agents/41")
        return json({ error: "Refused by the server." }, 400);
    };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(PARTIAL);
    await waitFor(() => expect(buttonNamed("Discard")).toBeUndefined());
    expect(privateNoteOn()).toBe(true);
  });

  test("the grants as the server wrote them, not as they were sent", async () => {
    const stub = stubEditorApi({}, { catalog: CATALOG, grants: GRANTED });
    await renderEditor(stub, "tools");
    editTab("tools");
    stub.override = (method, path) => {
      if (method === "PUT" && path === "/api/v1/agents/41/tool-selections")
        return json({
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
        });
      if (method === "PATCH" && path === "/api/v1/agents/41")
        return json({ error: "Refused by the server." }, 400);
    };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(PARTIAL);
    await waitFor(() => expect(buttonNamed("Discard")).toBeUndefined());
    expect(privateNoteOn()).toBe(true);
  });
});
