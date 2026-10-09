/// <reference lib="dom" />

import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
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
let handlers: Handlers = {};
mock.module("@/client/hooks/useTenantEvents", () => ({
  useTenantEvents: (h: Handlers) => {
    handlers = h;
  },
}));

const { ConversationsPage } = await import("@/client/pages/ConversationsPage");

const realFetch = globalThis.fetch;
let pending: unknown[] = [];

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
    if (url.pathname.endsWith("/conversations"))
      return json({ instance: "i", conversations: [ROW], nextCursor: null });
    if (url.pathname.endsWith("/document-approvals"))
      return json({ instance: "i", requests: pending });
    return json({});
  }) as unknown as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  cleanup();
  handlers = {};
  pending = [];
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
    expect(screen.queryByText("Document awaiting approval")).toBeNull(),
  );
});
