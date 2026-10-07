/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { withI18n } from "@/tests/utils/i18n";

// A LIST NARROWED TO AN OUTCOME STAYS THAT OUTCOME'S. A live event can move a row out of it (a
// reopen, a person taking over) and does not carry what decides membership, so the list asks the
// server again instead of merging the event into the row. Without that narrowing, the row merges in
// place as it always did.

type Handlers = {
  onConversation?: (event: {
    conversationId: string;
    status?: string;
    assigneeId: number | null;
    assigneeType: string | null;
    lastEventAt?: string;
  }) => void;
};
let handlers: Handlers = {};
mock.module("@/client/hooks/useTenantEvents", () => ({
  useTenantEvents: (h: Handlers) => {
    handlers = h;
  },
}));

const { ConversationsPage } = await import("@/client/pages/ConversationsPage");

const realFetch = globalThis.fetch;
let listCalls = 0;

const ROW = {
  id: "41",
  threadId: "t:41",
  chatwootConversationId: 410,
  status: "resolved",
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
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(
      String(typeof input === "string" ? input : (input as Request).url),
      "http://localhost",
    );
    if (url.pathname.endsWith("/conversations/agents"))
      return json({ agents: [] });
    if (url.pathname.endsWith("/conversations")) {
      listCalls++;
      return json({ instance: "i", conversations: [ROW], nextCursor: null });
    }
    return json({});
  }) as unknown as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  cleanup();
  listCalls = 0;
  handlers = {};
});

function mount(path: string) {
  render(
    withI18n(
      <MemoryRouter initialEntries={[path]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <ConversationsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
}

const reopen = () =>
  act(() => {
    handlers.onConversation?.({
      conversationId: "41",
      status: "open",
      assigneeId: 7,
      assigneeType: "User",
      lastEventAt: "2026-10-04T13:00:00.000Z",
    });
  });

describe("a live change on a list narrowed to an outcome", () => {
  test("asks the server again", async () => {
    mount(
      "/conversations?outcome=resolved_by_agent&createdSince=2026-10-04T03:00:00.000Z&createdUntil=2026-10-05T03:00:00.000Z",
    );
    await waitFor(() => {
      expect(screen.queryAllByText("Cliente").length).toBeGreaterThan(0);
    });
    const before = listCalls;
    await reopen();
    await waitFor(() => {
      expect(listCalls).toBe(before + 1);
    });
  });

  test("without the narrowing, the row merges in place", async () => {
    mount("/conversations");
    await waitFor(() => {
      expect(screen.queryAllByText("Cliente").length).toBeGreaterThan(0);
    });
    const before = listCalls;
    await reopen();
    // Give a refetch, were one coming, the time to be asked.
    await new Promise((r) => setTimeout(r, 50));
    expect(listCalls).toBe(before);
  });
});
