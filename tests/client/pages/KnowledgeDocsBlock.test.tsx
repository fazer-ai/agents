/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider } from "@/client/components";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";

// Issue #80, review finding of round 5: the embedding block is a READ-TIME answer about the
// workspace's configuration, and the documents modal holds it as a snapshot taken when the list was
// fetched. While that modal stays open, another tab or another administrator can fill, delete or
// change the embedding credential — and the worker events that follow carry no reason of their own
// (deliberately: the reason belongs to the configuration, not to the row), so the badge would go on
// naming a block that was resolved, or stay silent about one that just appeared.

interface DocsPayload {
  documents: Record<string, unknown>[];
  embeddingBlock: { reason: string } | null;
}

// Successive answers of the documents endpoint. The point of the test is that the console asks
// again, so the second answer has to be allowed to differ from the first.
let docsQueue: DocsPayload[] = [];
let docsCalls = 0;
let reindexResponse: Record<string, unknown> = {};
// What the add-a-text-document POST answers. Null means it is not being exercised.
let addDocResponse: { status: number; body: unknown } | null = null;
let onKnowledgeDocument:
  | ((e: {
      knowledgeBaseId: string;
      documentId: string;
      status: string;
      chunkCount?: number;
      error?: string;
    }) => void)
  | null = null;

// Holds ONE of the documents reads open (1-based), so a test can interleave another base's read
// with it. Set by the test that needs it; null otherwise.
let gateOnCall: number | null = null;
let releaseGate: () => void = () => undefined;

async function nextDocs(): Promise<DocsPayload> {
  const answer = docsQueue[Math.min(docsCalls, docsQueue.length - 1)];
  docsCalls += 1;
  if (gatedDocsCalls.includes(docsCalls)) {
    const n = docsCalls;
    await new Promise<void>((r) => {
      docsReleasers.set(n, r);
    });
  }
  return answer as DocsPayload;
}

// Holds any number of the LIST reads open (1-based call numbers), so two sessions can be in flight
// at once and be answered in either order.
let gatedDocsCalls: number[] = [];
const docsReleasers = new Map<number, () => void>();

function releaseDocs(call: number) {
  docsReleasers.get(call)?.();
}

// Successive answers of the workspace's embedding-block endpoint. The point of these tests is that
// the console asks again, so each answer has to be allowed to differ from the one before.
let blockQueue: ({ reason: string } | null)[] = [];
let blockCalls = 0;
// Eden rejects rather than returning empty data when the network is down.
let blockThrows = false;

async function nextBlock(): Promise<{ block: { reason: string } | null }> {
  const answer =
    blockQueue[Math.min(blockCalls, blockQueue.length - 1)] ?? null;
  blockCalls += 1;
  if (blockThrows) throw new Error("network down");
  if (gateOnCall === blockCalls) {
    await new Promise<void>((r) => {
      releaseGate = r;
    });
  }
  return { block: answer };
}

mock.module("@/client/hooks/useTenantEvents", () => ({
  useTenantEvents: (o: {
    onKnowledgeDocument?: typeof onKnowledgeDocument;
  }) => {
    onKnowledgeDocument = o.onKnowledgeDocument ?? null;
  },
}));

// The api module is NOT mocked: `mock.module` is global to the process and leaks into every other
// file sharing the worker, which is how this file first broke `vaultCache` in CI while passing
// locally. The Eden treaty calls `globalThis.fetch`, so stubbing that reaches the same code with no
// spill (the same reasoning, and the same shape, as tests/client/lib/vaultCache.test.ts).
const realFetch = globalThis.fetch;

function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/knowledge/embedding-block")) {
      return json(await nextBlock());
    }
    if (url.includes("/reindex")) {
      return json(reindexResponse);
    }
    if (url.includes("/documents") && method === "GET") {
      return json(await nextDocs());
    }
    if (url.includes("/documents") && method === "POST" && addDocResponse) {
      return new Response(JSON.stringify(addDocResponse.body), {
        status: addDocResponse.status,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as RequestInfo | URL, init);
  }) as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// The stub resolves against the REAL catalogs, and falls back to the call site's default only when
// the key is missing — which is what i18next itself does. A stub that always answered the default
// would render correctly for a key the catalog does not have, and that is precisely the failure
// issue #256 is about: an unresolvable key is invisible at runtime. With the lookup in place, a
// test asserting the CATALOG's sentence goes red when the key stops resolving.
const CATALOGS: Record<string, Record<string, unknown>> = {
  en: clientEn as Record<string, unknown>,
  "pt-BR": clientPt as Record<string, unknown>,
};
// The locale the mounted tree renders in; a test flips it to read the other language.
let uiLanguage = "en";

function lookup(locale: string, key: string): string | undefined {
  let node: unknown = CATALOGS[locale];
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallback?: string | Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => {
      const fb = typeof fallback === "string" ? fallback : key;
      const vars = (typeof fallback === "string" ? opts : fallback) ?? {};
      const template = lookup(uiLanguage, key) ?? fb;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, k) =>
        String(vars[k] ?? ""),
      );
    },
    i18n: { language: uiLanguage },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
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

const { useKnowledgeManager } = await import(
  "@/client/pages/resources/useKnowledgeManager"
);

function doc(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    title: "Doc",
    status: "UNINDEXED",
    chunkCount: 0,
    error: null,
    sourceType: "text",
    createdAt: new Date(0).toISOString(),
    ...over,
  };
}

function Harness() {
  const m = useKnowledgeManager({ onChanged: () => {} });
  return (
    <>
      <button
        type="button"
        onClick={() => m.openDocs({ id: "b1", name: "Base" })}
      >
        open
      </button>
      {/* A second base, so a test can swap the modal's subject while a read for the first is open. */}
      <button
        type="button"
        onClick={() => m.openDocs({ id: "b2", name: "Outra base" })}
      >
        open other
      </button>
      {m.modals}
    </>
  );
}

async function openModal(firstDocTitle = "Doc") {
  render(
    // The blocked badge is wrapped in a <Tooltip>, which is a Radix consumer: without the provider
    // the App normally supplies, rendering the row throws.
    <TooltipProvider>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  await screen.findByText(firstDocTitle);
}

// Every assertion about what is on screen goes through this, never through a raw element: an
// expectation that fails while HOLDING a happy-dom node makes the runner serialize a cyclic tree,
// and the run stops producing output instead of reporting a failure.
function shows(text: string | RegExp): boolean {
  return screen.queryAllByText(text).length > 0;
}

const PENDING_TEXT = /credential was never filled in/i;
const EMPTY_TEXT = /credential is empty/i;
const NOT_CONFIGURED_TEXT = /is not configured for this workspace/i;
const NEUTRAL_TEXT = /aren't indexed yet/i;

describe("knowledge documents modal — the embedding block is never stale", () => {
  beforeEach(() => {
    docsCalls = 0;
    docsQueue = [];
    blockCalls = 0;
    blockQueue = [];
    blockThrows = false;
    reindexResponse = {};
    onKnowledgeDocument = null;
    gateOnCall = null;
    gatedDocsCalls = [];
    docsReleasers.clear();
    addDocResponse = null;
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
  });

  // The two module mocks left are for hooks nothing else under test imports; the fetch stub is
  // handed back either way.
  afterAll(() => {
    globalThis.fetch = realFetch;
    mock.restore();
  });

  test("the block the list came with is what the banner explains", async () => {
    docsQueue = [
      { documents: [doc()], embeddingBlock: { reason: "credential_pending" } },
    ];
    await openModal();
    expect(shows(PENDING_TEXT)).toBe(true);
    // The list already answered it; nothing to ask.
    expect(blockCalls).toBe(0);
  });

  // The heart of it: an event says a job refused, or stopped refusing, but never says what the
  // configuration IS. Only the server knows that, so every event is a question.
  test("an event re-reads the block instead of repeating the old one", async () => {
    docsQueue = [
      {
        documents: [doc({ status: "PROCESSING" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    // Meanwhile, in another tab, the credential was filled.
    blockQueue = [null];
    await openModal();

    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });

    await waitFor(() => expect(shows(NEUTRAL_TEXT)).toBe(true));
    expect(shows(PENDING_TEXT)).toBe(false);
  });

  // The mirror case: nothing was blocking when the modal opened, and something is now. Silence would
  // read as "click Index and it will work".
  test("a block that appeared while the modal was open is picked up", async () => {
    docsQueue = [
      { documents: [doc({ status: "PROCESSING" })], embeddingBlock: null },
    ];
    blockQueue = [{ reason: "credential_pending" }];
    await openModal();
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(shows(PENDING_TEXT)).toBe(true));
  });

  // Review finding, round 6: retrying ONE document goes PENDING → PROCESSING → READY and never comes
  // back UNINDEXED, so an UNINDEXED-only trigger left the remaining rows and the banner explaining a
  // block that was already resolved.
  test("a document that starts indexing lifts the block it was showing", async () => {
    docsQueue = [
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    blockQueue = [null];
    await openModal();
    expect(shows(PENDING_TEXT)).toBe(true);

    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "PROCESSING",
    });

    // The second row is still UNINDEXED, so the banner is still there — now saying the ordinary
    // thing instead of naming a credential.
    await waitFor(() => expect(shows(NEUTRAL_TEXT)).toBe(true));
    expect(shows(PENDING_TEXT)).toBe(false);
  });

  // Review findings, rounds 9 and 10, and the reason PROCESSING is a question too: it describes the
  // configuration the job RESOLVED, and an administrator can have replaced it since. Treating it as
  // the last word would silence a real block with nothing to bring it back — the direction that
  // hurts, because the operator is never told they have to act.
  test("a document that starts indexing cannot silence a newer block", async () => {
    docsQueue = [
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    // The credential was deleted outright while that job was running.
    blockQueue = [{ reason: "embedding_not_configured" }];
    await openModal();
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "PROCESSING",
    });
    await waitFor(() => expect(shows(NOT_CONFIGURED_TEXT)).toBe(true));
  });

  // Review finding, round 10: a guard keyed on the block CURRENTLY RENDERED is blind to the one a
  // read has already fetched and is about to commit. There is no such guard now — every event asks —
  // so the case is covered by construction, and this pins it.
  test("an event still asks while the screen shows no block", async () => {
    docsQueue = [
      {
        // The second row keeps the banner on screen once there is something to say.
        documents: [
          doc({ status: "PROCESSING" }),
          doc({ id: "d2", title: "Outro" }),
        ],
        embeddingBlock: null,
      },
    ];
    blockQueue = [{ reason: "credential_empty" }];
    await openModal();
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "PROCESSING",
    });
    await waitFor(() => expect(blockCalls).toBe(1));
    await waitFor(() => expect(shows(EMPTY_TEXT)).toBe(true));
  });

  // Review finding, round 6: the reindex toast had its own two-branch wording, so the third reason
  // was announced as the second — the operator would be told to fill a credential that IS filled,
  // with a blank secret, while the banner two lines up said the right thing.
  test("a blocked reindex names the reason the server actually gave", async () => {
    docsQueue = [{ documents: [doc()], embeddingBlock: null }];
    reindexResponse = { blocked: { reason: "credential_empty" } };
    await openModal();
    fireEvent.click(screen.getByRole("button", { name: /index all/i }));
    await waitFor(() => expect(shows(EMPTY_TEXT)).toBe(true));
    expect(shows(PENDING_TEXT)).toBe(false);
  });

  // Review findings, rounds 7 and 8: two reads can be open at once (a burst re-arms the window while
  // an earlier one is still travelling), and the older one landing last would undo the newer answer,
  // with nothing afterwards to correct it. The ticket only orders them if it is taken BEFORE the
  // request — taken on arrival, the late response is by definition the newest and wins.
  test("a read that resolves after a newer answer does not undo it", async () => {
    docsQueue = [
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    // 1: held open, and still says blocked. 2: lands first, and knows the credential was filled.
    blockQueue = [{ reason: "credential_pending" }, null];
    gateOnCall = 1;
    await openModal();

    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(blockCalls).toBe(1));

    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d2",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(shows(NEUTRAL_TEXT)).toBe(true));

    releaseGate();
    await waitFor(() => expect(shows(NEUTRAL_TEXT)).toBe(true));
    expect(shows(PENDING_TEXT)).toBe(false);
  });

  // The list read carries a block too, and it is subject to the same ordering: a slow one must not
  // land on top of a recheck that started later and already answered.
  test("a slow list read cannot outrank an answer that overtook it", async () => {
    docsQueue = [
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    blockQueue = [null];
    await openModal();
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(shows(NEUTRAL_TEXT)).toBe(true));
    expect(shows(PENDING_TEXT)).toBe(false);
  });

  // A batch emits one event per document and the answer is identical for all of them: the block is
  // the workspace's, not the row's.
  test("a burst of events does not become a burst of reads", async () => {
    docsQueue = [
      { documents: [doc({ status: "PROCESSING" })], embeddingBlock: null },
    ];
    await openModal();
    for (const documentId of ["d1", "d2", "d3"]) {
      onKnowledgeDocument?.({
        knowledgeBaseId: "b1",
        documentId,
        status: "UNINDEXED",
      });
    }
    await waitFor(() => expect(blockCalls).toBe(1));
    await waitFor(() => expect(shows("Doc")).toBe(true));
    expect(blockCalls).toBe(1);
  });

  // Review finding, round 12: this read runs on a timer, so a failure is not a one-off. An offline
  // browser makes Eden reject, and an unhandled rejection would repeat every 30s for as long as the
  // modal is open — while the banner is the one thing that must not start guessing.
  test("a failed read keeps the last answer instead of throwing", async () => {
    docsQueue = [
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    blockThrows = true;
    await openModal();
    expect(shows(PENDING_TEXT)).toBe(true);

    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(blockCalls).toBe(1));

    // Still what the list said, and the modal is still alive.
    expect(shows(PENDING_TEXT)).toBe(true);
    expect(shows("Doc")).toBe(true);
  });

  // Review finding, round 13: a read that FAILS answers nothing, so it must not disqualify a good
  // response that was already travelling when it started. Comparing against the newest request
  // STARTED did exactly that, and the catch then kept the older state — the list's answer thrown
  // away because a later recheck happened to fail.
  test("a failed read does not discard a good answer already in flight", async () => {
    docsQueue = [
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    gatedDocsCalls = [1];
    blockThrows = true;

    render(
      <TooltipProvider>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(docsCalls).toBe(1));

    // A job reports back while the list is still travelling, and that recheck fails.
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(blockCalls).toBe(1));

    releaseDocs(1);
    await screen.findByText("Doc");
    expect(shows(PENDING_TEXT)).toBe(true);
  });

  // Review finding, round 14: a response issued for a session the operator has already closed must
  // not land in the next one. `blockCommitted` alone cannot see that — it only knows what arrived,
  // so an old response that arrives BEFORE the new session's own is the newest thing yet and paints
  // the closed screen's block onto the open one.
  test("a response for a closed session does not land in the next one", async () => {
    docsQueue = [
      // 1: the first session, blocked. Held open across the close. Its rows are named differently so
      // the test can tell whose documents landed, not just whose block.
      {
        documents: [doc({ title: "DocAntigo" })],
        embeddingBlock: { reason: "credential_pending" },
      },
      // 2: the session the operator is looking at. The credential was filled in between, and this
      // one is held too, so the stale answer is the first to arrive.
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: null,
      },
    ];
    gatedDocsCalls = [1, 2];

    render(
      <TooltipProvider>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(docsCalls).toBe(1));

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(docsCalls).toBe(2));

    // The closed session answers first, and must be ignored on its way in — neither its block nor
    // its rows.
    releaseDocs(1);
    await waitFor(() => expect(blockCalls).toBe(0));
    expect(shows("DocAntigo")).toBe(false);
    expect(shows(PENDING_TEXT)).toBe(false);

    releaseDocs(2);
    await screen.findByText("Doc");
    expect(shows(NEUTRAL_TEXT)).toBe(true);
    expect(shows(PENDING_TEXT)).toBe(false);
  });

  // Review finding, round 15, and a defect the previous round introduced: the rows and the block
  // arrive together but do not share a clock. The block can be superseded by a dedicated read that
  // is faster than the list; tying `setDocs` to that same check meant a list response could be
  // refused entirely, leaving the modal on its skeleton with no way out.
  test("rows still render when a faster recheck outran their block", async () => {
    docsQueue = [
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    blockQueue = [null];
    gatedDocsCalls = [1];

    render(
      <TooltipProvider>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(docsCalls).toBe(1));

    // A job reports back before the list arrives, and its block read answers first.
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(blockCalls).toBe(1));

    releaseDocs(1);
    // The rows belong to this session and must render; the block stays the newer answer's.
    await screen.findByText("Doc");
    expect(shows(NEUTRAL_TEXT)).toBe(true);
    expect(shows(PENDING_TEXT)).toBe(false);
  });

  // An event for another base is not this modal's business at all.
  test("another base's events are ignored", async () => {
    docsQueue = [
      { documents: [doc({ status: "PROCESSING" })], embeddingBlock: null },
    ];
    await openModal();
    onKnowledgeDocument?.({
      knowledgeBaseId: "b2",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(shows("Doc")).toBe(true));
    expect(blockCalls).toBe(0);
  });
});

// Issue #247. The API refusal names the field and the offending code point, which is the whole
// difference between an answer an operator can act on and a 500. The console used to collapse every
// 4xx into "Could not add document", so the reported scenario (someone uploads a file, gets nothing
// they can act on) survived the API being fixed. What is asserted here is the SERVER's sentence on
// screen, not a status the client re-phrased.
describe("knowledge: a refusal the server phrased reaches the operator", () => {
  beforeEach(() => {
    docsCalls = 0;
    docsQueue = [{ documents: [doc()], embeddingBlock: null }];
    blockCalls = 0;
    blockQueue = [];
    blockThrows = false;
    addDocResponse = null;
    onKnowledgeDocument = null;
    gateOnCall = null;
    gatedDocsCalls = [];
    docsReleasers.clear();
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
  });

  // This describe reinstalls the stub in its own beforeEach, AFTER the describe above already
  // handed `fetch` back in its afterAll. Without this, the last case leaves both the stub and a 415
  // `addDocResponse` installed for whatever else shares this Bun worker, and a POST whose URL
  // happens to contain `/documents` is answered by a test that already finished. The failure would
  // land in another file and depend on execution order (review round 4).
  afterAll(() => {
    globalThis.fetch = realFetch;
    addDocResponse = null;
  });

  async function addText(body: unknown, status: number) {
    addDocResponse = { status, body };
    await openModal();
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: /text/i }), {
      target: { value: "some text" },
    });
    const buttons = screen.getAllByRole("button", { name: /^add$/i });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
  }

  test("the refusal's own words are what the toast shows", async () => {
    await addText(
      { error: "text contains characters that cannot be stored (U+0000)" },
      400,
    );
    await waitFor(() => expect(shows(/U\+0000/)).toBe(true));
    expect(shows(/Could not add document/i)).toBe(false);
  });

  test("a refusal with no body of its own still says something", async () => {
    await addText({}, 500);
    await waitFor(() => expect(shows(/Could not add document/i)).toBe(true));
  });

  // The other road to the same column, and the one the issue actually reported: a file, refused
  // per-row rather than by a toast. The three statuses this screen phrases better than the API can
  // (unsupported type, too large, nothing extractable) still win; everything else the API already
  // phrased in this operator's language.
  async function uploadFile(body: unknown, status: number) {
    addDocResponse = { status, body };
    await openModal();
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    fireEvent.click(screen.getByRole("tab", { name: /^file$/i }));
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["policy"], "policy.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], writable: false });
    fireEvent.change(input);
    const buttons = screen.getAllByRole("button", { name: /^add$/i });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
  }

  test("an upload row carries the refusal's own words", async () => {
    await uploadFile(
      { error: "text contains characters that cannot be stored (U+0000)" },
      400,
    );
    // Exact "Failed": the toast beside it says "1 failed.", so a loose match picks the wrong node.
    const chip = await screen.findByText("Failed");
    fireEvent.pointerEnter(chip);
    fireEvent.focus(chip);
    await waitFor(() => expect(shows(/U\+0000/)).toBe(true));
  });

  test("a status this screen phrases better still wins", async () => {
    await uploadFile({ error: "whatever the API said" }, 415);
    const chip = await screen.findByText("Failed");
    fireEvent.pointerEnter(chip);
    fireEvent.focus(chip);
    await waitFor(() => expect(shows(/Unsupported file type/i)).toBe(true));
    expect(shows(/whatever the API said/)).toBe(false);
  });
});

// THE SENTENCE ON SCREEN, IN THE LANGUAGE THE OPERATOR PICKED.
//
// Everything else about issue #256 is checked against data: the server's token matches the client's
// map, the key exists in both catalogs, the two languages differ. None of that proves the sentence
// reaches a reader, and the failure mode being fixed is exactly one that leaves no trace — i18next
// answers an unresolvable key with the call site's default, so a broken key renders ENGLISH to a
// pt-BR operator and nothing anywhere says so.
//
// This mounts the real component and reads the tooltip out of the DOM, in both languages, asserting
// the CATALOG's sentence rather than the call site's default. The stub `t` above falls back to that
// default when a key does not resolve, exactly as i18next does, which is what gives these
// assertions their teeth: break the key and the default renders, and the pt-BR case goes red.
describe("a failed document's reason, rendered", () => {
  beforeEach(() => {
    docsCalls = 0;
    docsQueue = [];
    blockCalls = 0;
    blockQueue = [];
    blockThrows = false;
    reindexResponse = {};
    onKnowledgeDocument = null;
    gateOnCall = null;
    gatedDocsCalls = [];
    docsReleasers.clear();
    addDocResponse = null;
    uiLanguage = "en";
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
    uiLanguage = "en";
  });

  // The three tokens the ingest job stores, next to the sentence each catalog answers with. Read
  // from the catalogs rather than pasted, so a reworded translation does not turn into a red test
  // here; what is asserted is that the RENDERED text is the catalog's, not the fallback's.
  function openTooltip(locale: "en" | "pt-BR") {
    const badge = screen.getByText(
      lookup(locale, "knowledge.docStatus.FAILED") as string,
    );
    fireEvent.pointerEnter(badge);
    fireEvent.focus(badge);
  }

  const CASES = [
    ["errors.embeddingNotConfigured", "embeddingNotConfigured"],
    ["errors.embeddingPending", "embeddingPending"],
    ["errors.embeddingEmpty", "embeddingEmpty"],
  ] as const;

  for (const [token, catalogKey] of CASES) {
    for (const locale of ["en", "pt-BR"] as const) {
      test(`${token} renders the ${locale} sentence`, async () => {
        uiLanguage = locale;
        docsQueue = [
          {
            documents: [doc({ status: "FAILED", error: token })],
            embeddingBlock: null,
          },
        ];
        await openModal();

        const expected = lookup(locale, `knowledge.docError.${catalogKey}`);
        // A missing catalog entry would make the assertion below compare against `undefined` and
        // pass for the wrong reason; the sentence has to exist before it can be looked for.
        expect(typeof expected).toBe("string");

        // Radix renders the tooltip's content on hover, so the badge is opened rather than assumed.
        // The badge itself is localized ("Failed" / "Falhou"), so it is looked up too — querying it
        // by the English word is how this test would silently stop exercising pt-BR.
        openTooltip(locale);
        await waitFor(() => {
          expect(shows(expected as string)).toBe(true);
        });
      });
    }
  }

  // Over ALL THREE tokens, not one. The per-token tests above look for the sentence the catalog holds,
  // so their expectation moves with the catalog: swapping a pt-BR entry for its English text keeps
  // them green. This is the assertion that does not move, and it is the reason the swap goes red.
  test.each(CASES)(
    "%s renders a different sentence in each language",
    async (token, catalogKey) => {
      const seen: string[] = [];
      for (const locale of ["en", "pt-BR"] as const) {
        uiLanguage = locale;
        docsQueue = [
          {
            documents: [doc({ status: "FAILED", error: token })],
            embeddingBlock: null,
          },
        ];
        await openModal();
        openTooltip(locale);
        const text = lookup(
          locale,
          `knowledge.docError.${catalogKey}`,
        ) as string;
        await waitFor(() => {
          expect(shows(text)).toBe(true);
        });
        seen.push(text);
        cleanup();
        docsCalls = 0;
      }
      expect(seen[0]).not.toBe(seen[1]);
    },
  );

  test("the two languages are not the same sentence on screen", async () => {
    const seen: string[] = [];
    for (const locale of ["en", "pt-BR"] as const) {
      uiLanguage = locale;
      docsQueue = [
        {
          documents: [
            doc({ status: "FAILED", error: "errors.embeddingPending" }),
          ],
          embeddingBlock: null,
        },
      ];
      await openModal();
      openTooltip(locale);
      const text = lookup(locale, "knowledge.docError.embeddingPending");
      await waitFor(() => {
        expect(shows(text as string)).toBe(true);
      });
      seen.push(text as string);
      cleanup();
      docsCalls = 0;
    }
    // The control: a screen that ignored the locale would put the same sentence in both slots and
    // every assertion above would still pass.
    expect(seen[0]).not.toBe(seen[1]);
  });

  // The stored column, in the shape a row written before issue #256 carries. Same render path, same
  // tooltip — the alias only matters if it survives to the screen.
  test("a row written before the rename renders the pt-BR sentence too", async () => {
    uiLanguage = "pt-BR";
    docsQueue = [
      {
        documents: [
          doc({
            status: "FAILED",
            error: "errors.embedding.embedding_not_configured",
          }),
        ],
        embeddingBlock: null,
      },
    ];
    await openModal();
    openTooltip("pt-BR");
    const expected = lookup(
      "pt-BR",
      "knowledge.docError.embeddingNotConfigured",
    ) as string;
    expect(typeof expected).toBe("string");
    await waitFor(() => {
      expect(shows(expected)).toBe(true);
    });
    // …and it is not the English one, which is what a missing alias would have fallen back to.
    expect(
      shows(
        lookup("en", "knowledge.docError.embeddingNotConfigured") as string,
      ),
    ).toBe(false);
  });

  // An unknown token is NOT localized: it is the worker's raw diagnostic, and showing it verbatim is
  // the point (a translated "unknown error" would replace the only information there is).
  test("a diagnostic the map does not know is shown verbatim", async () => {
    uiLanguage = "pt-BR";
    docsQueue = [
      {
        documents: [
          doc({ status: "FAILED", error: "boom: connect ECONNREFUSED" }),
        ],
        embeddingBlock: null,
      },
    ];
    await openModal();
    openTooltip("pt-BR");
    await waitFor(() => {
      expect(shows("boom: connect ECONNREFUSED")).toBe(true);
    });
  });
});
