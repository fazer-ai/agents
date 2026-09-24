/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider } from "@/client/components";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import { createTestI18n, withI18n } from "@/tests/utils/i18n";

// Issue #798: a knowledge base's help center source, in the console. #794 exposed it over REST and
// MCP only, so an operator could not see that a base mirrors a portal, when it last ran or whether
// the run failed, could not set one up, and met a synced document's read-only rule as a 409 on click.
// The api module is not mocked (its mock would leak into every file sharing the worker); the Eden
// treaty calls `globalThis.fetch`, which is what these tests answer.

type Source = {
  kind: string;
  baseUrl: string;
  slug: string;
  locale: string;
  excludeIds: number[];
  intervalMinutes: number;
  lastSyncAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
};

let source: Source | null = null;
const calls: Array<{ method: string; url: string; body: unknown }> = [];
let putAnswer: { status: number; body: unknown } | null = null;
let docs: Record<string, unknown>[] = [];
// When set, the base read waits on it: a response still out when the section closes.
let baseGate: Promise<void> | null = null;
// When set, the sync request waits on it: a POST still out when the section closes.
let syncGate: Promise<void> | null = null;

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const raw =
      init?.body ??
      (input instanceof Request ? await input.clone().text() : undefined);
    const body = typeof raw === "string" && raw ? JSON.parse(raw) : undefined;
    if (url.includes("/knowledge/")) calls.push({ method, url, body });
    if (url.includes("/knowledge/embedding-block"))
      return json({ block: null });
    if (url.includes("/source/sync") && method === "POST") {
      if (syncGate) await syncGate;
      return json({ success: true });
    }
    if (url.includes("/source") && method === "PUT") {
      if (putAnswer) return json(putAnswer.body, putAnswer.status);
      const b = body as Partial<Source>;
      source = {
        kind: "chatwoot_portal",
        baseUrl: b.baseUrl ?? "",
        slug: b.slug ?? "portal",
        locale: b.locale ?? "pt-BR",
        excludeIds: b.excludeIds ?? [],
        intervalMinutes: b.intervalMinutes ?? 10,
        lastSyncAt: null,
        lastStatus: null,
        lastMessage: null,
      };
      return json({ source });
    }
    if (url.includes("/source") && method === "DELETE") {
      source = null;
      return json({ success: true });
    }
    if (url.includes("/documents") && method === "GET") {
      return json({ documents: docs, embeddingBlock: null, nextCursor: null });
    }
    if (/\/knowledge\/bases\/[^/]+$/.test(url) && method === "GET") {
      if (baseGate) await baseGate;
      return json({
        base: { id: "b1", name: "Base", source },
      });
    }
    return realFetch(input as RequestInfo | URL, init);
  }) as typeof fetch;
}

const i18n = createTestI18n("en", {
  en: { translation: clientEn },
  "pt-BR": { translation: clientPt },
});

mock.module("@/client/hooks/useTenantEvents", () => ({
  useTenantEvents: () => {},
}));
mock.module("@/client/contexts/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
  }),
  useThemedAsset: (path: string) => ({ src: path }),
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

const { KnowledgeSourceSection, parseExcludeIds } = await import(
  "@/client/pages/resources/KnowledgeSourceSection"
);
const { useKnowledgeManager } = await import(
  "@/client/pages/resources/useKnowledgeManager"
);

function wrap(node: ReactNode) {
  return withI18n(
    <TooltipProvider>
      <ToastProvider>{node}</ToastProvider>
    </TooltipProvider>,
    i18n,
  );
}

let hasSource: boolean | null = null;
function renderSection(canManage = true) {
  hasSource = null;
  render(
    wrap(
      <KnowledgeSourceSection
        baseId="b1"
        canManage={canManage}
        onSourceChange={(h) => {
          hasSource = h;
        }}
      />,
    ),
  );
}

const FAILED_RUN: Source = {
  kind: "chatwoot_portal",
  baseUrl: "https://ajuda.example.com",
  slug: "clinica",
  locale: "pt-BR",
  excludeIds: [12, 40],
  intervalMinutes: 30,
  lastSyncAt: "2026-09-20T10:00:00.000Z",
  lastStatus: "error",
  lastMessage: "the portal listing answered HTTP 404",
};

const shows = (text: string | RegExp) => screen.queryAllByText(text).length > 0;
const sent = (method: string, part: string) =>
  calls.filter((c) => c.method === method && c.url.includes(part));

beforeEach(() => {
  source = null;
  calls.length = 0;
  putAnswer = null;
  docs = [];
  baseGate = null;
  syncGate = null;
  i18n.changeLanguage("en");
  installFetchStub();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("the help center source section", () => {
  test("a base with a source shows its configuration and the last run's failure", async () => {
    source = { ...FAILED_RUN };
    renderSection();
    await screen.findByText("https://ajuda.example.com");
    expect(shows("clinica")).toBe(true);
    expect(shows("pt-BR")).toBe(true);
    expect(shows("12, 40")).toBe(true);
    expect(shows("30 minutes")).toBe(true);
    expect(shows("Chatwoot help center")).toBe(true);
    expect(shows("Error")).toBe(true);
    expect(shows("the portal listing answered HTTP 404")).toBe(true);
    expect(document.querySelector('[data-status="error"]')?.textContent).toBe(
      "Error",
    );
    expect(hasSource).toBe(true);
    for (const name of ["Sync now", "Edit", "Remove"]) {
      expect(screen.queryAllByRole("button", { name }).length).toBe(1);
    }
  });

  test("the same base in pt-BR reads in pt-BR, with no raw key", async () => {
    source = { ...FAILED_RUN };
    i18n.changeLanguage("pt-BR");
    renderSection();
    await screen.findByText("Fonte da central de ajuda");
    expect(shows("30 minutos")).toBe(true);
    expect(shows("Sincronizar agora")).toBe(true);
    expect(shows(/knowledge\.source\./)).toBe(false);
  });

  test("a source that never ran says so, and invents no status", async () => {
    source = {
      ...FAILED_RUN,
      excludeIds: [],
      lastSyncAt: null,
      lastStatus: null,
      lastMessage: null,
    };
    renderSection();
    await screen.findByText("Not run yet");
    expect(shows("None")).toBe(true);
    expect(document.querySelector("[data-status]")).toBeNull();
    for (const bad of ["undefined", "null", "[]", "Invalid Date"]) {
      expect(shows(bad)).toBe(false);
    }
  });

  test("a base without one offers to set it up, and saving sends the form", async () => {
    renderSection();
    await screen.findByText(/does not mirror a help center/);
    expect(hasSource).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Set up source" }));
    fireEvent.change(screen.getByLabelText(/Portal URL/), {
      target: { value: "https://ajuda.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Portal slug/), {
      target: { value: "clinica" },
    });
    fireEvent.change(screen.getByLabelText(/Excluded article ids/), {
      target: { value: "12, 40 12" },
    });
    fireEvent.change(screen.getByLabelText(/Sync interval/), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    await screen.findByText("https://ajuda.example.com");
    const [put] = sent("PUT", "/source");
    expect(put?.body).toEqual({
      kind: "chatwoot_portal",
      baseUrl: "https://ajuda.example.com",
      slug: "clinica",
      excludeIds: [12, 40],
      intervalMinutes: 30,
    });
    expect(hasSource).toBe(true);
  });

  test("a refused save says why on screen and keeps the form", async () => {
    putAnswer = {
      status: 422,
      body: { error: "the portal URL must be https" },
    };
    renderSection();
    await screen.findByText(/does not mirror a help center/);
    fireEvent.click(screen.getByRole("button", { name: "Set up source" }));
    fireEvent.change(screen.getByLabelText(/Portal URL/), {
      target: { value: "http://ajuda.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("the portal URL must be https");
    expect(
      screen.queryAllByRole("button", { name: "Save source" }).length,
    ).toBe(1);
    expect(source).toBeNull();
  });

  test("an excluded id that is not a number is refused before anything is sent", async () => {
    renderSection();
    await screen.findByText(/does not mirror a help center/);
    fireEvent.click(screen.getByRole("button", { name: "Set up source" }));
    fireEvent.change(screen.getByLabelText(/Portal URL/), {
      target: { value: "https://ajuda.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Excluded article ids/), {
      target: { value: "12, abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    await screen.findByRole("alert");
    expect(sent("PUT", "/source")).toEqual([]);
  });

  test("an interval that is not a whole number is refused before anything is sent", async () => {
    renderSection();
    await screen.findByText(/does not mirror a help center/);
    fireEvent.click(screen.getByRole("button", { name: "Set up source" }));
    fireEvent.change(screen.getByLabelText(/Portal URL/), {
      target: { value: "https://ajuda.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Sync interval/), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("whole number of minutes");
    expect(sent("PUT", "/source")).toEqual([]);
  });

  test("editing opens prefilled, and saving unchanged sends the same source", async () => {
    source = { ...FAILED_RUN };
    renderSection();
    await screen.findByText("https://ajuda.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      (screen.getByLabelText(/Portal URL/) as HTMLInputElement).value,
    ).toBe("https://ajuda.example.com");
    expect(
      (screen.getByLabelText(/Excluded article ids/) as HTMLInputElement).value,
    ).toBe("12, 40");
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(sent("PUT", "/source").length).toBe(1));
    expect(sent("PUT", "/source")[0]?.body).toEqual({
      kind: "chatwoot_portal",
      baseUrl: "https://ajuda.example.com",
      slug: "clinica",
      locale: "pt-BR",
      excludeIds: [12, 40],
      intervalMinutes: 30,
    });
  });

  test("sync now arms a run and keeps reading until its outcome lands", async () => {
    source = { ...FAILED_RUN };
    renderSection();
    await screen.findByText("https://ajuda.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(sent("POST", "/source/sync").length).toBe(1));
    const readsBefore = sent("GET", "/knowledge/bases/b1").length;
    // The first re-read still sees the old run: the scheduler has not got to it yet.
    await waitFor(
      () =>
        expect(sent("GET", "/knowledge/bases/b1").length).toBe(readsBefore + 1),
      { timeout: 5_000 },
    );
    // It lands a moment later, and only a second re-read can see it.
    source = {
      ...FAILED_RUN,
      lastSyncAt: "2026-09-20T10:05:00.000Z",
      lastStatus: "ok",
      lastMessage: "3 articles",
    };
    await waitFor(
      () => expect(document.querySelector('[data-status="ok"]')).not.toBeNull(),
      { timeout: 5_000 },
    );
    expect(shows("3 articles")).toBe(true);
  }, 15_000);

  test("removing asks first, says the documents stay, and cancelling sends nothing", async () => {
    source = { ...FAILED_RUN };
    renderSection();
    await screen.findByText("https://ajuda.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryAllByText(/stay in the base/).length).toBe(1);
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent("DELETE", "/source")).toEqual([]);
    expect(source).not.toBeNull();
  });

  test("confirming the removal deletes the source and the section says there is none", async () => {
    source = { ...FAILED_RUN };
    renderSection();
    await screen.findByText("https://ajuda.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove source" }),
    );
    await screen.findByText(/does not mirror a help center/);
    expect(sent("DELETE", "/source").length).toBe(1);
    expect(hasSource).toBe(false);
  });

  test("an answer that lands after the section closed is not reported", async () => {
    source = { ...FAILED_RUN };
    let open: () => void = () => {};
    baseGate = new Promise((r) => {
      open = r;
    });
    renderSection();
    await waitFor(() =>
      expect(sent("GET", "/knowledge/bases/b1").length).toBe(1),
    );
    cleanup();
    open();
    await new Promise((r) => setTimeout(r, 50));
    expect(hasSource).toBeNull();
  });

  test("closing the section while a re-read is out stops the polling there", async () => {
    source = { ...FAILED_RUN };
    renderSection();
    await screen.findByText("https://ajuda.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(sent("POST", "/source/sync").length).toBe(1));
    // The first re-read is held open, and the section closes while it is out.
    let open: () => void = () => {};
    baseGate = new Promise((r) => {
      open = r;
    });
    const before = sent("GET", "/knowledge/bases/b1").length;
    await waitFor(
      () => expect(sent("GET", "/knowledge/bases/b1").length).toBe(before + 1),
      { timeout: 5_000 },
    );
    cleanup();
    baseGate = null;
    open();
    // Past the next tick: nothing is left to ask about.
    await new Promise((r) => setTimeout(r, 4_000));
    expect(sent("GET", "/knowledge/bases/b1").length).toBe(before + 1);
  }, 15_000);

  test("a sync answered after the section closed starts no polling", async () => {
    source = { ...FAILED_RUN };
    renderSection();
    await screen.findByText("https://ajuda.example.com");
    let open: () => void = () => {};
    syncGate = new Promise((r) => {
      open = r;
    });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(sent("POST", "/source/sync").length).toBe(1));
    const before = sent("GET", "/knowledge/bases/b1").length;
    cleanup();
    open();
    await new Promise((r) => setTimeout(r, 4_000));
    expect(sent("GET", "/knowledge/bases/b1").length).toBe(before);
  }, 15_000);

  test("a read-only surface shows the source and offers no action", async () => {
    source = { ...FAILED_RUN };
    renderSection(false);
    await screen.findByText("https://ajuda.example.com");
    for (const name of ["Sync now", "Edit", "Remove"]) {
      expect(screen.queryAllByRole("button", { name }).length).toBe(0);
    }
  });
});

describe("parseExcludeIds", () => {
  test("reads commas and spaces, drops repeats, refuses anything else", () => {
    expect(parseExcludeIds("")).toEqual([]);
    expect(parseExcludeIds("12, 40 ,7 12")).toEqual([12, 40, 7]);
    expect(parseExcludeIds("12, abc")).toBeNull();
    expect(parseExcludeIds("0")).toBeNull();
    expect(parseExcludeIds("-3")).toBeNull();
    // Number() would read these as ids; the API would not, and neither does the form.
    expect(parseExcludeIds("1e2")).toBeNull();
    expect(parseExcludeIds("1.0")).toBeNull();
  });
});

describe("a synced document in the documents list", () => {
  let changed = 0;
  function Harness({ edits = true }: { edits?: boolean }) {
    const m = useKnowledgeManager({
      onChanged: () => {
        changed += 1;
      },
      allowDocumentEdits: edits,
    });
    return (
      <>
        <button
          type="button"
          onClick={() => m.openDocs({ id: "b1", name: "Base" })}
        >
          open
        </button>
        {m.modals}
      </>
    );
  }

  const SYNCED = {
    id: "d1",
    title: "Como remarcar",
    status: "READY",
    chunkCount: 2,
    error: null,
    sourceType: "text",
    externalId: "77",
    sourceUrl: "https://ajuda.example.com/hc/clinica/articles/77",
    createdAt: new Date(0).toISOString(),
  };
  const CURATED = {
    ...SYNCED,
    id: "d2",
    title: "Nota interna",
    externalId: null,
    sourceUrl: null,
  };

  async function openList(edits = true) {
    render(wrap(<Harness edits={edits} />));
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await screen.findByText("Nota interna");
  }

  function rowOf(title: string): HTMLElement {
    const li = screen.getByText(title).closest("li");
    if (!li) throw new Error(`no row for ${title}`);
    return li as HTMLElement;
  }

  test("is marked, links to its article, and cannot be edited or deleted here", async () => {
    source = { ...FAILED_RUN };
    docs = [SYNCED, CURATED];
    await openList();
    await waitFor(() =>
      expect(
        within(rowOf("Como remarcar")).queryAllByText("Synced").length,
      ).toBe(1),
    );
    const row = rowOf("Como remarcar");
    const link = within(row).getByRole("link", { name: /Open article/ });
    expect(link.getAttribute("href")).toBe(SYNCED.sourceUrl);
    expect(
      within(row).queryAllByText(/Fix the article in the portal/).length,
    ).toBe(1);
    const edit = within(row).getByRole("button", { name: "Edit" });
    const del = within(row).getByRole("button", { name: "Delete" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect((del as HTMLButtonElement).disabled).toBe(true);
    const before = calls.length;
    fireEvent.click(del);
    expect(calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    // The curated one beside it is untouched by any of this.
    const curated = rowOf("Nota interna");
    expect(within(curated).queryAllByText("Synced").length).toBe(0);
    expect(
      (
        within(curated).getByRole("button", {
          name: "Edit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test("without a source the same document is an ordinary one", async () => {
    source = null;
    docs = [SYNCED, CURATED];
    await openList();
    await screen.findByText(/does not mirror a help center/);
    const row = rowOf("Como remarcar");
    expect(within(row).queryAllByText("Synced").length).toBe(0);
    expect(
      (within(row).getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  const docReads = () =>
    calls.filter((c) => c.method === "GET" && c.url.includes("/documents"))
      .length;

  test("the agent editor's read-only list shows the source with no action on it", async () => {
    source = { ...FAILED_RUN };
    docs = [SYNCED, CURATED];
    await openList(false);
    await screen.findByText("https://ajuda.example.com");
    for (const name of ["Sync now", "Remove", "Set up source"]) {
      expect(screen.queryAllByRole("button", { name }).length).toBe(0);
    }
  });

  test("removing the source from the list re-reads the documents it freed", async () => {
    source = { ...FAILED_RUN };
    docs = [SYNCED, CURATED];
    await openList();
    await waitFor(() =>
      expect(
        within(rowOf("Como remarcar")).queryAllByText("Synced").length,
      ).toBe(1),
    );
    const before = docReads();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: /Remove help/ });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove source" }),
    );
    await screen.findByText(/does not mirror a help center/);
    await waitFor(() => expect(docReads()).toBe(before + 1));
  });

  test("reopening the list starts from what the base says now, not what it said before", async () => {
    source = { ...FAILED_RUN };
    docs = [SYNCED, CURATED];
    await openList();
    await waitFor(() =>
      expect(
        within(rowOf("Como remarcar")).queryAllByText("Synced").length,
      ).toBe(1),
    );
    // Closed, then the source is removed somewhere else, then the list is opened again.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    source = null;
    const before = docReads();
    fireEvent.click(screen.getByRole("button", { name: "open", hidden: true }));
    await screen.findByText(/does not mirror a help center/);
    await new Promise((r) => setTimeout(r, 200));
    expect(docReads()).toBe(before + 1);
  });

  test("a sync that lands re-reads the list, so a new article shows up", async () => {
    source = { ...FAILED_RUN };
    docs = [SYNCED, CURATED];
    await openList();
    await screen.findByText("https://ajuda.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(sent("POST", "/source/sync").length).toBe(1));
    // The run brings an article the list never had; no per-document event can insert it.
    docs = [
      SYNCED,
      { ...SYNCED, id: "d3", title: "Artigo novo", externalId: "78" },
      CURATED,
    ];
    source = {
      ...FAILED_RUN,
      lastSyncAt: "2026-09-20T10:05:00.000Z",
      lastStatus: "ok",
      lastMessage: "3 articles",
    };
    await screen.findByText("Artigo novo", undefined, { timeout: 6_000 });
  }, 10_000);

  test("closing the list with a source half typed asks before discarding it", async () => {
    docs = [CURATED];
    await openList();
    fireEvent.click(
      await screen.findByRole("button", { name: "Set up source" }),
    );
    fireEvent.change(screen.getByLabelText(/Portal URL/), {
      target: { value: "https://ajuda.example.com" },
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await screen.findByRole("button", { name: /^discard$/i });
    expect(
      (screen.getByLabelText(/Portal URL/) as HTMLInputElement).value,
    ).toBe("https://ajuda.example.com");
  });

  test("a sync that runs in batches keeps the list following every batch, and tells the page", async () => {
    source = { ...FAILED_RUN };
    docs = [SYNCED, CURATED];
    await openList();
    await screen.findByText("https://ajuda.example.com");
    changed = 0;
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(sent("POST", "/source/sync").length).toBe(1));
    // The first batch hits its write budget and lands; the next one is scheduled after it.
    docs = [
      SYNCED,
      { ...SYNCED, id: "d3", title: "Lote um", externalId: "78" },
      CURATED,
    ];
    source = {
      ...FAILED_RUN,
      lastSyncAt: "2026-09-20T10:05:00.000Z",
      lastStatus: "ok",
      lastMessage: "created 1; more to do, continuing shortly",
    };
    await screen.findByText("Lote um", undefined, { timeout: 6_000 });
    // The page behind the modal counts documents too, so it is told.
    expect(changed).toBeGreaterThanOrEqual(1);
    docs = [
      SYNCED,
      { ...SYNCED, id: "d3", title: "Lote um", externalId: "78" },
      { ...SYNCED, id: "d4", title: "Lote dois", externalId: "79" },
      CURATED,
    ];
    source = {
      ...FAILED_RUN,
      lastSyncAt: "2026-09-20T10:05:20.000Z",
      lastStatus: "ok",
      lastMessage: "created 1",
    };
    await screen.findByText("Lote dois", undefined, { timeout: 6_000 });
  }, 20_000);
});
