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

// Every template is created in order to be edited, so a successful create from a starter opens the
// new template's editor with the body the POST answered, instead of dropping the operator back on
// the list to find the row they just made. The list still refreshes behind it.
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

const CREATED = {
  id: "41",
  name: "Orçamento de instalação",
  slug: "orcamento_de_instalacao",
  toolName: "send_orcamento_de_instalacao",
  description: null,
  numberPrefix: "ORC-",
  enabled: true,
  blocks: [{ id: "corpo", type: "text", text: "Olá." }],
  fields: [],
  style: {
    font: "sans",
    baseFontSize: 10,
    accentColor: "#111827",
    margin: "normal",
    pageSize: "A4",
    locale: "pt-BR",
    currency: "BRL",
    showPageNumbers: false,
  },
};

const realFetch = globalThis.fetch;
let stored: (typeof CREATED)[] = [];
let listReads = 0;
let refuseCreate = false;

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
    if (refuseCreate) {
      return json(
        { error: { code: "documentTemplateNameTaken", message: "taken" } },
        409,
      );
    }
    const sent = JSON.parse(String(init?.body ?? "{}"));
    const row = { ...CREATED, name: sent.name };
    stored = [row];
    return json({ template: row });
  }
  if (url.pathname.endsWith("/document-templates/starters")) {
    return json({
      starters: [
        {
          key: "quote",
          name: "Orçamento",
          summary: "",
          suggestedName: "Orçamento",
          description: "",
          blocks: [{ id: "corpo", type: "text", text: "Olá." }],
          fields: [],
          style: CREATED.style,
          numberPrefix: "ORC-",
        },
      ],
    });
  }
  if (url.pathname.endsWith("/document-templates")) {
    listReads++;
    return json({ templates: stored });
  }
  if (url.pathname.endsWith("/tenant-settings")) {
    return json({ company: null });
  }
  return json({ documents: [] });
}) as unknown as typeof fetch;

afterEach(() => {
  cleanup();
  stored = [];
  listReads = 0;
  refuseCreate = false;
});
const startingLanguage = i18n.language;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await i18n.changeLanguage(startingLanguage);
});

async function createFromStarter(name: string) {
  render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <ToastProvider>
        <DocumentsPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
  const button = (await screen.findAllByText("New template"))[0];
  if (!button) throw new Error("no new-template button");
  fireEvent.click(button);
  const use = (await screen.findAllByText("Use"))[0];
  if (!use) throw new Error("no starter");
  fireEvent.click(use);
  const input = (await screen.findByRole("textbox")) as HTMLInputElement;
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(await screen.findByRole("button", { name: /^create$/i }));
}

describe("creating a template opens it", () => {
  test("a successful create opens the editor on the new template", async () => {
    await i18n.changeLanguage("en");
    await createFromStarter("Orçamento de instalação");
    // The editor's own title and its slug field carry what the POST answered, not what was typed.
    await screen.findByText("Edit document template", undefined, {
      timeout: 3000,
    });
    expect(!!screen.queryByDisplayValue("orcamento_de_instalacao")).toBe(true);
    // One dialog on screen: the naming step is gone, not stacked under the editor.
    await waitFor(() => {
      expect(!!screen.queryByText("Name this template")).toBe(false);
    });
  });

  test("the list refreshes behind the editor", async () => {
    await i18n.changeLanguage("en");
    await createFromStarter("Orçamento de instalação");
    await screen.findByText("Edit document template", undefined, {
      timeout: 3000,
    });
    await waitFor(() => {
      expect(listReads).toBeGreaterThan(1);
    });
  });

  test("a refused create stays on the naming step", async () => {
    await i18n.changeLanguage("en");
    refuseCreate = true;
    await createFromStarter("Orçamento");
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryAllByRole("button", { name: /^create$/i }).length).toBe(
      1,
    );
    expect(!!screen.queryByText("Edit document template")).toBe(false);
    expect(listReads).toBe(1);
  });
});
