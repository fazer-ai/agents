/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The Documents section creates a template where every other section creates its resource: in place,
// through the same two-step starter flow Components uses, with the new template granted to this
// agent and opened in its editor. Nothing navigates, so the editor's unsaved state survives.
// Assertions reduce to a boolean or a string BEFORE expect: a failing expectation that holds a DOM
// node serializes a cyclic happy-dom tree and stalls the runner.

const { ToolGrantsEditor } = await import(
  "@/client/pages/agents/ToolGrantsEditor"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const { default: i18n } = await import("@/client/lib/i18n");
const { NATIVE_TOOL_NAMES, RAG_TOOL_NAMES } = await import(
  "@/graph/tools/catalog"
);

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const STYLE = {
  font: "sans",
  baseFontSize: 10,
  accentColor: "#1e3a8a",
  margin: "normal",
  pageSize: "A4",
  locale: "en-US",
  currency: "USD",
  showPageNumbers: true,
};

const CREATED = {
  id: "41",
  name: "Installation quote",
  slug: "installation_quote",
  toolName: "send_installation_quote",
  description: null,
  numberPrefix: "Q-",
  enabled: true,
  blocks: [{ id: "body", type: "text", text: "Hello." }],
  fields: [],
  style: STYLE,
};

function catalogWith(templates: unknown[]) {
  return {
    native: NATIVE_TOOL_NAMES.map((n) => ({ name: n })),
    rag: RAG_TOOL_NAMES.map((n) => ({ name: n })),
    toolDefinitions: [],
    mcpConnections: [],
    integrationInstances: [],
    knowledgeBases: [],
    codeTools: [],
    documentTemplates: templates,
  };
}
const CATALOG = catalogWith([
  {
    id: "3",
    name: "Quote",
    toolName: "send_quote",
    description: null,
    enabled: true,
    available: true,
  },
]);

let starterLocales: string[] = [];
let posts = 0;
// Holds the starters response for one locale until released, so a test decides which lands when.
let hold: { locale: string; wait: Promise<void>; release: () => void } | null =
  null;
function holdStarters(locale: string) {
  let release = () => {};
  const wait = new Promise<void>((r) => {
    release = r;
  });
  hold = { locale, wait, release };
  return hold;
}

function serve() {
  starterLocales = [];
  posts = 0;
  hold = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname.endsWith("/document-templates/preview")) {
      return new Response(new Blob(["%PDF-1.7"]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (url.pathname.endsWith("/document-templates/starters")) {
      const locale = url.searchParams.get("locale") ?? "";
      starterLocales.push(locale);
      if (hold?.locale === locale) await hold.wait;
      return json({
        starters: [
          {
            key: "quote",
            name: `Quote ${locale}`,
            description: "Quote with items.",
            numberPrefix: "Q-",
            blocks: CREATED.blocks,
            fields: [],
            style: { ...STYLE, locale },
          },
        ],
      });
    }
    if (method === "POST" && url.pathname.endsWith("/document-templates")) {
      posts++;
      const sent = JSON.parse(String(init?.body ?? "{}"));
      return json({ template: { ...CREATED, name: sent.name } });
    }
    return json({});
  }) as typeof fetch;
}

function renderEditor(
  opts: {
    catalog?: unknown;
    observing?: boolean;
    onChange?: (grants: unknown[]) => void;
    onCatalogChange?: () => void;
  } = {},
) {
  const noop = () => undefined;
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <ToolGrantsEditor
              agentId="1"
              refusals={{
                handoffInstructions: null,
                kanbanInstructions: null,
                attributeInstructions: null,
                labelInstructions: null,
                updateKanbanInstructions: null,
              }}
              observing={opts.observing}
              catalog={(opts.catalog ?? CATALOG) as never}
              grants={[]}
              onChange={(opts.onChange ?? noop) as never}
              onCatalogChange={opts.onCatalogChange ?? noop}
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

async function documentsSection(): Promise<HTMLElement> {
  await screen.findAllByText(/HTTP tools|Ferramentas HTTP/);
  const section = document.getElementById("tools-documents");
  if (!section) throw new Error("no Documents section");
  return section;
}

test("the Documents section offers New, like its siblings", async () => {
  await i18n.changeLanguage("en");
  serve();
  renderEditor();
  const section = await documentsSection();
  expect(
    within(section).queryAllByRole("button", { name: /^new$/i }).length,
  ).toBe(1);
});

test("with no templates the empty state points at the action, not at Components", async () => {
  await i18n.changeLanguage("en");
  serve();
  renderEditor({ catalog: catalogWith([]) });
  const section = await documentsSection();
  const text = section.textContent ?? "";
  expect(
    within(section).queryAllByRole("button", { name: /^new$/i }).length,
  ).toBe(1);
  expect(/Components/.test(text)).toBe(false);
});

test("creating from the editor grants the new template and opens it", async () => {
  await i18n.changeLanguage("en");
  serve();
  const emitted: unknown[][] = [];
  let refetched = 0;
  renderEditor({
    onChange: (g) => emitted.push(g),
    onCatalogChange: () => {
      refetched++;
    },
  });
  const section = await documentsSection();
  fireEvent.click(within(section).getByRole("button", { name: /^new$/i }));
  fireEvent.click((await screen.findAllByText("Use"))[0] as HTMLElement);
  const input = (await screen.findByDisplayValue(
    "Quote en-US",
  )) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Installation quote" } });
  fireEvent.click(await screen.findByRole("button", { name: /^create$/i }));

  await screen.findByText("Edit document template", undefined, {
    timeout: 3000,
  });
  expect(starterLocales.join(",")).toBe("en-US");
  expect(posts).toBe(1);
  const last = JSON.stringify(emitted.at(-1) ?? []);
  expect(
    last.includes('"source":"DOCUMENT"') &&
      last.includes('"documentTemplateId":"41"'),
  ).toBe(true);
  expect(refetched).toBeGreaterThan(0);
  await waitFor(() => {
    expect(!!screen.queryByText("Name this template")).toBe(false);
  });
});

test("a watcher has no Documents section and so no New for it", async () => {
  await i18n.changeLanguage("en");
  serve();
  renderEditor({ observing: true });
  await screen.findAllByText(/HTTP tools|Ferramentas HTTP/);
  expect(!!document.getElementById("tools-documents")).toBe(false);
});

// A list in another language also carries another currency, so the picker must never show the
// starters of a language the console has left: neither a response that lands after the switch, nor
// the list already on screen when the switch happens.
test("a language switch while the starters load shows the new language's list", async () => {
  await i18n.changeLanguage("en");
  serve();
  const held = holdStarters("en-US");
  renderEditor();
  const section = await documentsSection();
  fireEvent.click(within(section).getByRole("button", { name: /^new$/i }));
  await waitFor(() => {
    expect(starterLocales.length).toBe(1);
  });
  await act(async () => {
    await i18n.changeLanguage("pt-BR");
  });
  held.release();
  await waitFor(
    () => {
      expect(document.body.textContent?.includes("Quote pt-BR")).toBe(true);
    },
    { timeout: 3000 },
  );
  expect(document.body.textContent?.includes("Quote en-US")).toBe(false);
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});

test("a language switch with the picker open reloads the list", async () => {
  await i18n.changeLanguage("en");
  serve();
  renderEditor();
  const section = await documentsSection();
  fireEvent.click(within(section).getByRole("button", { name: /^new$/i }));
  await screen.findByText("Quote en-US");
  await act(async () => {
    await i18n.changeLanguage("pt-BR");
  });
  await waitFor(
    () => {
      expect(document.body.textContent?.includes("Quote pt-BR")).toBe(true);
    },
    { timeout: 3000 },
  );
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});

test("an older list landing after a newer one does not replace it", async () => {
  await i18n.changeLanguage("en");
  serve();
  renderEditor();
  const section = await documentsSection();
  fireEvent.click(within(section).getByRole("button", { name: /^new$/i }));
  await screen.findByText("Quote en-US");
  const held = holdStarters("pt-BR");
  await act(async () => {
    await i18n.changeLanguage("pt-BR");
  });
  await waitFor(() => {
    expect(starterLocales.filter((l) => l === "pt-BR").length).toBe(1);
  });
  await act(async () => {
    await i18n.changeLanguage("en");
  });
  await waitFor(() => {
    expect(starterLocales.filter((l) => l === "en-US").length).toBe(2);
  });
  held.release();
  await new Promise((r) => setTimeout(r, 80));
  expect(document.body.textContent?.includes("Quote en-US")).toBe(true);
  expect(document.body.textContent?.includes("Quote pt-BR")).toBe(false);
});

test("the old language's list is not offered while the new one loads", async () => {
  await i18n.changeLanguage("en");
  serve();
  renderEditor();
  const section = await documentsSection();
  fireEvent.click(within(section).getByRole("button", { name: /^new$/i }));
  await screen.findByText("Quote en-US");
  const held = holdStarters("pt-BR");
  await act(async () => {
    await i18n.changeLanguage("pt-BR");
  });
  await waitFor(() => {
    expect(starterLocales.filter((l) => l === "pt-BR").length).toBe(1);
  });
  expect(document.body.textContent?.includes("Quote en-US")).toBe(false);
  expect(screen.queryAllByRole("button", { name: /^(use|usar)$/i })).toEqual(
    [],
  );
  held.release();
  await screen.findByText("Quote pt-BR");
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});

// A starter carries its currency, so one picked in the language the console has since left is not
// the one to create: the dialog goes back to the list in the new language.
test("a starter picked before a language switch is not the one created", async () => {
  await i18n.changeLanguage("en");
  serve();
  renderEditor();
  const section = await documentsSection();
  fireEvent.click(within(section).getByRole("button", { name: /^new$/i }));
  await screen.findByText("Quote en-US");
  fireEvent.click(screen.getByRole("button", { name: /^use$/i }));
  await screen.findByDisplayValue("Quote en-US");
  await act(async () => {
    await i18n.changeLanguage("pt-BR");
  });
  await screen.findByText("Quote pt-BR");
  expect(screen.queryAllByDisplayValue("Quote en-US")).toEqual([]);
  expect(posts).toBe(0);
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});

// Creating is the operator moving on from whatever they opened before: an existing template whose
// fetch answers after the new one is open must not take the editor, or its Save writes the new
// template's draft over the old one.
test("an older template's slow open does not take the editor of a just-created one", async () => {
  await i18n.changeLanguage("en");
  serve();
  const served = globalThis.fetch;
  let releaseOld = () => {};
  const old = new Promise<void>((r) => {
    releaseOld = r;
  });
  const patched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PATCH") {
      patched.push(url.pathname);
      return json({ template: CREATED });
    }
    if (method === "GET" && url.pathname.endsWith("/document-templates/3")) {
      await old;
      return json({ template: { ...CREATED, id: "3", name: "Quote" } });
    }
    return served(input, init);
  }) as typeof fetch;
  renderEditor();
  const section = await documentsSection();
  fireEvent.click(within(section).getByLabelText(/preview/i));
  fireEvent.click(within(section).getByRole("button", { name: /^new$/i }));
  fireEvent.click((await screen.findAllByText("Use"))[0] as HTMLElement);
  const input = (await screen.findByDisplayValue(
    "Quote en-US",
  )) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Installation quote" } });
  fireEvent.click(await screen.findByRole("button", { name: /^create$/i }));
  await screen.findByText("Edit document template", undefined, {
    timeout: 3000,
  });
  releaseOld();
  await new Promise((r) => setTimeout(r, 80));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByDisplayValue("Installation quote"), {
    target: { value: "Installation quote 2" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
  await waitFor(() => {
    expect(patched.length).toBeGreaterThan(0);
  });
  expect(patched).toEqual(["/api/v1/document-templates/41"]);
});

// The other order: New, then a pencil while the starters are still loading. The pencil is the last
// click, so the picker must not open over that template's editor.
test("opening a template while the starters load cancels the create flow", async () => {
  await i18n.changeLanguage("en");
  serve();
  const held = holdStarters("en-US");
  renderEditor();
  const section = await documentsSection();
  fireEvent.click(within(section).getByRole("button", { name: /^new$/i }));
  await waitFor(() => {
    expect(starterLocales.length).toBe(1);
  });
  const served = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/document-templates/3")) {
      return json({ template: { ...CREATED, id: "3", name: "Quote" } });
    }
    return served(input, init);
  }) as typeof fetch;
  fireEvent.click(within(section).getByLabelText(/preview/i));
  await screen.findByText("Edit document template");
  held.release();
  await new Promise((r) => setTimeout(r, 80));
  const dialogs = screen
    .queryAllByRole("dialog")
    .map((d) => d.textContent ?? "");
  expect(dialogs.some((d) => d.includes("Start from a template"))).toBe(false);
  expect(screen.queryAllByDisplayValue("Quote").length).toBeGreaterThan(0);
});
