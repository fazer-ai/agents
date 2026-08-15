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

function nextDocs(): DocsPayload {
  const answer = docsQueue[Math.min(docsCalls, docsQueue.length - 1)];
  docsCalls += 1;
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
                get: async () => ({ data: nextDocs(), error: null }),
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
      {m.modals}
    </>
  );
}

async function openModal() {
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
  await screen.findByText("Doc");
}

const PENDING_TEXT = /credential was never filled in/i;
const NEUTRAL_TEXT = /aren't indexed yet/i;

describe("knowledge documents modal — the embedding block is never stale", () => {
  beforeEach(() => {
    docsCalls = 0;
    docsQueue = [];
    reindexResponse = {};
    onKnowledgeDocument = null;
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
    expect(screen.getByText(PENDING_TEXT)).toBeDefined();
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

    await waitFor(() => expect(screen.getByText(NEUTRAL_TEXT)).toBeDefined());
    expect(screen.queryByText(PENDING_TEXT)).toBeNull();
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
    await waitFor(() => expect(screen.queryByText("Doc")).not.toBeNull());
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
    await waitFor(() => expect(screen.queryByText("Doc")).not.toBeNull());
    expect(docsCalls).toBe(1);
  });
});
