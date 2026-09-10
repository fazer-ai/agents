/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// A WATCHER'S TOOLS TAB OFFERS ONLY WHAT ITS TURN CAN RUN (issue #568, review round 30).
//
// The monitoring turn builds its Chatwoot client MUTED, and the assembly then drops every tool whose
// whole point is to put something in front of the customer: the two natives the catalog flags, the
// document tools, and a toolpack's delivery tools. A grant for one of those is a control that cannot
// fire — the same class of dead configuration this issue refused at the API, arriving through the
// editor instead. Grants already saved are left alone: flipping the mode back returns the agent.

const { ToolGrantsEditor } = await import(
  "@/client/pages/agents/ToolGrantsEditor"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const {
  NATIVE_TOOL_NAMES,
  RAG_TOOL_NAMES,
  CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES,
} = await import("@/graph/tools/catalog");

const realFetch = globalThis.fetch;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// The catalog exactly as the API builds it, delivery flag included — read from the same constant the
// server maps and the assembly strips, so the three cannot describe different screens.
const DELIVERS = new Set<string>(CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES);
const CATALOG = {
  native: NATIVE_TOOL_NAMES.map((n) => ({
    name: n,
    ...(DELIVERS.has(n) ? { deliversToCustomer: true } : {}),
  })),
  rag: RAG_TOOL_NAMES.map((n) => ({ name: n })),
  toolDefinitions: [],
  mcpConnections: [],
  integrationInstances: [
    {
      id: "9",
      catalogType: "GOOGLE_DRIVE",
      kind: "TOOLPACK",
      name: "Drive",
      enabled: true,
      tools: [
        { name: "drive_find_file", args: [] },
        { name: "drive_send_file", args: [], deliversToCustomer: true },
      ],
    },
  ],
  knowledgeBases: [],
  codeTools: [],
  documentTemplates: [
    {
      id: "3",
      name: "Orçamento",
      toolName: "send_orcamento",
      description: "Orçamento com itens.",
      enabled: true,
      available: true,
    },
  ],
};

function renderEditor(observing: boolean) {
  const noop = () => undefined;
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <ToolGrantsEditor
              agentId="1"
              observing={observing}
              refusals={{
                handoffInstructions: null,
                kanbanInstructions: null,
                attributeInstructions: null,
                labelInstructions: null,
                updateKanbanInstructions: null,
              }}
              catalog={CATALOG as never}
              // The integration is GRANTED, and expanded, so its tool list is on screen.
              grants={
                [
                  {
                    source: "INTEGRATION",
                    integrationInstanceId: "9",
                    enabledTools: ["drive_find_file", "drive_send_file"],
                  },
                ] as never
              }
              onChange={noop}
              onCatalogChange={noop}
              transferWithSummary={false}
              setTransferWithSummary={noop}
              handoff={{
                mode: "",
                target: "",
                targetInstanceId: null,
                instructions: "",
              }}
              setHandoff={noop}
              kanbanInstructions=""
              setKanbanInstructions={noop}
              customAttributeInstructions=""
              setCustomAttributeInstructions={noop}
              labelInstructions=""
              protectedLabels=""
              setProtectedLabels={noop}
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
    return json({});
  }) as typeof fetch;
}

test("an agent that only observes is not offered the tools its turn would refuse", async () => {
  stubAuth();
  renderEditor(true);
  // Awaited because AuthProvider holds the tree behind a spinner until /me answers; `skip_reply` is
  // a native no mode strips, so its card appearing is what says the tree is up.
  await waitFor(() =>
    expect(screen.queryAllByText("Skip reply").length).toBeGreaterThan(0),
  );
  expect(screen.queryByText("Send image")).toBeNull();
  expect(screen.queryByText("React with emoji")).toBeNull();
  expect(screen.queryByText("Send file")).toBeNull();
  expect(screen.queryByText("Documents")).toBeNull();
  // The pack's own read-only tool is still there: the filter is about delivery, not about packs.
  expect(screen.queryAllByText("Find file").length).toBeGreaterThan(0);
});

test("...and an agent that answers is offered all of them", async () => {
  stubAuth();
  renderEditor(false);
  await waitFor(() =>
    expect(screen.queryAllByText("Skip reply").length).toBeGreaterThan(0),
  );
  expect(screen.queryAllByText("Send image").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("React with emoji").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("Send file").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("Documents").length).toBeGreaterThan(0);
});
