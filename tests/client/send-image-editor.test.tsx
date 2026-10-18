/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import {
  type EditorStub,
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// `sendImage.allowedHosts` is config OF the send_image tool, and an empty list makes the tool refuse
// every call while it is still offered to the model, so it is edited on the tool's own card, where
// the operator grants it, and written by the Tools save, the way `crossInboxCase` and `handoff` are.
// Two saves write the same settings column and each resends the whole bag, so the ownership has to
// be exact on both sides.

const { ToolGrantsEditor } = await import(
  "@/client/pages/agents/ToolGrantsEditor"
);
const { readSendImageState, serializeSendImage, sendImageHasNoHost } =
  await import("@/client/pages/agents/SendImageFields");
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const {
  NATIVE_TOOL_NAMES,
  RAG_TOOL_NAMES,
  CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES,
} = await import("@/graph/tools/catalog");
const { readSendImageConfig } = await import("@/modules/images/settings");

const WARNING =
  "No host is allowed yet, so every call is refused. Add at least one host.";

describe("the form round-trips what is stored", () => {
  test("every host the reader honors survives a load and a save", () => {
    const stored = { allowedHosts: ["cdn.loja.com.br", "*.fotos.com.br"] };
    const saved = serializeSendImage(readSendImageState(stored));
    expect(readSendImageConfig({ sendImage: saved })).toEqual(stored);
  });

  test("blank lines are dropped, and a missing block reads as an empty list", () => {
    expect(
      serializeSendImage({ allowedHosts: " cdn.loja.com.br \n\n  \n" }),
    ).toEqual({ allowedHosts: ["cdn.loja.com.br"] });
    expect(readSendImageState(undefined)).toEqual({ allowedHosts: "" });
    expect(readSendImageState({ allowedHosts: [3, "a.com"] })).toEqual({
      allowedHosts: "a.com",
    });
  });

  test("a list with nothing the reader accepts counts as empty, as the runtime sees it", () => {
    expect(sendImageHasNoHost({ allowedHosts: "" })).toBe(true);
    expect(sendImageHasNoHost({ allowedHosts: "  \n " })).toBe(true);
    expect(sendImageHasNoHost({ allowedHosts: "not a host" })).toBe(true);
    expect(sendImageHasNoHost({ allowedHosts: "cdn.loja.com.br" })).toBe(false);
    expect(
      sendImageHasNoHost({ allowedHosts: "https://cdn.loja.com.br/x.png" }),
    ).toBe(false);
  });
});

// The two saves write the same settings column, each resending the whole bag: the Tools save owns
// the block, and a Behavior save carries whatever the Tools save last stored. Asked of the whole
// editor, rendered against a stubbed API.
describe("which save owns the block", () => {
  const STORED = { allowedHosts: ["cdn.loja.com.br"] };

  async function openTools(): Promise<EditorStub> {
    const stub = stubEditorApi(
      { settings: { sendImage: STORED } },
      {
        catalog: { native: [{ name: "send_image" }] },
        grants: [
          {
            source: "NATIVE",
            enabledTools: ["send_image"],
            knowledgeBaseIds: [],
          },
        ],
      },
    );
    await renderEditor(stub, "tools");
    return stub;
  }
  async function field(): Promise<HTMLTextAreaElement> {
    if (!hostsField()) expand();
    return await waitFor(() => {
      const el = hostsField();
      if (!el) throw new Error("the hosts field is not drawn");
      return el;
    });
  }
  async function typeHosts(value: string) {
    fireEvent.change(await field(), { target: { value } });
  }
  const goTo = async (name: RegExp) => {
    fireEvent.click(screen.getByRole("tab", { name }));
    await act(async () => {});
  };
  const patches = (stub: EditorStub) =>
    stub.writes.filter((w) => w.method === "PATCH" && w.body.settings);
  const savedHosts = (stub: EditorStub) =>
    (lastSavedSettings(stub)?.sendImage as { allowedHosts?: string[] })
      ?.allowedHosts;
  const behaviorSwitch = () =>
    screen.findByRole("switch", {
      name: /Stop answering when a person replies to the customer/,
    });
  async function saveBehaviorEdit(stub: EditorStub) {
    const before = patches(stub).length;
    await goTo(/Behavior/);
    fireEvent.click(await behaviorSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(stub).length).toBe(before + 1));
  }
  const dirty = (name: RegExp) =>
    screen.getByRole("tab", { name }).querySelector(".bg-warning") !== null;

  test("the Tools save writes it and keeps the shared bag in step", async () => {
    const stub = await openTools();
    await typeHosts("cdn.novo.com.br");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedHosts(stub)).toEqual(["cdn.novo.com.br"]));
    await saveBehaviorEdit(stub);
    expect(savedHosts(stub)).toEqual(["cdn.novo.com.br"]);
  });

  // The bar saves the agent (agents#1520), Behavior before Tools: the Behavior PATCH carries the block
  // as stored and the Tools PATCH after it carries the draft, so neither writes the other's form.
  test("the Behavior save does not name it, so it cannot write a stale form over it", async () => {
    const stub = await openTools();
    await typeHosts("rascunho.com.br");
    await goTo(/Behavior/);
    fireEvent.click(await behaviorSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(stub).length).toBe(2));
    const hostsIn = (w: { body: Record<string, unknown> }) =>
      (
        (w.body.settings as Record<string, unknown>).sendImage as {
          allowedHosts?: string[];
        }
      )?.allowedHosts;
    const [behavior, tools] = patches(stub);
    expect(behavior && hostsIn(behavior)).toEqual(STORED.allowedHosts);
    expect(tools && hostsIn(tools)).toEqual(["rascunho.com.br"]);
  });

  // When the Tools write fails after Behavior's went through, the Behavior re-read does not put the
  // stored list back over the draft: the field keeps it, and Tools stays unsaved.
  test("it is re-read with the other tool config, not by a Behavior load", async () => {
    const stub = await openTools();
    await typeHosts("rascunho.com.br");
    stub.override = (method, path) =>
      method === "PUT" && path.endsWith("/tool-selections")
        ? Response.json({ error: "boom" }, { status: 500 })
        : undefined;
    await goTo(/Behavior/);
    fireEvent.click(await behaviorSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(stub).length).toBe(1));
    await waitFor(() => expect(dirty(/Behavior/)).toBe(false));
    await goTo(/Tools/);
    expect((await field()).value).toBe("rascunho.com.br");
    expect(dirty(/Tools/)).toBe(true);
  });

  test("it lights the Tools tab's unsaved dot, not Behavior's", async () => {
    await openTools();
    expect(dirty(/Tools/)).toBe(false);
    await typeHosts("outro.com.br");
    await waitFor(() => expect(dirty(/Tools/)).toBe(true));
    expect(dirty(/Behavior/)).toBe(false);
  });

  test("the Behavior tab no longer draws the section", async () => {
    await openTools();
    await goTo(/Behavior/);
    await behaviorSwitch();
    // NOTE: booleans: a failed expectation holding a node serializes the whole tree and stalls.
    expect({
      labelled: screen.queryByLabelText("Allowed hosts") !== null,
      field: hostsField() !== null,
    }).toEqual({ labelled: false, field: false });
  });

  // The save stops at the first section that fails (agents#1520): Tools goes before Knowledge, so a
  // refused Tools write leaves the host list and the reviewer both unsaved, and the reviewer unsent.
  test("a failed Tools write leaves the host list and the Knowledge edit unsaved", async () => {
    const stub = await openTools();
    await typeHosts("rascunho.com.br");
    await waitFor(() => expect(dirty(/Tools/)).toBe(true));
    await goTo(/Knowledge/);
    const provider = document
      .getElementById("kb-review")
      ?.querySelector("select");
    if (!provider)
      throw new Error("the reviewer's provider select is not drawn");
    fireEvent.change(provider, { target: { value: "anthropic" } });
    stub.override = (method, path) =>
      method === "PUT" && path.endsWith("/tool-selections")
        ? Response.json({ error: "boom" }, { status: 500 })
        : undefined;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        stub.requests.filter(
          (r) => r === "PUT /api/v1/agents/41/tool-selections",
        ).length,
      ).toBe(1),
    );
    await act(async () => {});
    expect(dirty(/Tools/)).toBe(true);
    expect(dirty(/Knowledge/)).toBe(true);
    expect(patches(stub)).toEqual([]);
  });
});

// The card itself, rendered: the field is on it, and the warning says what an empty list does.
const DELIVERS = new Set<string>(CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES);
const CATALOG = {
  native: NATIVE_TOOL_NAMES.map((n) => ({
    name: n,
    ...(DELIVERS.has(n) ? { deliversToCustomer: true } : {}),
  })),
  rag: RAG_TOOL_NAMES.map((n) => ({ name: n })),
  toolDefinitions: [],
  mcpConnections: [],
  integrationInstances: [],
  knowledgeBases: [],
  codeTools: [],
  documentTemplates: [],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function renderCard(opts: {
  granted: boolean;
  hosts: string;
  observing?: boolean;
}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = String(input).includes("/api/auth/me")
      ? { user: { id: "1", email: "a@b.c", role: "ADMIN" } }
      : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const noop = () => undefined;
  const props = {
    agentId: "1",
    observing: opts.observing ?? false,
    refusals: {
      handoffInstructions: null,
      kanbanInstructions: null,
      attributeInstructions: null,
      labelInstructions: null,
      updateKanbanInstructions: null,
    },
    catalog: CATALOG,
    grants: [
      {
        source: "NATIVE",
        enabledTools: opts.granted
          ? ["skip_reply", "send_image"]
          : ["skip_reply"],
      },
    ],
    onChange: noop,
    onCatalogChange: noop,
    transferWithSummary: false,
    setTransferWithSummary: noop,
    handoff: { mode: "", target: "", targetInstanceId: null, instructions: "" },
    setHandoff: noop,
    kanbanInstructions: "",
    setKanbanInstructions: noop,
    customAttributeInstructions: "",
    crossInboxCase: {
      targetInboxId: "",
      targetInstanceId: "",
      originLabel: "",
      caseAttributeKey: "",
      mergeContacts: false,
      resolveOrigin: false,
      subjectTemplate: "",
      openingTemplate: "",
      noteTemplate: "",
    },
    setCrossInboxCase: noop,
    sendImage: { allowedHosts: opts.hosts },
    setSendImage: noop,
    resolveConversation: { assignLabels: [] },
    setResolveConversation: noop,
    setCustomAttributeInstructions: noop,
    labelInstructions: "",
    protectedLabels: "",
    setProtectedLabels: noop,
    allowedLabels: "",
    setAllowedLabels: noop,
    outsideAllowedLabels: "refuse",
    setOutsideAllowedLabels: noop,
    setLabelInstructions: noop,
    updateKanbanTaskInstructions: "",
    setUpdateKanbanTaskInstructions: noop,
    mcpTools: {},
    setMcpTools: noop,
    mcpInstructions: {},
    setMcpInstructions: noop,
    mcpCollapsed: {},
    setMcpCollapsed: noop,
    integrationCollapsed: {},
    setIntegrationCollapsed: noop,
  };
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <ToolGrantsEditor
              {...(props as unknown as Parameters<typeof ToolGrantsEditor>[0])}
            />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const ready = () =>
  waitFor(() =>
    expect(screen.queryAllByText("Skip reply").length).toBeGreaterThan(0),
  );
// A tool loaded already granted starts with its config collapsed; the warning must not depend on it
// being opened, the field is behind the disclosure.
const expand = () => {
  const toggle = screen.getByRole("button", { name: "Settings" });
  fireEvent.click(toggle);
};
const hostsField = () =>
  document.querySelector<HTMLTextAreaElement>(
    'textarea[placeholder="cdn.minhaloja.com.br"]',
  );

describe("the send_image card", () => {
  test("granted with no host: the field is on the card and the warning says every call is refused", async () => {
    renderCard({ granted: true, hosts: "" });
    await ready();
    expect(screen.queryAllByText("Send image").length).toBeGreaterThan(0);
    // NOTE: collapsed, as it loads: the warning is already on screen.
    expect(hostsField()).toBeNull();
    expect(screen.queryByText(WARNING)).not.toBeNull();
    expand();
    expect(hostsField()).not.toBeNull();
    // NOTE: a single textarea keeps its label: the field is named "Allowed hosts".
    expect(screen.getByLabelText("Allowed hosts")).toBe(
      hostsField() as HTMLTextAreaElement,
    );
  });

  test("granted with a host the reader accepts: no warning, the list is shown", async () => {
    renderCard({ granted: true, hosts: "cdn.loja.com.br" });
    await ready();
    expand();
    expect(hostsField()?.value).toBe("cdn.loja.com.br");
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  test("granted with only lines the reader drops: still warned", async () => {
    renderCard({ granted: true, hosts: "not a host" });
    await ready();
    expect(screen.queryByText(WARNING)).not.toBeNull();
  });

  test("not granted: nothing to warn about", async () => {
    renderCard({ granted: false, hosts: "" });
    await ready();
    expect(screen.queryAllByText("Send image").length).toBeGreaterThan(0);
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  test("the card replaces the grid entry, and its dot says a usable list is set", async () => {
    // One title: the tool left the simple-toggle grid for its own card.
    const dots = () =>
      document.querySelectorAll(
        'span.rounded-full.bg-accent-solid[aria-hidden="true"]',
      ).length;
    renderCard({ granted: true, hosts: "cdn.loja.com.br" });
    await ready();
    expect(screen.queryAllByText("Send image")).toHaveLength(1);
    // The card's own dot and the section header's, both lit by a usable list.
    const lit = dots();
    cleanup();
    renderCard({ granted: true, hosts: "not a host" });
    await ready();
    expect(lit - dots()).toBe(2);
  });

  test("an agent that only observes is not offered the card at all", async () => {
    renderCard({ granted: true, hosts: "", observing: true });
    await ready();
    expect(screen.queryByText("Send image")).toBeNull();
    expect(hostsField()).toBeNull();
  });
});
