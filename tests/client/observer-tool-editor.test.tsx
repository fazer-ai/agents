/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";

// A WATCHER'S TOOLS TAB OFFERS ONLY WHAT ITS TURN CAN RUN. The monitoring turn builds its Chatwoot
// client MUTED, and the assembly drops every tool whose point is to put something in front of the
// customer: the two natives the catalog flags, the document tools, and a toolpack's delivery tools.
// A grant for one of those is a control that cannot fire. Grants already saved are left alone:
// flipping the mode back returns the agent.

const { ToolGrantsEditor } = await import(
  "@/client/pages/agents/ToolGrantsEditor"
);
const { ToolsTab } = await import("@/client/pages/agents/ToolsTab");
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

// The editor with its catalog and grants as props: fixed by default, or held by the caller.
function Editor({
  observing,
  catalog = CATALOG,
  grants = GRANTED,
  onChange = () => undefined,
  onCatalogChange = () => undefined,
}: {
  observing: boolean;
  catalog?: unknown;
  grants?: unknown;
  onChange?: (grants: unknown) => void;
  onCatalogChange?: () => void | Promise<void>;
}) {
  const noop = () => undefined;
  return (
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
              catalog={catalog as never}
              grants={grants as never}
              onChange={onChange as never}
              onCatalogChange={onCatalogChange as never}
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
    </MemoryRouter>
  );
}

// The integration is GRANTED, and expanded, so its tool list is on screen.
const GRANTED = [
  {
    source: "INTEGRATION",
    integrationInstanceId: "9",
    enabledTools: ["drive_find_file", "drive_send_file"],
  },
];

function renderEditor(observing: boolean) {
  return render(<Editor observing={observing} />);
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

// The other place a pack's tools are decided: an integration created from inside this editor is
// granted on the spot, and a watcher is granted only what it would have been offered.
async function grantOnCreate(observing: boolean): Promise<unknown> {
  const created = {
    ...(CATALOG.integrationInstances[0] as Record<string, unknown>),
    id: "77",
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) {
      return json({ user: { id: "1", email: "a@b.c", role: "ADMIN" } });
    }
    if (url.includes("/integrations/catalog")) {
      return json({
        catalog: [{ catalogType: "GOOGLE_DRIVE", kind: "TOOLPACK", tools: [] }],
      });
    }
    if (url.includes("/integrations/instances")) {
      return json({ id: "77", routeToken: null });
    }
    return json({});
  }) as typeof fetch;
  let granted: unknown = null;
  function Live() {
    const [catalog, setCatalog] = useState<Record<string, unknown>>({
      ...CATALOG,
      integrationInstances: [],
    });
    const [grants, setGrants] = useState<unknown[]>([]);
    return (
      <Editor
        observing={observing}
        catalog={catalog}
        grants={grants}
        onChange={(next) => {
          granted = next;
          setGrants(next as unknown[]);
        }}
        onCatalogChange={() =>
          setCatalog((c) => ({ ...c, integrationInstances: [created] }))
        }
      />
    );
  }
  render(<Live />);
  const section = await waitFor(() => {
    const el = document.getElementById("tools-integrations");
    if (!el) throw new Error("the integrations section is not drawn");
    return el;
  });
  fireEvent.click(within(section).getByRole("button", { name: /New/ }));
  const dialog = await screen.findByRole("dialog");
  const save = within(dialog).getByRole("button", { name: "Save" });
  await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  fireEvent.click(save);
  await waitFor(() => expect(granted).not.toBeNull());
  return granted;
}

test("both places a pack's tools are decided read one predicate", async () => {
  expect(await grantOnCreate(true)).toEqual([
    {
      source: "INTEGRATION",
      integrationInstanceId: "77",
      enabledTools: ["drive_find_file"],
    },
  ]);
});

test("...and an agent that answers is granted the whole pack on creation", async () => {
  expect(await grantOnCreate(false)).toEqual([
    {
      source: "INTEGRATION",
      integrationInstanceId: "77",
      enabledTools: ["drive_find_file", "drive_send_file"],
    },
  ]);
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

// THE OTHER HALF OF THE SAME SCREEN. Besides the grant cards, the preconditions block beside them
// and the section index on the left leave out what a muted turn strips.
function renderToolsTab(
  observing: boolean,
  rows: { tool: string; scope: string; key: string; value: string }[] = [],
) {
  const noop = () => undefined;
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <ToolsTab
              agentId="1"
              observing={observing}
              catalog={CATALOG as never}
              grants={[] as never}
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
              refusals={{
                handoffInstructions: null,
                kanbanInstructions: null,
                attributeInstructions: null,
                labelInstructions: null,
                updateKanbanInstructions: null,
              }}
              setCustomAttributeInstructions={noop}
              labelInstructions=""
              setLabelInstructions={noop}
              protectedLabels=""
              setProtectedLabels={noop}
              allowedLabels=""
              setAllowedLabels={noop}
              outsideAllowedLabels="refuse"
              setOutsideAllowedLabels={noop}
              updateKanbanTaskInstructions=""
              setUpdateKanbanTaskInstructions={noop}
              toolPreconditions={rows as never}
              setToolPreconditions={noop}
              mcpTools={{}}
              setMcpTools={noop}
              mcpInstructions={{}}
              setMcpInstructions={noop}
              mcpCollapsed={{}}
              setMcpCollapsed={noop}
              integrationCollapsed={{}}
              setIntegrationCollapsed={noop}
              dirty={false}
              saving={false}
              onSave={noop}
              onDiscard={noop}
            />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

// The empty row is what an operator adding a guard sees, and its select is the list of choices.
const EMPTY_ROW = { tool: "", scope: "conversation", key: "", value: "" };

test("a watcher is not offered a precondition on a tool its turn would strip", async () => {
  stubAuth();
  renderToolsTab(true, [EMPTY_ROW]);
  await waitFor(() =>
    expect(screen.queryAllByText("Tool preconditions").length).toBeGreaterThan(
      0,
    ),
  );
  const options = Array.from(
    document.querySelectorAll<HTMLOptionElement>("option"),
  ).map((o) => o.textContent);
  expect(options).toContain("Set labels");
  expect(options).not.toContain("Send image");
  expect(options).not.toContain("React with emoji");
});

test("...and a guard saved before the mode flipped is still on screen", async () => {
  // The filter is about what can be ADDED. A rule already stored keeps its own tool in the select
  // (`optionsFor` puts it back), because a select whose value is not among its options renders
  // blank, and a blank row invites deleting a rule nobody read.
  stubAuth();
  renderToolsTab(true, [{ ...EMPTY_ROW, tool: "send_image" }]);
  await waitFor(() =>
    expect(screen.queryAllByText("Tool preconditions").length).toBeGreaterThan(
      0,
    ),
  );
  const options = Array.from(
    document.querySelectorAll<HTMLOptionElement>("option"),
  ).map((o) => o.textContent);
  expect(options).toContain("Send image");
});

test("an agent that answers is offered every native it was granted", async () => {
  stubAuth();
  renderToolsTab(false, [EMPTY_ROW]);
  await waitFor(() =>
    expect(screen.queryAllByText("Tool preconditions").length).toBeGreaterThan(
      0,
    ),
  );
  const options = Array.from(
    document.querySelectorAll<HTMLOptionElement>("option"),
  ).map((o) => o.textContent);
  expect(options).toContain("Send image");
  expect(options).toContain("React with emoji");
});

test("the section index carries no link to a block the watcher does not draw", async () => {
  stubAuth();
  const { unmount } = renderToolsTab(false);
  await waitFor(() =>
    expect(screen.queryAllByRole("link", { name: "Documents" }).length).toBe(1),
  );
  unmount();
  renderToolsTab(true);
  await waitFor(() =>
    expect(screen.queryAllByText("Tool preconditions").length).toBeGreaterThan(
      0,
    ),
  );
  expect(screen.queryAllByRole("link", { name: "Documents" })).toHaveLength(0);
});
