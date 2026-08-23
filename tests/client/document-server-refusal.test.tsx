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

// THE REFUSAL THE OPERATOR CAN ACT ON, AND THE ONE THEY CANNOT.
//
// Three write paths on this screen refuse for reasons the operator fixes IN THE FORM they are
// looking at: a character the document fonts cannot print (named, with the field it is in), a
// duplicate template name, a logo whose pixel count is over the budget. Each of those is worded on
// the server and localized there, and each was being replaced by a fixed sentence.
//
// The logo is the one that shows why a generic message is worse than no message. Its fixed sentence
// says "PNG or JPEG under 512 KB", which READS like an answer — so an operator whose 180 KB PNG is
// refused for being 8000×8000 is told, confidently, to shrink a file that is already small enough.
// A message that looks like it answers is how a whole family of call sites escapes a sweep.
//
// The other half is asserted too, because the rule is "show what the server said", not "show
// something specific": a transport failure has no server and no message, and the generic sentence is
// then the honest thing on screen.

const { CompanyProfileCard } = await import(
  "@/client/pages/resources/documents/CompanyProfileCard"
);
const { DocumentTemplateModal } = await import(
  "@/client/pages/resources/documents/DocumentTemplateModal"
);
const { ToastProvider, useModalController } = await import(
  "@/client/components"
);
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");

const realFetch = globalThis.fetch;

const COMPANY = {
  name: "ACME Ltda",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: null,
  logoVersion: 0,
};

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// The shape Eden hands back for an HTTP error: the parsed body on `value`, `{ error }` inside it,
// already localized by the API for this request's Accept-Language.
function refusing(status: number, message: string, method: string) {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== method.toUpperCase()) {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function mountCompany() {
  return render(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard
            company={COMPANY as never}
            onChanged={() => undefined}
            session={1}
          />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );
}

function nameField(): HTMLInputElement {
  return screen.getAllByRole("textbox")[0] as HTMLInputElement;
}

test("a refused company field says WHICH character, not 'could not save'", async () => {
  // Worded the way `unprintableProblem` words it: the field and the character, because that is what
  // the operator has to go find in a form of six inputs.
  const reason =
    'name contains a character the document fonts cannot print: "😀"';
  refusing(400, reason, "PUT");
  mountCompany();

  fireEvent.change(nameField(), { target: { value: "ACME 😀" } });
  fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));

  await waitFor(() => {
    expect(screen.queryAllByText(reason).length).toBeGreaterThan(0);
  });
});

test("a company save with no server behind it still says something", async () => {
  // The other direction. Eden REJECTS on a transport failure rather than answering `{ error }`, so
  // there is no message to show and the generic sentence is correct — a guard that only ever shows
  // the server's words would leave an offline save silent.
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  mountCompany();

  fireEvent.change(nameField(), { target: { value: "ACME Nova" } });
  fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));

  await waitFor(() => {
    expect(
      screen.queryAllByText(/não foi possível salvar|could not save/i).length,
    ).toBeGreaterThan(0);
  });
});

test("a logo refused for its pixel count does not blame its size", async () => {
  // The refusal names the real limit. The generic sentence it was replacing names a DIFFERENT limit
  // that this file already satisfies, which is worse than saying nothing.
  const reason = "the logo must be at most 4000000 pixels (about 2000×2000)";
  refusing(400, reason, "POST");
  mountCompany();

  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  const file = new File([new Uint8Array([1, 2, 3])], "logo.png", {
    type: "image/png",
  });
  Object.defineProperty(input as HTMLInputElement, "files", {
    value: [file],
    configurable: true,
  });
  fireEvent.change(input as HTMLInputElement);

  await waitFor(() => {
    expect(screen.queryAllByText(reason).length).toBeGreaterThan(0);
  });
  // And specifically NOT the sentence that would send them to compress an already-small file.
  expect(screen.queryAllByText(/512 KB/).length).toBe(0);
});

const TEMPLATE = {
  id: "3",
  name: "Orçamento",
  slug: "orcamento",
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

function TemplateHarness() {
  const modal = useModalController<{ template: typeof TEMPLATE }>();
  // Opened once, on mount: the controller's identity changes with its own state, so depending on it
  // would reopen the dialog after every close.
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

// The third call site, asserted through the modal rather than by reading the source. The same
// one-line idiom was applied at all three, and "I applied it everywhere" is exactly the claim that
// has been wrong before: the fix is per call site, so the proof has to be too.
test("a template refused for a duplicate name says which name", async () => {
  const reason = 'a template named "Orçamento" already exists';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/document-templates/preview")) {
      return new Response(new Blob(["%PDF-1.7"]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if ((init?.method ?? "GET").toUpperCase() === "PATCH") {
      return new Response(JSON.stringify({ error: reason }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <ToastProvider>
        <TemplateHarness />
      </ToastProvider>
    </MemoryRouter>,
  );

  // Edited first: the modal sends nothing when the diff is empty, so a bare Save would assert the
  // absence of a toast just as well when the request was never made.
  const textarea = await screen.findByDisplayValue("Olá.");
  fireEvent.change(textarea, { target: { value: "Bom dia." } });
  fireEvent.click(await screen.findByText(/^(Save|Salvar)$/));

  await waitFor(() => {
    expect(screen.queryAllByText(reason).length).toBeGreaterThan(0);
  });
});
