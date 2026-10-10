/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// THE TOOLS TAB OF AN AGENT ON QUESTIONS AND RULES. Its rules fire fixed actions and no model ever
// reads a tool's description, so the fields written for that reader (usage guidance, transfer
// instructions) are not drawn; what the tools themselves enforce stays: the grants, where a
// transfer goes, the protected and allowed labels, the preconditions.

const { ToolGrantsEditor } = await import(
  "@/client/pages/agents/ToolGrantsEditor"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { nativeToolAnchor } = await import("@/client/pages/agents/editorTabs");
const { focusableIn } = await import("@/client/pages/agents/saveAttempt");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const { NATIVE_TOOL_NAMES, RAG_TOOL_NAMES } = await import(
  "@/graph/tools/catalog"
);

const realFetch = globalThis.fetch;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const CATALOG = {
  native: NATIVE_TOOL_NAMES.map((n) => ({ name: n })),
  rag: RAG_TOOL_NAMES.map((n) => ({ name: n })),
  toolDefinitions: [],
  mcpConnections: [],
  integrationInstances: [],
  knowledgeBases: [],
  codeTools: [],
  documentTemplates: [],
};

function renderEditor(decides: boolean) {
  const noop = () => undefined;
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <ToolGrantsEditor
              agentId="1"
              observing
              decides={decides}
              refusals={{
                handoffInstructions: null,
                kanbanInstructions: null,
                attributeInstructions: null,
                labelInstructions: null,
                updateKanbanInstructions: null,
              }}
              catalog={CATALOG as never}
              // The four tools a rule can fire, granted.
              grants={
                [
                  {
                    source: "NATIVE",
                    enabledTools: [
                      "set_labels",
                      "handoff_to_human",
                      "private_note",
                      "set_custom_attribute",
                    ],
                  },
                ] as never
              }
              onChange={noop}
              onCatalogChange={noop}
              transferWithSummary={false}
              setTransferWithSummary={noop}
              handoff={{
                mode: "pinned",
                target: "",
                targetInstanceId: null,
                instructions: "",
              }}
              setHandoff={noop}
              kanbanInstructions=""
              setKanbanInstructions={noop}
              customAttributeInstructions=""
              crossInboxCase={{
                targetInboxId: "",
                targetInstanceId: "",
                originLabel: "",
                caseLabels: [],
                caseAttributeKey: "",
                mergeContacts: false,
                resolveOrigin: false,
                subjectTemplate: "",
                openingTemplate: "",
                noteTemplate: "",
                carryMode: "off",
                carryFileTypes: ["image", "file"],
                carryMaxFiles: 10,
              }}
              setCrossInboxCase={noop}
              sendImage={{ allowedHosts: "" }}
              setSendImage={noop}
              resolveConversation={{ assignLabels: [] }}
              setResolveConversation={noop}
              setCustomAttributeInstructions={noop}
              labelInstructions=""
              protectedLabels=""
              setProtectedLabels={noop}
              allowedLabels=""
              setAllowedLabels={noop}
              outsideAllowedLabels="refuse"
              setOutsideAllowedLabels={noop}
              setLabelInstructions={noop}
              updateKanbanTaskInstructions=""
              setUpdateKanbanTaskInstructions={noop}
              mcpTools={{}}
              setMcpTools={noop}
              mcpInstructions={{}}
              setMcpInstructions={noop}
              mcpCollapsed={{}}
              setMcpCollapsed={noop}
              integrationCollapsed={{ "9": false }}
              setIntegrationCollapsed={noop}
            />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function stubAuth() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) {
      return json({ user: { id: "1", email: "a@b.c", role: "ADMIN" } });
    }
    return json({ accounts: [], agents: [], teams: [] });
  }) as typeof fetch;
}

async function openSettings(): Promise<string> {
  await waitFor(() =>
    expect(
      screen.queryAllByRole("button", { name: "Settings" }).length,
    ).toBeGreaterThan(0),
  );
  for (const b of screen.queryAllByRole("button", { name: "Settings" })) {
    fireEvent.click(b);
  }
  return document.body.textContent ?? "";
}

test("on questions and rules, the fields a model would read are not drawn", async () => {
  stubAuth();
  renderEditor(true);
  const text = await openSettings();
  expect(text.includes("Usage guidance")).toBe(false);
  expect(text.includes("Transfer instructions")).toBe(false);
  // What the tools enforce on their own stays.
  expect(text.includes("Labels off limits")).toBe(true);
});

test("on the language model, they are drawn", async () => {
  stubAuth();
  renderEditor(false);
  const text = await openSettings();
  expect(text.includes("Usage guidance")).toBe(true);
  expect(text.includes("Transfer instructions")).toBe(true);
});

// "Open Tools" from a rule lands on the tool's own card: each card a rule can fire carries the anchor
// the editor scrolls to and a control the focus goes to.
test("each tool a rule can fire has its card's anchor, with a control to focus", async () => {
  stubAuth();
  renderEditor(true);
  await openSettings();
  for (const tool of [
    "set_labels",
    "handoff_to_human",
    "private_note",
    "set_custom_attribute",
  ]) {
    const card = document.getElementById(nativeToolAnchor(tool));
    expect(card === null, tool).toBe(false);
    expect(card?.hasAttribute("data-focus-control"), tool).toBe(true);
    expect(focusableIn(card)?.getAttribute("role"), tool).toBe("checkbox");
  }
});
