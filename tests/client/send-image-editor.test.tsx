/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// Issue #880: `sendImage.allowedHosts` is config OF the send_image tool, and an empty list makes the
// tool refuse every call while it is still offered to the model. It lived in the Behavior tab, so the
// operator granting the tool on the Tools tab saw nothing saying a list existed, or that it was empty.
// It is edited on the tool's own card now and written by the Tools save, the way `crossInboxCase` and
// `handoff` are. Two saves write the same settings column and each resends the whole bag, so the
// ownership has to be exact on both sides.

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
const { rebaseToolGrants } = await import(
  "@/client/pages/agents/toolsBaseline"
);

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

describe("which save owns the block (source)", () => {
  const src = readFileSync(
    "src/client/pages/agents/AgentEditorPage.tsx",
    "utf8",
  );
  const slice = (from: string, to: string) => {
    const start = src.indexOf(from);
    expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
    const end = src.indexOf(to, start + from.length);
    expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(-1);
    return src.slice(start, end);
  };

  test("the Tools save writes it and keeps the shared bag in step", () => {
    const body = slice("async function saveTools(", "\n  }\n");
    expect(body).toContain(
      "const sendImageJson = serializeSendImage(sendImage);",
    );
    expect(body.match(/sendImage: sendImageJson,/g)?.length ?? 0).toBe(2);
  });

  test("the Behavior save does not name it, so it cannot write a stale form over it", () => {
    const body = slice("function buildSettings(", "\n  }\n");
    expect(body).toContain("...settings,");
    expect(body).not.toContain("sendImage");
  });

  test("it is re-read with the other tool config, not by a Behavior load or revert", () => {
    const body = slice("const syncToolConfig = useCallback(", "}, []);");
    expect(body).toContain("setSendImage(b.sendImage);");
    expect(src.match(/setSendImage\(b\.sendImage\)/g)?.length).toBe(1);
  });

  test("it lights the Tools tab's unsaved dot, not Behavior's", () => {
    expect(slice("tools: JSON.stringify({", "}),")).toContain("sendImage,");
    expect(slice("behavior: JSON.stringify({", "}),")).not.toContain(
      "sendImage",
    );
  });

  test("the Behavior tab no longer draws the section", () => {
    const behavior = readFileSync(
      "src/client/pages/agents/BehaviorTab.tsx",
      "utf8",
    );
    expect(behavior).not.toContain("sendImage");
  });
});

// Review round 1 of #887: the Knowledge save writes the grant set and none of the Tools config, so it
// may move only the grants half of the Tools baseline. Before, it recaptured all of it, and a host list
// typed and not saved stopped reading as unsaved.
describe("the Knowledge save leaves unsaved tool config dirty", () => {
  test("only the grants move", () => {
    const baseline = JSON.stringify({
      grants: ["old"],
      sendImage: { allowedHosts: "" },
    });
    const snapshot = JSON.stringify({
      grants: ["new"],
      sendImage: { allowedHosts: "cdn.loja.com.br" },
    });
    const rebased = rebaseToolGrants(baseline, snapshot);
    expect(JSON.parse(rebased)).toEqual({
      grants: ["new"],
      sendImage: { allowedHosts: "" },
    });
    // Still dirty against the live snapshot, and clean once the config matches again.
    expect(rebased).not.toBe(snapshot);
    expect(
      rebaseToolGrants(
        baseline,
        JSON.stringify({ ...JSON.parse(baseline), grants: ["new"] }),
      ),
    ).toBe(JSON.stringify({ ...JSON.parse(baseline), grants: ["new"] }));
  });

  test("the Knowledge save asks for it, and the recapture honors it", () => {
    const src = readFileSync(
      "src/client/pages/agents/AgentEditorPage.tsx",
      "utf8",
    );
    const start = src.indexOf("async function saveGrants(");
    const body = src.slice(start, src.indexOf("\n  }\n", start));
    expect(body).toContain("toolGrantsOnlyRef.current = true;");
    expect(src).toContain(
      "rebaseToolGrants(baselineRef.current.tools, sectionSnap.tools)",
    );
    // The flag is what picks that branch, and the Tools recapture is what consumes it.
    expect(src).toContain(
      'const grantsOnly = k === "tools" && toolGrantsOnlyRef.current;',
    );
    expect(src).toContain("[k]: grantsOnly");
    const save = src.indexOf("async function saveTools(");
    expect(src.slice(save, src.indexOf("\n  }\n", save))).not.toContain(
      "toolGrantsOnlyRef",
    );
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
    },
    setCrossInboxCase: noop,
    sendImage: { allowedHosts: opts.hosts },
    setSendImage: noop,
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
    // Collapsed, as it loads: the warning is already on screen.
    expect(hostsField()).toBeNull();
    expect(screen.queryByText(WARNING)).not.toBeNull();
    expand();
    expect(hostsField()).not.toBeNull();
    // A single textarea keeps its label: the field is named "Allowed hosts" (review round 1 of #887).
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
        'span.rounded-full.bg-accent[aria-hidden="true"]',
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
