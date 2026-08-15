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
  if (gateOnCall === docsCalls) {
    await new Promise<void>((r) => {
      releaseGate = r;
    });
  }
  return answer as DocsPayload;
}

mock.module("@/client/hooks/useTenantEvents", () => ({
  useTenantEvents: (o: {
    onKnowledgeDocument?: typeof onKnowledgeDocument;
  }) => {
    onKnowledgeDocument = o.onKnowledgeDocument ?? null;
  },
}));

mock.module("@/client/lib/api", () => ({
  api: {
    api: {
      v1: {
        knowledge: {
          bases: Object.assign(
            (_: { id: string }) => ({
              documents: {
                get: async () => ({ data: await nextDocs(), error: null }),
              },
              reindex: { post: async () => ({ data: reindexResponse }) },
            }),
            { get: async () => ({ data: { bases: [] }, error: null }) },
          ),
          documents: (_: { id: string }) => ({
            get: async () => ({ data: null, error: null }),
          }),
        },
      },
    },
  },
}));

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallback?: string | Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => {
      const fb = typeof fallback === "string" ? fallback : key;
      const vars = (typeof fallback === "string" ? opts : fallback) ?? {};
      return fb.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ""));
    },
    i18n: { language: "en" },
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
const NEUTRAL_TEXT = /aren't indexed yet/i;

describe("knowledge documents modal — the embedding block is never stale", () => {
  beforeEach(() => {
    docsCalls = 0;
    docsQueue = [];
    reindexResponse = {};
    onKnowledgeDocument = null;
    gateOnCall = null;
  });

  afterEach(() => {
    cleanup();
  });

  // mock.module is global to the process and leaks across files in the same worker.
  afterAll(() => {
    mock.restore();
  });

  test("the block the list came with is what the banner explains", async () => {
    docsQueue = [
      {
        documents: [doc()],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    await openModal();
    expect(shows(PENDING_TEXT)).toBe(true);
  });

  // The finding itself. The event says only that the worker put the row back to UNINDEXED; whether
  // the configuration that refused it is still refusing is a separate question, and the only way to
  // answer it is to ask again.
  test("a document coming back unindexed re-reads the block instead of repeating the old one", async () => {
    docsQueue = [
      {
        documents: [doc({ status: "PROCESSING" })],
        embeddingBlock: { reason: "credential_pending" },
      },
      // Meanwhile, in another tab, the credential was filled.
      { documents: [doc()], embeddingBlock: null },
    ];
    await openModal();
    expect(docsCalls).toBe(1);

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
      {
        documents: [doc()],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    await openModal();
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(screen.getByText(PENDING_TEXT)).toBeDefined());
  });

  // Review finding, round 6: retrying ONE document goes PENDING → PROCESSING → READY and never comes
  // back UNINDEXED, so keying the refresh on UNINDEXED alone left the remaining rows and the banner
  // explaining a block the worker had just disproved. Reaching PROCESSING means the job cleared the
  // prerequisite check, which IS the answer — no request needed.
  test("a document that starts indexing proves the block is gone", async () => {
    docsQueue = [
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
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
    expect(docsCalls).toBe(1);
  });

  // Review finding, round 6: the block is per workspace but the REQUEST is per base. A read started
  // for one base and answered after the modal moved to another would label the base on screen with
  // the other one's instructions (docs/modals.md).
  test("a read that lands after the modal moved on is discarded", async () => {
    docsQueue = [
      // 1: base A opens, blocked.
      {
        documents: [doc({ status: "PROCESSING" })],
        embeddingBlock: { reason: "credential_pending" },
      },
      // 2: A's recheck, held open until B is on screen.
      {
        documents: [doc()],
        embeddingBlock: { reason: "credential_pending" },
      },
      // 3: base B opens, nothing blocking.
      { documents: [doc({ title: "OutroDoc" })], embeddingBlock: null },
    ];
    gateOnCall = 2;
    await openModal();
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(docsCalls).toBe(2));

    // The dialog traps focus and hides the rest of the tree, so the operator's real route to another
    // base is to close this one first.
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "open other" }));
    await screen.findByText("OutroDoc");
    expect(shows(PENDING_TEXT)).toBe(false);

    releaseGate();
    // Give A's answer every chance to land on B before asserting it did not.
    await waitFor(() => expect(docsCalls).toBe(3));
    expect(shows(PENDING_TEXT)).toBe(false);
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

  // Review finding, round 7: the base fence is not enough on its own. Within the SAME base, a
  // PROCESSING event can clear the block while a read started earlier is still open, and that older
  // answer would put the cleared block back — with nothing to correct it afterwards, since the rows
  // go on to READY without another UNINDEXED.
  test("a read that resolves after a newer answer does not undo it", async () => {
    docsQueue = [
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
      // The recheck, held open. By the time it lands its answer is out of date.
      {
        documents: [doc(), doc({ id: "d2", title: "Outro" })],
        embeddingBlock: { reason: "credential_pending" },
      },
    ];
    gateOnCall = 2;
    await openModal();
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "UNINDEXED",
    });
    await waitFor(() => expect(docsCalls).toBe(2));

    // The credential was filled elsewhere and a job got through, which is newer than what the open
    // read is about to say.
    onKnowledgeDocument?.({
      knowledgeBaseId: "b1",
      documentId: "d1",
      status: "PROCESSING",
    });
    await waitFor(() => expect(shows(NEUTRAL_TEXT)).toBe(true));

    releaseGate();
    await waitFor(() => expect(shows(NEUTRAL_TEXT)).toBe(true));
    expect(shows(PENDING_TEXT)).toBe(false);
  });

  // A bulk index that hits the block emits one event per document, and the answer is identical for
  // all of them: the block is the workspace's, not the row's.
  test("a burst of blocked documents does not become a burst of reads", async () => {
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
    await waitFor(() => expect(docsCalls).toBe(2));
    // Settle, then confirm the in-flight one was the only extra read.
    await waitFor(() => expect(shows("Doc")).toBe(true));
    expect(docsCalls).toBe(2);
  });

  // A status that is not UNINDEXED cannot be the worker refusing, so it must not turn a bulk index
  // into one list read per row.
  test("the other statuses do not each trigger a read", async () => {
    docsQueue = [
      { documents: [doc({ status: "PROCESSING" })], embeddingBlock: null },
    ];
    await openModal();
    for (const status of ["PROCESSING", "READY", "FAILED"]) {
      onKnowledgeDocument?.({
        knowledgeBaseId: "b1",
        documentId: "d1",
        status,
      });
    }
    await waitFor(() => expect(shows("Doc")).toBe(true));
    expect(docsCalls).toBe(1);
  });
});
