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
import { MemoryRouter } from "react-router";

// Granting a document template is the one grant whose target has a PICTURE, and the row alone (name,
// tool name, one line of description) does not answer what the operator is deciding: what does this
// print? The pencil opens the same modal Components uses, so the preview and the wording are
// reachable from where the decision is made.
//
// The catalog row is a projection, so the modal's payload has to be FETCHED — which is what the two
// hazards below are about, and neither is visible without a test: a second click while the first
// request is out, and a response that lands after the operator moved on.

const { ToolGrantsEditor } = await import(
  "@/client/pages/agents/ToolGrantsEditor"
);
const { ToastProvider } = await import("@/client/components/Toast");
// The REAL provider, not a module mock: `mock.module` is global to the process and its restore tears
// down other files' mocks. It boots by fetching /api/auth/me, which the stubs below answer.
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");

const realFetch = globalThis.fetch;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const TEMPLATE = {
  id: "3",
  name: "Orçamento",
  slug: "orcamento",
  toolName: "send_orcamento",
  description: "Orçamento com itens.",
  enabled: true,
  numberPrefix: "ORC-",
  blocks: [{ id: "corpo", type: "text", text: "Olá." }],
  fields: [],
  style: {
    font: "sans",
    baseFontSize: 10,
    accentColor: "#1d4ed8",
    margin: "normal",
    pageSize: "A4",
    locale: "pt-BR",
    currency: "BRL",
    footerText: null,
    showPageNumbers: false,
  },
};

const { NATIVE_TOOL_NAMES, RAG_TOOL_NAMES } = await import(
  "@/graph/tools/catalog"
);

// The catalog exactly as the API builds it, with only the document half filled: the native and RAG
// lists come from the same constants the server maps, so a tool added there cannot leave this
// fixture describing a screen that no longer exists.
const CATALOG = {
  native: NATIVE_TOOL_NAMES.map((n) => ({ name: n })),
  rag: RAG_TOOL_NAMES.map((n) => ({ name: n })),
  toolDefinitions: [],
  mcpConnections: [],
  integrationInstances: [],
  knowledgeBases: [],
  documentTemplates: [
    {
      id: "3",
      name: "Orçamento",
      toolName: "send_orcamento",
      description: "Orçamento com itens.",
      enabled: true,
      available: true,
    },
    {
      id: "4",
      name: "Recibo",
      toolName: "send_recibo",
      description: "Recibo simples.",
      enabled: true,
      available: true,
    },
  ],
};

function renderEditor() {
  const noop = () => undefined;
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <ToolGrantsEditor
              agentId="1"
              catalog={CATALOG as never}
              grants={[]}
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
              setLabelInstructions={noop}
              updateKanbanTaskInstructions=""
              setUpdateKanbanTaskInstructions={noop}
              mcpTools={{}}
              setMcpTools={noop}
              mcpInstructions={{}}
              setMcpInstructions={noop}
              mcpCollapsed={{}}
              setMcpCollapsed={noop}
              integrationCollapsed={{}}
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

// By its own label, not by position: the section renders one card per template and the label is what
// an assistive-technology user reads. Awaited because AuthProvider holds the tree behind a spinner
// until its own /me request answers.
async function pencils(): Promise<HTMLElement[]> {
  return screen.findAllByLabelText(/pré-visualizar|preview/i);
}

// The first card is the quote template (id 3); the second is the receipt (id 4).
async function pencil(which: 0 | 1 = 0): Promise<HTMLElement> {
  return (await pencils())[which] as HTMLElement;
}

test("the pencil on a document card fetches the template and opens its editor", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname);
    if (url.pathname.endsWith("/document-templates/3"))
      return json({ template: TEMPLATE });
    return json({});
  }) as typeof fetch;

  renderEditor();
  fireEvent.click(await pencil());

  await waitFor(() => {
    expect(calls.some((p) => p.endsWith("/document-templates/3"))).toBe(true);
  });
  // The modal is open on THIS template: its name is in a field, which the card alone never shows.
  await waitFor(() => {
    const found = screen.queryAllByDisplayValue("Orçamento").length > 0;
    expect(found).toBe(true);
  });
});

// Clicking twice must not start two fetches. Not cosmetic: whichever lands last decides which modal
// the operator gets, so on a slow link a double click on one card is a coin flip between two
// identical-looking opens — and with two different cards, the wrong template under the right name.
test("a second click while the first request is out does not fetch again", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let fetches = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/document-templates/3")) {
      fetches++;
      await held;
      return json({ template: TEMPLATE });
    }
    return json({});
  }) as typeof fetch;

  renderEditor();
  fireEvent.click(await pencil(0));
  await waitFor(() => {
    expect(fetches).toBe(1);
  });
  // Re-queried between clicks rather than reusing the handle from before the first one. Not style:
  // fired back to back on the captured node the extra clicks never reached the handler, so the
  // assertion held with the guard REMOVED — a test passing for the wrong reason. The await is what
  // lets React flush the disabled state the guard sets.
  fireEvent.click(await pencil(0));
  fireEvent.click(await pencil(0));
  expect(fetches).toBe(1);
  release?.();
  await waitFor(() => {
    expect(screen.queryAllByDisplayValue("Orçamento").length > 0).toBe(true);
  });
});

test("a failure says so instead of opening an empty editor", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/document-templates/3")) {
      // A transport failure, the way an offline click produces one. Measured: Eden hands this back
      // as `{ error }` rather than rejecting, so what this covers is the `err` branch — the `catch`
      // beside it is a net nothing here reaches.
      throw new Error("offline");
    }
    return json({});
  }) as typeof fetch;

  renderEditor();
  fireEvent.click(await pencil());

  await waitFor(() => {
    expect(
      screen.queryAllByText(/não foi possível|could not/i).length,
    ).toBeGreaterThan(0);
  });
  // …and the button is usable again, rather than stuck in its loading state.
  expect(((await pencil()) as HTMLButtonElement).disabled).toBe(false);
});

// Two DIFFERENT cards, which the busy flag above does not cover: it disables the card being opened,
// not its neighbour. So an operator who clicks the quote, gets impatient and clicks the receipt has
// two requests out, and whichever answers last would decide the modal — showing the quote's blocks
// under the receipt's name. The session token is what makes the LAST CLICK win instead of the last
// response.
test("a slow template that answers after the operator moved on does not take the modal", async () => {
  let releaseSlow: (() => void) | undefined;
  const slow = new Promise<void>((r) => {
    releaseSlow = r;
  });
  const patched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if ((init?.method ?? "GET").toUpperCase() === "PATCH") {
      patched.push(url.pathname);
      return json({ template: TEMPLATE });
    }
    if (url.pathname.endsWith("/document-templates/3")) {
      await slow;
      return json({ template: TEMPLATE });
    }
    if (url.pathname.endsWith("/document-templates/4")) {
      return json({ template: { ...TEMPLATE, id: "4", name: "Recibo" } });
    }
    return json({});
  }) as typeof fetch;

  renderEditor();
  fireEvent.click(await pencil(0));
  fireEvent.click(await pencil(1));

  await waitFor(() => {
    expect(screen.queryAllByDisplayValue("Recibo").length > 0).toBe(true);
  });
  releaseSlow?.();
  await waitFor(() => {
    expect(screen.queryAllByDisplayValue("Recibo").length > 0).toBe(true);
  });

  // The FORM is not where a stale answer shows up, and that is the trap: the modal resets on the
  // false→true open transition only, so a second `open()` while it is already open leaves every
  // field exactly as it was. What it does replace is the PAYLOAD — the id the Save writes to. So the
  // assertion is on the request, not on the screen: without the session token the operator edits the
  // receipt and PATCHes the quote.
  // Scoped to the dialog: the Tools tab has its own save affordances, and the ambiguity would either
  // throw or click the wrong one.
  const dialog = await screen.findByRole("dialog");
  // Edited first: the modal sends nothing when the diff is empty, so a bare Save would assert the
  // absence of a request — which passes just as well when the button was never found.
  fireEvent.change(within(dialog).getByDisplayValue("Recibo"), {
    target: { value: "Recibo editado" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: /^(salvar|save)$/i }),
  );
  await waitFor(() => {
    expect(patched.length).toBeGreaterThan(0);
  });
  expect(patched).toEqual(["/api/v1/document-templates/4"]);
});
