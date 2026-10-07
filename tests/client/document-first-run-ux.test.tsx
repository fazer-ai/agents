/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The first time an operator makes a document: the starter menu says how a template gets its
// content, the blank starter brings nothing of the menu into the template, the editor speaks the
// operator's language and points at where an AI assistant is connected, and the letterhead editor
// opens with the name the account was set up with.
// Assertions reduce to a boolean or a string BEFORE expect: a failing expectation that holds a DOM
// node serializes a cyclic happy-dom tree and stalls the runner.

(globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
  "http://localhost/recursos/documentos",
);

const { default: i18n } = await import("@/client/lib/i18n");
const { DocumentsPanel } = await import(
  "@/client/pages/resources/documents/DocumentsPanel"
);
const { ToastProvider } = await import("@/client/components");
const { SelectableCard } = await import("@/client/components/SelectableCard");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { AuthContext } = await import("@/client/contexts/AuthContext");

const STYLE = {
  font: "sans",
  baseFontSize: 10,
  accentColor: "#1e3a8a",
  margin: "normal",
  pageSize: "A4",
  locale: "en-US",
  currency: "USD",
  showPageNumbers: true,
  footerText: "{{company_name}} · {{doc_number}}",
};
const QUOTE = {
  key: "quote",
  name: "Quote",
  summary: "A quote with line items, a discount and a validity date.",
  suggestedName: "Quote",
  description: "A quote with line items, a discount and a validity date.",
  numberPrefix: "QT-",
  blocks: [
    { id: "header", type: "header", title: "{{doc_title}} {{doc_number}}" },
    { id: "intro", type: "text", text: "Dear {{client}}," },
    { id: "terms", type: "text", text: "Valid until {{validity}}." },
  ],
  fields: [
    { name: "client", label: "Client", type: "text", required: true },
    { name: "items", label: "Items", type: "lineItems", required: true },
    { name: "validity", label: "Validity", type: "date" },
  ],
  style: STYLE,
};
const BLANK = {
  key: "blank",
  name: "Blank",
  summary: "Only the header, to build with your AI assistant over MCP.",
  suggestedName: "",
  description: null,
  numberPrefix: "",
  blocks: [
    { id: "header", type: "header", title: "{{doc_title}} {{doc_number}}" },
  ],
  fields: [],
  style: STYLE,
};
const EMPTY_COMPANY = {
  name: "",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: null,
  logoVersion: 0,
};

const realFetch = globalThis.fetch;
let posted: Record<string, unknown>[] = [];
let storedCompany = EMPTY_COMPANY;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname.endsWith("/document-templates/preview")) {
    return new Response(new Blob(["%PDF-1.7"]), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
  }
  if (method === "POST" && url.pathname.endsWith("/document-templates")) {
    const sent = JSON.parse(String(init?.body ?? "{}"));
    posted.push(sent);
    return json({
      template: {
        id: "7",
        name: sent.name,
        slug: "x",
        toolName: "send_x",
        description: sent.description ?? null,
        numberPrefix: sent.numberPrefix ?? null,
        enabled: true,
        blocks: sent.blocks,
        fields: sent.fields,
        style: sent.style,
      },
    });
  }
  if (url.pathname.endsWith("/document-templates/starters")) {
    return json({ starters: [QUOTE, BLANK] });
  }
  if (url.pathname.endsWith("/document-templates")) {
    return json({ templates: [] });
  }
  if (url.pathname.endsWith("/tenant-settings")) {
    return json({ company: storedCompany });
  }
  return json({ documents: [] });
}) as unknown as typeof fetch;

afterEach(() => {
  cleanup();
  posted = [];
  storedCompany = EMPTY_COMPANY;
});
const startingLanguage = i18n.language;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await i18n.changeLanguage(startingLanguage);
});

function renderPanel(tenantName: string | null = null) {
  const auth = { user: tenantName ? { tenantName } : null } as never;
  render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <AuthContext.Provider value={auth}>
        <NavGuardProvider>
          <ToastProvider>
            <DocumentsPanel />
          </ToastProvider>
        </NavGuardProvider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

async function openPicker() {
  const button = (await screen.findAllByText("New template"))[0];
  if (!button) throw new Error("no new-template button");
  fireEvent.click(button);
  await screen.findAllByText("Use");
}

async function pick(index: number) {
  const use = (await screen.findAllByText("Use"))[index];
  if (!use) throw new Error("no starter");
  fireEvent.click(use);
  return (await screen.findByRole("textbox")) as HTMLInputElement;
}

function dialogText(): string {
  return screen
    .queryAllByRole("dialog")
    .map((d) => d.textContent ?? "")
    .join("\n");
}

describe("the starter picker", () => {
  test("does not call every option ready-made, and says how fields and blocks are added", async () => {
    await i18n.changeLanguage("en");
    renderPanel();
    await openPicker();
    const text = dialogText();
    expect(text.includes("Start from a template")).toBe(false);
    expect(/MCP/.test(text)).toBe(true);
  });

  test("shows each starter's summary", async () => {
    await i18n.changeLanguage("en");
    renderPanel();
    await openPicker();
    expect(dialogText().includes(BLANK.summary)).toBe(true);
  });

  test("the pt-BR hint names MCP too", async () => {
    await i18n.changeLanguage("pt-BR");
    renderPanel();
    const button = (await screen.findAllByText("Novo modelo"))[0];
    if (!button) throw new Error("no new-template button");
    fireEvent.click(button);
    await screen.findAllByText("Usar");
    const text = dialogText();
    expect(/MCP/.test(text)).toBe(true);
    expect(text.includes("Começar por um modelo pronto")).toBe(false);
  });
});

describe("the blank starter", () => {
  test("suggests no name, and Create waits for one", async () => {
    await i18n.changeLanguage("en");
    renderPanel();
    await openPicker();
    const input = await pick(1);
    expect(input.value).toBe("");
    const create = screen.getByRole("button", { name: /^create$/i });
    expect((create as HTMLButtonElement).disabled).toBe(true);
  });

  test("creates a template with no description", async () => {
    await i18n.changeLanguage("en");
    renderPanel();
    await openPicker();
    const input = await pick(1);
    fireEvent.change(input, { target: { value: "Service agreement" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => {
      expect(posted.length).toBe(1);
    });
    expect(posted[0]?.description ?? null).toBeNull();
    expect(posted[0]?.name).toBe("Service agreement");
  });

  test("a ready-made one still suggests its own name", async () => {
    await i18n.changeLanguage("en");
    renderPanel();
    await openPicker();
    const input = await pick(0);
    expect(input.value).toBe("Quote");
  });
});

async function openEditorFrom(index: number, name: string) {
  renderPanel();
  await openPicker();
  const input = await pick(index);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
  await screen.findByText("Edit document template", undefined, {
    timeout: 3000,
  });
}

describe("the editor", () => {
  test("an empty template says to build it with an AI assistant, and links to the MCP settings", async () => {
    await i18n.changeLanguage("en");
    await openEditorFrom(1, "Service agreement");
    const links = screen
      .queryAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "");
    expect(links.includes("/settings/mcp")).toBe(true);
    expect(dialogText().includes("Build this template with AI")).toBe(true);
  });

  test("a template with fields keeps the link but not the empty-state box", async () => {
    await i18n.changeLanguage("en");
    await openEditorFrom(0, "Quote");
    const links = screen
      .queryAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "");
    expect(links.includes("/settings/mcp")).toBe(true);
    expect(dialogText().includes("Build this template with AI")).toBe(false);
  });

  test("style options, text blocks and fields read as words, not identifiers", async () => {
    await i18n.changeLanguage("pt-BR");
    renderPanel();
    const button = (await screen.findAllByText("Novo modelo"))[0];
    if (!button) throw new Error("no new-template button");
    fireEvent.click(button);
    const use = (await screen.findAllByText("Usar"))[0];
    if (!use) throw new Error("no starter");
    fireEvent.click(use);
    fireEvent.click(await screen.findByRole("button", { name: /^criar$/i }));
    await screen.findByText("Editar modelo de documento", undefined, {
      timeout: 3000,
    });
    const options = Array.from(document.querySelectorAll("option")).map(
      (o) => o.textContent ?? "",
    );
    for (const raw of [
      "sans",
      "serif",
      "mono",
      "narrow",
      "normal",
      "wide",
      "LETTER",
    ]) {
      expect(options.includes(raw)).toBe(false);
    }
    const labels = Array.from(document.querySelectorAll("label")).map(
      (l) => l.textContent ?? "",
    );
    expect(labels.includes("intro")).toBe(false);
    expect(labels.includes("terms")).toBe(false);
    const text = dialogText();
    expect(/\b\w+: (text|lineItems|currency|date)\b/.test(text)).toBe(false);
    expect(text.includes("Client")).toBe(true);
  });
});

describe("the letterhead editor", () => {
  async function openLetterhead() {
    const button = await screen.findByRole("button", {
      name: /preencher|fill in/i,
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.queryAllByRole("dialog").length).toBe(1);
    });
  }

  test("says its title once", async () => {
    await i18n.changeLanguage("en");
    renderPanel();
    await openLetterhead();
    const count = dialogText().split("Company profile").length - 1;
    expect(count).toBe(1);
  });

  test("does not replace a company name already saved", async () => {
    await i18n.changeLanguage("en");
    storedCompany = { ...EMPTY_COMPANY, name: "Stored Co" };
    renderPanel("Acme Serviços Ltda");
    const button = await screen.findByRole("button", { name: /^edit$/i });
    fireEvent.click(button);
    await waitFor(() => {
      const first = screen.getAllByRole("textbox")[0] as HTMLInputElement;
      expect(first.value).toBe("Stored Co");
    });
    await new Promise((r) => setTimeout(r, 50));
    const first = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    expect(first.value).toBe("Stored Co");
  });

  test("offers the name the account was set up with", async () => {
    await i18n.changeLanguage("en");
    renderPanel("Acme Serviços Ltda");
    await openLetterhead();
    await waitFor(() => {
      const first = screen.getAllByRole("textbox")[0] as HTMLInputElement;
      expect(first.value).toBe("Acme Serviços Ltda");
    });
  });
});

describe("a selectable card", () => {
  test("wraps a long title instead of truncating it", () => {
    render(
      <SelectableCard
        selected
        onToggle={() => {}}
        title="Orçamento de tratamento ortodôntico completo"
        badge={<span>send_orcamento_de_tratamento_ortodontico_completo</span>}
      />,
    );
    const title = screen.getByText(
      "Orçamento de tratamento ortodôntico completo",
    );
    expect(title.className.includes("truncate")).toBe(false);
    expect(!!title.closest("[data-selectable-content]")).toBe(true);
  });
});
