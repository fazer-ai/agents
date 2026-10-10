/// <reference lib="dom" />

import { render, screen } from "@testing-library/react";
import type { i18n as I18n } from "i18next";
import { MemoryRouter, Route, Routes } from "react-router";
import { withI18n } from "./i18n";

// The conversation page, rendered whole against a stubbed API: the conversation given by the test,
// an empty thread, a signed-in operator of the given role, and the outcome each action answers. The
// operator carries no tenant unless one is given, so by default the realtime socket stays closed.

const { ConversationDetailPage } = await import(
  "@/client/pages/ConversationDetailPage"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");

export const CONVERSATION = {
  id: "77",
  threadId: "1:1:4077",
  chatwootConversationId: 4077,
  status: "pending",
  assigneeId: null,
  assigneeType: null,
  assigneeName: null,
  heldByAnotherParty: false,
  lastError: null,
  lastErrorAt: null,
  inbox: { id: "3", name: "WhatsApp" },
  contact: { name: "Cliente", voiceReply: null },
  agentId: "41",
  agentName: "Atendente",
  agentEnabled: true,
  agentHasBot: true,
  observerNames: [],
  observers: [],
  agentMode: "production",
  agentModel: "gpt-4o-mini",
  outOfHours: false,
  testActivatedAt: null,
  followUp: null,
  appointmentReminders: [],
  chatwootBaseUrl: "https://chat.example.com",
  accountId: 1,
  trail: [],
  usage: {
    total: {
      calls: 0,
      promptTokens: 0,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      completionTokens: 0,
      byNode: {},
      costUsd: 0,
      unpricedCalls: 0,
      olderTablePricedCalls: 0,
      tenantPricedCalls: 0,
      reportedPricedCalls: 0,
    },
    turns: [],
  },
};

export type Conversation = typeof CONVERSATION;

export interface ConversationStub {
  conversation: Record<string, unknown>;
  requests: string[];
  // What `POST /return` and `POST /reengage` answer, read at the moment of the call.
  returnOutcome: string;
  reengageOutcome: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// `tenantId` set opens the realtime socket (a test that feeds it installs a fake WebSocket first).
export function stubConversationApi(
  over: Partial<Record<keyof Conversation, unknown>> = {},
  role = "TENANT_ADMIN",
  tenantId: string | null = null,
): ConversationStub {
  // NOTE: a tenant another file left in storage would open a real socket for a user who has none.
  sessionStorage.clear();
  localStorage.clear();
  const stub: ConversationStub = {
    conversation: { ...CONVERSATION, ...over },
    requests: [],
    returnOutcome: "returned",
    reengageOutcome: "posted",
  };
  const base = `/api/v1/conversations/${stub.conversation.id}`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    stub.requests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/auth/me") {
      return json({
        user: {
          id: "9",
          email: "op@example.com",
          name: "Operadora",
          role,
          tenantId,
        },
      });
    }
    if (url.pathname === base) return json({ conversation: stub.conversation });
    if (url.pathname === `${base}/messages`) {
      return json({
        messages: [],
        messagesUnavailable: false,
        hasMoreOlder: false,
      });
    }
    if (url.pathname === `${base}/return`) {
      return json({ outcome: stub.returnOutcome });
    }
    if (url.pathname === `${base}/reengage`) {
      return json({ outcome: stub.reengageOutcome });
    }
    return method === "GET"
      ? json({ error: "not stubbed" }, 404)
      : json({ ok: true });
  }) as unknown as typeof fetch;
  return stub;
}

// Renders the page and waits until the conversation's contact is on screen.
export async function renderConversation(
  stub: ConversationStub,
  instance?: I18n,
): Promise<void> {
  render(
    withI18n(
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <MemoryRouter
              initialEntries={[`/conversations/${stub.conversation.id}`]}
            >
              <Routes>
                <Route
                  path="/conversations/:id"
                  element={<ConversationDetailPage />}
                />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>,
      instance,
    ),
  );
  await screen.findAllByText("Cliente", undefined, { timeout: 5_000 });
}
