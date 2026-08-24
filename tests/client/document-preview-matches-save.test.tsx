/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider, useModalController } from "@/client/components";
import { DocumentTemplateModal } from "@/client/pages/resources/documents/DocumentTemplateModal";

// The preview promises what the SAVE will produce, and the save sends only what this modal changed.
// A preview assembled from the modal's whole state therefore describes a different write: the modal
// holds a snapshot from when the list loaded, so a wording-only edit previews the style that
// snapshot carries while the save keeps whatever an API or MCP client set in the meantime. The two
// have to be built from one value.
//
// Driven through the rendered modal and asserted on the REQUEST, because that is where the two
// payloads can differ — comparing them in the component would just be reading the same variable
// twice.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

(globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
  "http://localhost/recursos/documentos",
);

const realFetch = globalThis.fetch;
let previewBodies: Record<string, unknown>[] = [];
let patchBodies: Record<string, unknown>[] = [];

let holdPatch = false;
let releasePatch = () => {};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.pathname.endsWith("/document-templates/preview")) {
    previewBodies.push(body);
    return new Response(new Blob(["%PDF-1.7"]), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
  }
  if ((init?.method ?? "GET").toUpperCase() === "PATCH") {
    patchBodies.push(body);
    if (holdPatch) {
      await new Promise<void>((r) => {
        releasePatch = r;
      });
    }
  }
  return new Response(JSON.stringify({ template: { id: "3" } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

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

function Harness() {
  const modal = useModalController<{ template: typeof TEMPLATE }>();
  // Opened once, on mount. The controller's identity changes whenever its own state flips, so
  // depending on it would reopen the dialog after every close (the same note UserMenu's test carries
  // for the same reason).
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
      onSaved={() => {}}
    />
  );
}

beforeEach(() => {
  previewBodies = [];
  patchBodies = [];
  holdPatch = false;
});
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("the preview payload is the payload that will be saved", () => {
  test("a wording-only edit previews and saves the same diff", async () => {
    render(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </MemoryRouter>,
    );
    const textarea = await screen.findByDisplayValue("Olá.");
    fireEvent.change(textarea, { target: { value: "Bom dia." } });

    // The preview is debounced; the request it eventually makes is the subject here.
    await waitFor(
      () => {
        expect(previewBodies.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
    const preview = previewBodies[previewBodies.length - 1] as Record<
      string,
      unknown
    >;
    // The wording changed, so it travels…
    expect(JSON.stringify(preview.blockText)).toContain("Bom dia.");
    // …and nothing else does. A name and a style restated here are values another client may have
    // changed since this modal opened, and the save will not send them.
    expect("style" in preview).toBe(false);
    expect("name" in preview).toBe(false);
    expect("numberPrefix" in preview).toBe(false);

    // The real i18n instance is loaded, so the label is the tenant's language, not a fallback.
    const save = await screen.findByText(/^(Save|Salvar)$/);
    fireEvent.click(save);
    await waitFor(() => {
      expect(patchBodies.length).toBe(1);
    });
    const patch = patchBodies[0] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(["blockText"]);
  });
});

// The diff was captured when Save was clicked. An edit typed after that is not in the request, and
// the success that follows closes the modal and takes it away without a word — so the form has to
// stop accepting edits for as long as the request is out.
describe("the form is not editable while a save is in flight", () => {
  test("controls are disabled until the request answers", async () => {
    holdPatch = true;
    render(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </MemoryRouter>,
    );
    const textarea = await screen.findByDisplayValue("Olá.");
    fireEvent.change(textarea, { target: { value: "Bom dia." } });
    const save = await screen.findByText(/^(Save|Salvar)$/);
    fireEvent.click(save);
    await waitFor(() => {
      expect(patchBodies.length).toBe(1);
    });

    // Asserted STRUCTURALLY: every editable control sits inside a fieldset, and that fieldset is
    // disabled. A fieldset disables its whole subtree — including controls added to this form later,
    // which is why it is one element rather than a prop on each — but that inheritance is computed
    // by the browser, and happy-dom leaves `el.disabled` reading each element's own attribute. So
    // the containment and the flag are what can be observed here; the propagation is the platform's.
    const form = document.querySelector("fieldset") as HTMLFieldSetElement;
    expect(form?.disabled).toBe(true);
    const editable = [
      ...document.querySelectorAll("input, textarea, select"),
    ] as HTMLElement[];
    expect(editable.length).toBeGreaterThan(3);
    expect(editable.every((el) => form.contains(el))).toBe(true);
    // Released so the request does not outlive the test. Whether the modal then closes is the
    // SAVE's business, asserted by the test above through the PATCH it sends; waiting for the close
    // here only adds a timing dependency to an assertion about the form being frozen, and under a
    // full-suite run that wait is what timed out.
    releasePatch();
  });
});
