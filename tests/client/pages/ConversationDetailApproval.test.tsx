/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ToastProvider } from "@/client/components";
import { withI18n } from "@/tests/utils/i18n";

// What a conversation's page shows of its document approvals: opened from an approval's page it
// offers the way back next to the way back to the conversations, the private note an approval posts
// renders its link, the conversation's approvals are listed, and the trail marker of an approved
// document's turn names the turn without claiming the PDF was sent (the marker is exactly the case
// where no message carried it, a note when the WhatsApp window was closed).

// Absence is asserted as a boolean: a failing expectation holding a DOM node pretty-prints the whole
// happy-dom tree and stalls the runner.

mock.module("@/client/hooks/useTenantEvents", () => ({
  useTenantEvents: () => {},
}));
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { role: "TENANT_ADMIN" } }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ConversationDetailPage } = await import(
  "@/client/pages/ConversationDetailPage"
);

const CONVERSATION = {
  id: "39",
  threadId: "7:6:381",
  chatwootConversationId: 381,
  status: "pending",
  assigneeId: 123,
  assigneeType: "AgentBot",
  assigneeName: "Atendente",
  heldByAnotherParty: false,
  lastError: null,
  lastErrorAt: null,
  inbox: { id: "6", name: "Site" },
  contact: { name: "Cliente", voiceReply: null },
  agentId: "6",
  agentName: "Atendente",
  agentEnabled: true,
  agentHasBot: true,
  observerNames: [],
  observers: [],
  agentMode: "production",
  agentModel: "gpt-4o-mini",
  outOfHours: false,
  testActivatedAt: null,
  followUp: {
    enabled: false,
    totalSteps: 1,
    nextStep: null,
    nextRunAt: null,
    nextRunAtDeferred: false,
    lastFollowUpAt: null,
    steps: [],
    hours: null,
    managedByRedirect: false,
    redirectNext: null,
    pausedByAppointment: false,
    abandoned: false,
  },
  appointmentReminders: [],
  chatwootBaseUrl: "http://chatwoot.test",
  accountId: 1,
  // An approved document's turn whose message is not on this page: drawn as a trail marker.
  trail: [
    {
      id: "217",
      kind: "approval",
      originRecorded: true,
      messageId: null,
      integrationName: null,
      name: "document_approval",
      status: "ok",
      durationMs: null,
      step: null,
      args: null,
      output: null,
      errorMessage: null,
      turnDelivered: null,
      at: "2026-10-10T13:01:37.246Z",
    },
  ],
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

const NOTE_LINK = "http://console.test/document-approvals/39?switchTenant=7";
const MESSAGES = {
  messages: [
    {
      id: 2819,
      content: `Documento aprovado por Gerente: Orçamento (ORC-0007).\n\n[Ver aprovação](${NOTE_LINK})`,
      messageType: 1,
      private: true,
      createdAt: 1791637295,
      senderName: "Atendente",
      senderType: "agent_bot",
      attachments: [],
      inReplyTo: null,
      isReaction: false,
    },
  ],
  messagesUnavailable: false,
  hasMoreOlder: false,
};

const REQUESTS = {
  requests: [
    {
      id: "39",
      templateId: "6",
      title: "Orçamento",
      status: "APPROVED",
      threadId: "7:6:381",
      conversationId: "39",
      expiresAt: "2026-10-11T13:01:26.141Z",
      reviewerUserId: "3",
      reviewerName: "Gerente",
      note: null,
      decidedAt: "2026-10-10T13:01:34.769Z",
      issuedDocumentId: "27",
      issuedNumber: "ORC-0007",
      outcome: "DELIVERED",
      outcomeAt: "2026-10-10T13:01:37.246Z",
      createdAt: "2026-10-10T13:01:26.168Z",
    },
  ],
};

const realFetch = globalThis.fetch;
let asked: string[] = [];
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  asked.push(`${url.pathname}${url.search}`);
  if (url.pathname === "/api/v1/conversations/39")
    return json({ conversation: CONVERSATION });
  if (url.pathname === "/api/v1/conversations/39/messages")
    return json(MESSAGES);
  if (url.pathname === "/api/v1/document-approvals") return json(REQUESTS);
  return json({});
}) as unknown as typeof fetch;

afterEach(() => {
  cleanup();
  asked = [];
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function mount(path: string) {
  return render(
    withI18n(
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route
              path="/conversations/:id"
              element={<ConversationDetailPage />}
            />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
}

const text = () => document.body.textContent ?? "";
const linkTo = (label: string) =>
  screen.queryAllByRole("link").find((a) => a.textContent?.trim() === label) as
    | HTMLAnchorElement
    | undefined;

describe("a conversation's approvals on its page", () => {
  test("opened from an approval, it offers the way back in the row of the way back to the list", async () => {
    mount("/conversations/39?from=/document-approvals/39");
    await waitFor(() => expect(!!linkTo("Back to the approval")).toBe(true));
    const back = linkTo("Back to the approval") as HTMLAnchorElement;
    const list = linkTo("Back to conversations") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/document-approvals/39");
    expect(back.parentElement === list?.parentElement).toBe(true);
  });

  test("an origin that is not an approval page offers no way back to one", async () => {
    mount("/conversations/39?from=https://evil.example/document-approvals/39");
    await waitFor(() => expect(!!linkTo("Back to conversations")).toBe(true));
    expect(!!linkTo("Back to the approval")).toBe(false);
  });

  test("the approval's private note renders its link, and the approvals are listed", async () => {
    mount("/conversations/39");
    await waitFor(() => expect(!!linkTo("Ver aprovação")).toBe(true));
    expect(linkTo("Ver aprovação")?.getAttribute("href")).toBe(NOTE_LINK);
    expect(text().includes("[Ver aprovação]")).toBe(false);
    await waitFor(() =>
      expect(
        asked.some((a) =>
          a.startsWith("/api/v1/document-approvals?conversationId=39"),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(text().includes("ORC-0007")).toBe(true));
  });

  test("the marker of an approved document's turn does not claim a send", async () => {
    mount("/conversations/39");
    await waitFor(() =>
      expect(text().includes("Approved document")).toBe(true),
    );
    const marker = screen
      .getAllByText("Approved document")
      .map((el) => el.closest("li, div")?.textContent ?? "")
      .join(" ");
    expect(/sent/i.test(marker)).toBe(false);
  });
});
