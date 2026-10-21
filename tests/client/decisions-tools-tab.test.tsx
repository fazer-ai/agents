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

function renderEditor(
  decides: boolean,
  handoffMode = "pinned",
  transferWithSummary = false,
  saved: { extraNative?: string[]; onChange?: (g: unknown) => void } = {},
) {
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
                      ...(saved.extraNative ?? []),
                    ],
                  },
                ] as never
              }
              onChange={saved.onChange ?? noop}
              onCatalogChange={noop}
              transferWithSummary={transferWithSummary}
              setTransferWithSummary={noop}
              handoff={{
                mode: handoffMode,
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
              labelRemoval="any"
              setLabelRemoval={noop}
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

// The list is what a rule can run: the four natives a rule names and the tenant's own HTTP, code
// and MCP tools (agents#1223). The rest of the catalog (integrations, the natives of an agent that
// answers) is not drawn, and nothing about the tools is written for a model to read.
test("on questions and rules, only what a rule can run is listed", async () => {
  stubAuth();
  renderEditor(true);
  const text = await openSettings();
  for (const id of ["tools-http", "tools-code", "tools-mcp"]) {
    expect(document.getElementById(id) === null, id).toBe(false);
  }
  expect(document.getElementById("tools-integrations") === null).toBe(true);
  expect(text.includes("Skip reply")).toBe(false);
  expect(text.includes("Move kanban card")).toBe(false);
  expect(
    document.getElementById(nativeToolAnchor("private_note")) === null,
  ).toBe(false);
  expect(text.includes("provided automatically")).toBe(false);
  // No summary written before the handoff: that is a model's.
  expect(text.includes("private summary before handing off")).toBe(false);
  expect(text.includes("optionally with a summary")).toBe(false);
  // Its one card in the shared grid sits at the width of the cards below it, not half of it.
  const grid = document
    .getElementById(nativeToolAnchor("private_note"))
    ?.closest(".grid");
  expect(grid?.className.includes("sm:grid-cols-2")).toBe(false);
});

test("on the language model, the catalog and the summary switch are there", async () => {
  stubAuth();
  renderEditor(false);
  const text = await openSettings();
  expect(document.getElementById("tools-http") === null).toBe(false);
  expect(text.includes("Skip reply")).toBe(true);
  expect(text.includes("private summary before handing off")).toBe(true);
});

// "Let the AI choose" has no AI to choose on this engine: not offered, and a stored one is a problem
// that says what to do.
test("a handoff stored as the AI's choice is a problem with the way out", async () => {
  stubAuth();
  renderEditor(true, "agent_choice");
  const text = await openSettings();
  expect(text.includes("no model to choose")).toBe(true);
  expect(text.includes("Chatwoot routing")).toBe(true);
});

// Hidden is not revoked: a tool granted while the agent answered stays granted through an edit here.
test("a grant this engine does not draw survives a toggle on a drawn one", async () => {
  stubAuth();
  const emitted: unknown[] = [];
  renderEditor(true, "pinned", false, {
    extraNative: ["skip_reply"],
    onChange: (g) => emitted.push(g),
  });
  const card = await waitFor(() => {
    const el = document.getElementById(nativeToolAnchor("private_note"));
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  fireEvent.click(focusableIn(card) ?? card);
  const last = emitted.at(-1) as { source: string; enabledTools?: string[] }[];
  const native = last.find((g) => g.source === "NATIVE");
  expect(native?.enabledTools).toContain("skip_reply");
  expect(native?.enabledTools).not.toContain("private_note");
});
