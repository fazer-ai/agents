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

// THE TOOL NAME FOLLOWS THE NAME, AND THE OPERATOR CAN STILL OVERRIDE IT.
//
// The slug becomes the agent's tool (`send_<slug>`) and used to be derived ONLY at create time, so
// renaming a template left "Contrato de prestação" behind a tool called `send_orcamento` — with the
// field showing it, read-only, and nothing saying why. The rule now is the one an operator would
// guess from watching it once: the name is the source, every keystroke re-derives, and a slug typed
// by hand survives until the name is edited again.
//
// That last clause is the one worth pinning. It is a deliberate asymmetry (the name wins), not an
// oversight, and it is invisible in the code — one `setSlug` call inside the name's onChange.

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

// By its LABEL, not by the value it happens to hold. The first version matched "an input whose value
// starts with orcamento" and silently fell back to the first input on the form, so the test typed
// into the name field and asserted about the tool field — green for the wrong reason, in the one
// test whose whole point is that the two fields are independent.
function toolInput(): HTMLInputElement {
  const field = Array.from(document.querySelectorAll("label")).find((l) =>
    /ferramenta do agente|agent tool/i.test(l.textContent ?? ""),
  );
  const input = field?.querySelector("input") as HTMLInputElement | null;
  if (!input) throw new Error("tool field not on screen");
  return input;
}

function slugValue(): string {
  return toolInput().value;
}

test("renaming the template re-derives the tool name as you type", async () => {
  const name = await open();

  fireEvent.change(name, { target: { value: "Contrato de Prestação" } });

  await waitFor(() => {
    expect(slugValue()).toBe("contrato_de_prestacao");
  });
  // And the resulting tool name is spelled out, because `contrato_de_prestacao` alone does not tell
  // the operator what the model is offered.
  expect(document.body.textContent).toContain("send_contrato_de_prestacao");
});

test("the save carries the new slug, so the agent's tool is renamed too", async () => {
  const name = await open();
  fireEvent.change(name, { target: { value: "Contrato" } });
  await waitFor(() => {
    expect(slugValue()).toBe("contrato");
  });

  fireEvent.click(await screen.findByText(/^(Save|Salvar)$/));

  await waitFor(() => {
    expect(patches.length).toBe(1);
  });
  expect(patches[0]).toMatchObject({ name: "Contrato", slug: "contrato" });
});

test("a slug typed by hand sticks, until the name is edited again", async () => {
  const name = await open();

  fireEvent.change(toolInput(), { target: { value: "proposta_v2" } });
  await waitFor(() => {
    expect(slugValue()).toBe("proposta_v2");
  });
  // A DIFFERENT name, not the one already in the field: `fireEvent.change` with an unchanged value
  // dispatches nothing, so re-typing "Orçamento" here asserted that the hand-typed slug survived an
  // event that never happened.
  fireEvent.change(name, { target: { value: "Recibo" } });
  await waitFor(() => {
    expect(slugValue()).toBe("recibo");
  });
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
