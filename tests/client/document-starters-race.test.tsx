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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// Switching language while the panel is loading starts a second load, and the two answer the SAME
// question differently: the starter list is the one thing here whose content is locale-specific. If
// the older request resolves last, its list replaces the current one — and the operator then creates
// a template in the language they just switched away from, permanently, with nothing on screen
// saying anything went wrong.
//
// NOTE: the language is switched on the REAL i18n instance rather than by mocking react-i18next.
// `mock.module` is global to the process, and so is the `mock.restore()` that would undo it: an
// earlier version of this file mocked the module and restored it in afterAll, which tore down the
// module mocks another test file had installed and failed a test in it. Nothing here needs the
// module replaced — the panel reads `i18n.language`, and changing it for real is both simpler and
// what the operator actually does.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

(globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
  "http://localhost/recursos/documentos",
);

const { default: i18n } = await import("@/client/lib/i18n");
const { DocumentsPanel } = await import(
  "@/client/pages/resources/documents/DocumentsPanel"
);
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
// Gates per locale, so the test decides which response lands last.
let gates: Record<string, { release: () => void; wait: Promise<void> }> = {};
function gate(locale: string) {
  if (!gates[locale]) {
    let release = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    gates[locale] = { release, wait };
  }
  return gates[locale] as { release: () => void; wait: Promise<void> };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const posts: string[] = [];
let holdPost = false;
let releasePost = () => {};
// What GET /tenant-settings answers with. The company PUT below does NOT change it, which is the
// point: the load's snapshot has to lose to the write that landed after it was taken.
let storedCompanyName = "";
// Holds the LAST request of the panel's Promise.all, so the settings response is already in hand
// while the load is still waiting — the window a save landing meanwhile has to win.
let holdDocuments = false;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  if ((init?.method ?? "GET").toUpperCase() !== "GET") {
    posts.push(`${init?.method} ${url.pathname}`);
    if (url.pathname.endsWith("/tenant-settings/company")) {
      const sent = init?.body ? JSON.parse(String(init.body)) : {};
      return json({
        company: {
          name: "",
          document: "",
          address: "",
          phone: "",
          email: "",
          website: "",
          logoKey: null,
          logoVersion: 0,
          ...sent,
        },
      });
    }
    if (holdPost) {
      await new Promise<void>((r) => {
        releasePost = r;
      });
    }
    return json({ template: { id: "9" } });
  }
  if (url.pathname.endsWith("/document-templates/starters")) {
    const locale = url.searchParams.get("locale") ?? "";
    await gate(locale).wait;
    return json({
      starters: [
        { key: "quote", name: `modelo-${locale}`, description: "", blocks: 3 },
        {
          key: "receipt",
          name: `recibo-${locale}`,
          description: "",
          blocks: 2,
        },
      ],
    });
  }
  if (url.pathname.endsWith("/document-templates")) {
    return json({ templates: [] });
  }
  if (url.pathname.endsWith("/tenant-settings")) {
    return json({
      company: {
        name: storedCompanyName,
        document: "",
        address: "",
        phone: "",
        email: "",
        website: "",
        logoKey: null,
        logoVersion: 0,
      },
    });
  }
  if (holdDocuments) await gate("documents").wait;
  return json({ documents: [] });
}) as unknown as typeof fetch;

// Fresh gates per test. They are one-shot promises, so a test that releases one leaves the next
// test with a request that never blocks — which is how a race test quietly stops racing.
beforeEach(() => {
  gates = {};
  posts.length = 0;
  holdPost = false;
  storedCompanyName = "";
  holdDocuments = false;
});
afterEach(cleanup);
const startingLanguage = i18n.language;
afterAll(async () => {
  globalThis.fetch = realFetch;
  // Put the shared instance back: it is module state, not test state.
  await i18n.changeLanguage(startingLanguage);
});

// Creating from a starter is one request at a time, and it stays visible until it answers. Two
// picks in quick succession are two templates; a dismissed dialog leaves a request whose result
// nobody sees, and the template it creates then appears in the list with no explanation.
describe("creating from a starter is one request", () => {
  async function openStarters() {
    const view = render(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <DocumentsPanel />
        </ToastProvider>
      </MemoryRouter>,
    );
    gate("pt-BR").release();
    gate("en-US").release();
    const button = (await screen.findAllByText("New template"))[0];
    if (!button) throw new Error("no new-template button");
    fireEvent.click(button);
    await screen.findAllByText("Use");
    return view;
  }

  // "Use" no longer creates: it moves to the naming step, because names are unique per account and
  // the name is what the agent's tool is called. The request comes from Create, so that is where the
  // in-flight rules live now.
  async function pickFirstStarter() {
    const buttons = await screen.findAllByText("Use");
    expect(buttons.length).toBeGreaterThan(1);
    fireEvent.click(buttons[0] as HTMLElement);
    return screen.findByRole("button", { name: /^create$/i });
  }

  test("picking a starter asks for a name instead of creating", async () => {
    await i18n.changeLanguage("en");
    posts.length = 0;
    await openStarters();
    await pickFirstStarter();
    // Nothing written yet, and the starter's own name is the suggestion.
    expect(posts.length).toBe(0);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value.length).toBeGreaterThan(0);
  });

  test("a second Create while one is in flight does nothing", async () => {
    // English, because these assertions read the button labels and the real catalog is loaded.
    await i18n.changeLanguage("en");
    posts.length = 0;
    holdPost = true;
    await openStarters();
    const create = await pickFirstStarter();
    fireEvent.click(create);
    await waitFor(() => {
      expect(posts.length).toBe(1);
    });
    fireEvent.click(await screen.findByRole("button", { name: /^create$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^create$/i }));
    await new Promise((r) => setTimeout(r, 30));
    expect(posts.length).toBe(1);
    releasePost();
  });

  test("the dialog cannot be dismissed while a request is out", async () => {
    await i18n.changeLanguage("en");
    posts.length = 0;
    holdPost = true;
    await openStarters();
    fireEvent.click(await pickFirstStarter());
    await waitFor(() => {
      expect(posts.length).toBe(1);
    });
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await new Promise((r) => setTimeout(r, 30));
    // Still there: the dialog is what the operator has to keep seeing until this answers.
    expect(
      screen.queryAllByRole("button", { name: /^create$/i }).length,
    ).toBeGreaterThan(0);
    releasePost();
  });
});

// A load reads four endpoints at once and applies them together, so its settings response can be a
// snapshot taken BEFORE a save this screen then made. Applying it puts the operator's own change
// back to what it replaced, on screen, with nothing saying so. The load generation does not cover
// it: no newer load started, a different request simply answered first.
describe("a refresh does not undo a company save it overlapped", () => {
  test("a save landing mid-load wins over the older snapshot", async () => {
    await i18n.changeLanguage("en");
    render(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <DocumentsPanel />
        </ToastProvider>
      </MemoryRouter>,
    );
    // First load through, then the letterhead editor opened: it is a modal now, so the form is not on
    // screen until somebody asks for it.
    gate("en-US").release();
    fireEvent.click(
      await screen.findByRole("button", { name: /^(edit|fill in)$/i }),
    );
    const nameInput = (await screen.findAllByRole("textbox"))[0];
    if (!nameInput) throw new Error("no company field");

    // A SECOND load, held on its last request: its settings response is already in hand and carries
    // the company as it is stored — which is about to stop being true.
    holdDocuments = true;
    await act(async () => {
      await i18n.changeLanguage("pt-BR");
    });
    gate("pt-BR").release();

    // The operator saves into that window.
    fireEvent.change(nameInput, { target: { value: "ACME Nova" } });
    const save = (await screen.findAllByText(/^(Save|Salvar)$/))[0];
    if (!save) throw new Error("no save button");
    fireEvent.click(save);
    await waitFor(() => {
      expect(posts.some((p) => p.includes("/tenant-settings/company"))).toBe(
        true,
      );
    });

    // …and now the load resolves, carrying the company as it was before the save.
    gate("documents").release();
    await new Promise((r) => setTimeout(r, 80));

    // Read off the summary row rather than the field: a successful save closes the editor, so the
    // name the panel is holding is what the row prints. Same question, the place it is now visible.
    expect((document.body.textContent ?? "").includes("ACME Nova")).toBe(true);
  });
});

describe("the starter list belongs to the current language", () => {
  test("an older response landing last does not replace the newer one", async () => {
    await i18n.changeLanguage("pt-BR");
    const view = render(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <DocumentsPanel />
        </ToastProvider>
      </MemoryRouter>,
    );
    // The pt-BR load is in flight, held. The operator switches to English.
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    view.rerender(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <DocumentsPanel />
        </ToastProvider>
      </MemoryRouter>,
    );

    // The starter list lives in a modal, so it has to be opened to be read.
    const open = async () => {
      const button = (await screen.findAllByText("New template"))[0];
      if (!button) throw new Error("no new-template button");
      fireEvent.click(button);
    };

    // The NEWER answer lands first, the older one after it — the ordering that loses the race.
    gate("en-US").release();
    await open();
    await waitFor(
      () => {
        expect(document.body.textContent?.includes("modelo-en-US")).toBe(true);
      },
      { timeout: 3000 },
    );
    // …and now the stale one lands.
    gate("pt-BR").release();
    await new Promise((r) => setTimeout(r, 50));

    expect(document.body.textContent?.includes("modelo-en-US")).toBe(true);
    expect(document.body.textContent?.includes("modelo-pt-BR")).toBe(false);
  });
});
