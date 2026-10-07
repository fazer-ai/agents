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

// Renaming a template keeps its tool name, as an MCP or API rename does: the slug becomes the agent's
// tool (`send_<slug>`), and a prompt that mentions it must not stop working because the template was
// renamed. The tool name the new name would derive is offered, and taking it is an explicit click
// that warns what stops working.

const { DocumentTemplateModal } = await import(
  "@/client/pages/resources/documents/DocumentTemplateModal"
);
const { ToastProvider, useModalController } = await import(
  "@/client/components"
);

const realFetch = globalThis.fetch;

const TEMPLATE = {
  id: "3",
  name: "Orçamento",
  slug: "orcamento",
  toolName: "send_orcamento",
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

let patches: Record<string, unknown>[] = [];

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  patches = [];
});

function serving() {
  patches = [];
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
      return new Response(JSON.stringify({ template: TEMPLATE }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

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

async function open() {
  serving();
  render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MemoryRouter>,
  );
  return (await screen.findByDisplayValue("Orçamento")) as HTMLInputElement;
}

// By its LABEL, not by the value it happens to hold: matching by value can silently fall back to
// the first input on the form, typing into the name and asserting about the tool field.
function toolInput(): HTMLInputElement {
  // Through `htmlFor`, because a <FormField> label POINTS at its control instead of wrapping
  // it: a wrapping label forwards a click on any non-interactive descendant (the help `?`) to the
  // control.
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    /ferramenta do agente|agent tool/i.test(l.textContent ?? ""),
  ) as HTMLLabelElement | undefined;
  const input = label?.htmlFor
    ? (document.getElementById(label.htmlFor) as HTMLInputElement | null)
    : null;
  if (!input) throw new Error("tool field not on screen");
  return input;
}

function slugValue(): string {
  return toolInput().value;
}

test("renaming the template keeps the tool name and offers the new one", async () => {
  const name = await open();

  fireEvent.change(name, { target: { value: "Contrato de Prestação" } });

  await waitFor(() => {
    expect(document.body.textContent).toContain("send_contrato_de_prestacao");
  });
  expect(slugValue()).toBe("orcamento");
});

test("a rename alone saves the same tool name", async () => {
  const name = await open();
  fireEvent.change(name, { target: { value: "Contrato" } });

  fireEvent.click(await screen.findByText(/^(Save|Salvar)$/));

  await waitFor(() => {
    expect(patches.length).toBe(1);
  });
  expect(patches[0]?.name).toBe("Contrato");
  expect(patches[0]?.slug ?? "orcamento").toBe("orcamento");
});

test("taking the offered tool name warns, and the save carries it", async () => {
  const name = await open();
  fireEvent.change(name, { target: { value: "Contrato" } });
  fireEvent.click(await screen.findByText(/send_contrato/));

  await waitFor(() => {
    expect(slugValue()).toBe("contrato");
  });
  expect(document.body.textContent).toMatch(/send_orcamento/);

  fireEvent.click(await screen.findByText(/^(Save|Salvar)$/));
  await waitFor(() => {
    expect(patches.length).toBe(1);
  });
  expect(patches[0]).toMatchObject({ name: "Contrato", slug: "contrato" });
});

test("a tool name typed by hand survives a later rename", async () => {
  const name = await open();

  fireEvent.change(toolInput(), { target: { value: "proposta_v2" } });
  fireEvent.change(name, { target: { value: "Recibo" } });
  await new Promise((r) => setTimeout(r, 20));
  expect(slugValue()).toBe("proposta_v2");
});

test("an unusable slug is refused in the field, and no request is made", async () => {
  await open();

  fireEvent.change(toolInput(), { target: { value: "2026 Contrato" } });

  await waitFor(() => {
    expect(document.body.textContent).toMatch(
      /must start with a letter|começar com uma letra/i,
    );
  });
  const save = (await screen.findByText(
    /^(Save|Salvar)$/,
  )) as HTMLButtonElement;
  fireEvent.click(save.closest("button") ?? save);
  await new Promise((r) => setTimeout(r, 40));
  expect(patches.length).toBe(0);
});
