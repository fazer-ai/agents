/// <reference lib="dom" />

import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { fetchTracker } from "@/tests/utils/fetch-settle";
import { withI18n } from "@/tests/utils/i18n";

// The conversations list flags a conversation whose document waits on the team. A live event does
// not carry the flag, so the list asks again for that conversation alone, and the flag follows a
// request opened or decided while the list stays open.

type Handlers = {
  onConversation?: (event: {
    conversationId: string;
    status?: string;
    assigneeId: number | null;
    assigneeType: string | null;
    lastEventAt?: string;
  }) => void;
};
// Absence is asserted as a boolean, never `expect(element).toBeNull()`: inside a `waitFor`, every
// failing try pretty-prints the whole element, which takes seconds under happy-dom and starves the
// short clocks these tests drive (measured on CI: a 100ms clock taking 9s to fire).
let handlers: Handlers = {};
mock.module("@/client/hooks/useTenantEvents", () => ({
  useTenantEvents: (h: Handlers) => {
    handlers = h;
  },
}));

const { ConversationsPage, flagRefresh } = await import(
  "@/client/pages/ConversationsPage"
);

const realFetch = globalThis.fetch;
const fetches = fetchTracker();
let pending: unknown[] = [];
// Set per test: the list's rows, and a conversation's own pending answer.
let rows: unknown[] | null = null;
let pendingByConversation: Record<string, unknown[]> = {};
// Set per test: an answer to hold back, by the order the flag was asked.
let holdFirstFlagRead: Promise<void> | null = null;
let flagReads = 0;
// Set per test: how long every flag read takes.
let flagReadDelayMs = 0;

const ROW = {
  id: "41",
  threadId: "t:41",
  chatwootConversationId: 410,
  status: "pending",
  assigneeId: null,
  assigneeType: null,
  assigneeName: null,
  lastEventAt: "2026-10-04T12:00:00.000Z",
  lastError: null,
  lastErrorAt: null,
  inbox: { id: "3", name: "WhatsApp" },
  contact: { name: "Cliente" },
  agentName: "Ana",
  observerNames: [],
  outOfHours: false,
  awaitingApproval: true,
};

const WAITING = {
  id: "9",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  const fakeFetch = async (input: unknown) => {
    const url = new URL(
      String(typeof input === "string" ? input : (input as Request).url),
      "http://localhost",
    );
    if (url.pathname.endsWith("/conversations/agents"))
      return json({ agents: [] });
    if (url.pathname.endsWith("/conversations"))
      return json({
        instance: "i",
        conversations: rows ?? [ROW],
        nextCursor: null,
      });
    if (url.pathname.endsWith("/document-approvals")) {
      flagReads += 1;
      const conv = url.searchParams.get("conversationId") ?? "";
      const snapshot = pendingByConversation[conv] ?? pending;
      if (flagReads === 1 && holdFirstFlagRead) await holdFirstFlagRead;
      if (flagReadDelayMs > 0)
        await new Promise((r) => setTimeout(r, flagReadDelayMs));
      return json({ instance: "i", requests: snapshot });
    }
    return json({});
  };
  globalThis.fetch = ((input: unknown) =>
    fetches.track(fakeFetch(input))) as unknown as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  cleanup();
  fetches.reset();
  handlers = {};
  pending = [];
  holdFirstFlagRead = null;
  flagReads = 0;
  flagReadDelayMs = 0;
  rows = null;
  pendingByConversation = {};
});

test("a decision while the list is open drops the flag on the next event", async () => {
  render(
    withI18n(
      <MemoryRouter initialEntries={["/conversations"]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <ConversationsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
  await screen.findByText("Document awaiting approval");
  // Decided: nothing pending for the conversation any more.
  pending = [];
  await act(async () => {
    handlers.onConversation?.({
      conversationId: "41",
      status: "open",
      assigneeId: null,
      assigneeType: null,
      lastEventAt: "2026-10-04T13:00:00.000Z",
    });
  });
  await waitFor(() =>
    expect(screen.queryByText("Document awaiting approval") === null).toBe(
      true,
    ),
  );
});

test("an older flag answer arriving last does not put back a cleared flag", async () => {
  let release: () => void = () => {};
  holdFirstFlagRead = new Promise<void>((r) => {
    release = r;
  });
  render(
    withI18n(
      <MemoryRouter initialEntries={["/conversations"]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <ConversationsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
  await screen.findByText("Document awaiting approval");
  const event = {
    conversationId: "41",
    status: "pending",
    assigneeId: null,
    assigneeType: null,
  };
  // The first read sees the request still waiting and is held; the second sees it decided.
  pending = [
    { id: "9", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  ];
  await act(async () => handlers.onConversation?.(event));
  pending = [];
  await act(async () => handlers.onConversation?.(event));
  await waitFor(() =>
    expect(screen.queryByText("Document awaiting approval") === null).toBe(
      true,
    ),
  );
  release();
  await fetches.settled();
  expect(screen.queryByText("Document awaiting approval") === null).toBe(true);
});

test("a flagged row is read again on its own, without any event", async () => {
  const before = flagRefresh.ms;
  flagRefresh.ms = 100;
  // Still waiting until the test decides it.
  pending = [WAITING];
  render(
    withI18n(
      <MemoryRouter initialEntries={["/conversations"]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <ConversationsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
  await screen.findByText("Document awaiting approval");
  // Decided with no bot left to write in the conversation: no event comes.
  pending = [];
  try {
    await waitFor(
      () =>
        expect(screen.queryByText("Document awaiting approval") === null).toBe(
          true,
        ),
      { timeout: 8000 },
    );
  } finally {
    flagRefresh.ms = before;
  }
}, 15_000);

test("flag reads slower than the clock still land", async () => {
  const before = flagRefresh.ms;
  flagRefresh.ms = 100;
  // Still waiting until the test decides it.
  pending = [WAITING];
  render(
    withI18n(
      <MemoryRouter initialEntries={["/conversations"]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <ConversationsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
  await screen.findByText("Document awaiting approval");
  pending = [];
  flagReadDelayMs = 350;
  try {
    await waitFor(
      () =>
        expect(screen.queryByText("Document awaiting approval") === null).toBe(
          true,
        ),
      { timeout: 8000 },
    );
  } finally {
    flagRefresh.ms = before;
  }
}, 15_000);

test("a quiet flagged row is still read while other rows keep re-sorting the list", async () => {
  const before = flagRefresh.ms;
  flagRefresh.ms = 400;
  rows = [
    { ...ROW, id: "41", contact: { name: "Quieta" } },
    { ...ROW, id: "42", contact: { name: "Ativa" } },
    { ...ROW, id: "43", contact: { name: "Outra" } },
  ];
  pendingByConversation = { "41": [WAITING], "42": [WAITING], "43": [WAITING] };
  render(
    withI18n(
      <MemoryRouter initialEntries={["/conversations"]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <ConversationsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
  await waitFor(() =>
    expect(screen.getAllByText("Document awaiting approval")).toHaveLength(3),
  );
  // The quiet one is decided with no event; the other two keep swapping places, faster than the clock.
  pendingByConversation["41"] = [];
  let t = Date.parse("2026-10-04T13:00:00.000Z");
  const churn = setInterval(() => {
    t += 1000;
    handlers.onConversation?.({
      conversationId: t % 2000 === 0 ? "42" : "43",
      status: "pending",
      assigneeId: null,
      assigneeType: null,
      lastEventAt: new Date(t).toISOString(),
    });
  }, 25);
  try {
    await waitFor(
      () =>
        expect(screen.getAllByText("Document awaiting approval")).toHaveLength(
          2,
        ),
      { timeout: 5000 },
    );
  } finally {
    clearInterval(churn);
    flagRefresh.ms = before;
  }
}, 10_000);
