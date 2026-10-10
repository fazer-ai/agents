/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter } from "react-router";

// The template editor shows where numbering continues and lets the operator move it. The number is
// sent only when the operator moved it, because it also moves on its own as documents are issued; a
// malformed one is answered in the form, and a number already used is the server's refusal, shown.

const { DocumentTemplateModal } = await import(
  "@/client/pages/resources/documents/DocumentTemplateModal"
);
const { ToastProvider, useModalController } = await import(
  "@/client/components"
);

const realFetch = globalThis.fetch;
const patches: Record<string, unknown>[] = [];
let refusal: string | null = null;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  patches.length = 0;
  refusal = null;
});

const TEMPLATE = {
  id: "3",
  name: "Orçamento",
  slug: "orcamento",
  description: null,
  numberPrefix: "ORC-",
  nextNumber: 8,
  enabled: true,
  requiresApproval: false,
  approvalTtlHours: 24,
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

function Harness() {
  const modal = useModalController<{ template: typeof TEMPLATE }>();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open({ template: TEMPLATE });
  }, [modal]);
  return (
    <DocumentTemplateModal
      modal={
        modal as unknown as Parameters<typeof DocumentTemplateModal>[0]["modal"]
      }
      onSaved={() => undefined}
    />
  );
}

function mount() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/document-templates/preview")) {
      return new Response(new Blob(["%PDF-1.7"]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if ((init?.method ?? "GET").toUpperCase() === "PATCH") {
      patches.push(JSON.parse(String(init?.body ?? "{}")));
      if (refusal) {
        return new Response(JSON.stringify({ error: refusal }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  render(
    <MemoryRouter>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function saveButton(): HTMLButtonElement {
  return screen
    .getByText(/^(Save|Salvar)$/)
    .closest("button") as HTMLButtonElement;
}

test("the editor shows the number the next document prints, and sends a moved one", async () => {
  mount();
  const field = await screen.findByDisplayValue("8");
  await screen.findByText(/ORC-0008/);
  fireEvent.change(field, { target: { value: "1500" } });
  await screen.findByText(/ORC-1500/);
  fireEvent.click(saveButton());
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]?.nextNumber).toBe(1500);
});

test("an untouched number is not sent with another edit", async () => {
  mount();
  const textarea = await screen.findByDisplayValue("Olá.");
  fireEvent.change(textarea, { target: { value: "Bom dia." } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(patches).toHaveLength(1));
  expect("nextNumber" in (patches[0] ?? {})).toBe(false);
});

test("a malformed number is answered in the form and blocks the save", async () => {
  mount();
  const field = await screen.findByDisplayValue("8");
  fireEvent.change(field, { target: { value: "0" } });
  await screen.findByText(/whole number from 1|número inteiro a partir de 1/);
  expect(saveButton().disabled).toBe(true);
});

test("a number already used shows the server's refusal", async () => {
  refusal =
    "ORC-0003 não pode ser o próximo número: ORC-0007 já foi emitido com este prefixo.";
  mount();
  const field = await screen.findByDisplayValue("8");
  fireEvent.change(field, { target: { value: "3" } });
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(screen.queryAllByText(refusal as string).length).toBeGreaterThan(0),
  );
});
