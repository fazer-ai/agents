/// <reference lib="dom" />

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";

// The one approvals queue: a document waiting on the team is listed for every role and counted in
// the sidebar badge, and the knowledge suggestions join both only for an admin, who alone reviews
// them. A document opens the same page as the alert's link.

let role = "AGENT";
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { role } }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ApprovalsProvider, usePendingApprovals } = await import(
  "@/client/contexts/ApprovalsContext"
);
const { ApprovalsPage } = await import("@/client/pages/ApprovalsPage");
const { DocumentApprovalPage } = await import(
  "@/client/pages/DocumentApprovalPage"
);
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
const asked: string[] = [];

const DOCUMENT = {
  id: "41",
  title: "Orçamento",
  createdAt: new Date(0).toISOString(),
  expiresAt: new Date(86_400_000).toISOString(),
  conversationId: "7",
  chatwootConversationId: 12,
  contactName: "Ana Ribeiro",
};
// What the queue answers, set per test.
const onePage = () => ({ requests: [DOCUMENT], total: 1, nextAfter: null });
let pending: (url: string) => unknown = onePage;
let knowledgeFails = false;

const SUGGESTION = {
  id: "a1",
  status: "PENDING",
  proposedTitle: "Refund window",
  proposedContent: "Refunds within 30 days.",
  createdAt: new Date(0).toISOString(),
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// A request's own page, for the decision that has to clear the badge.
let decided = false;
URL.createObjectURL = (() => "blob:p") as typeof URL.createObjectURL;
URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  asked.push(url);
  if (url.includes("/document-approvals/pending")) {
    const answer = pending(url);
    return answer instanceof Response ? answer : json(answer);
  }
  if (
    url.endsWith("/document-approvals/41/approve") &&
    init?.method === "POST"
  ) {
    decided = true;
    return json({ request: {}, document: { number: "ORC-0009" } });
  }
  if (url.includes("/document-approvals/41/preview")) {
    return new Response("%PDF-", {
      headers: { "content-type": "application/pdf" },
    });
  }
  if (url.includes("/document-approvals/41/context")) {
    return json({
      conversation: null,
      contact: null,
      messages: [],
      messagesUnavailable: false,
    });
  }
  if (url.includes("/document-approvals/41")) {
    return json({
      request: {
        ...DOCUMENT,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        templateId: "1",
        status: decided ? "APPROVED" : "PENDING",
        threadId: "t",
        reviewerUserId: null,
        note: null,
        decidedAt: null,
        issuedDocumentId: decided ? "5" : null,
      },
    });
  }
  if (knowledgeFails && url.includes("/knowledge/approvals")) {
    return new Response("{}", { status: 500 });
  }
  if (url.includes("/knowledge/approvals/discarded")) {
    return json({ approvals: [] });
  }
  if (url.includes("/knowledge/approvals")) {
    return json({ approvals: [SUGGESTION] });
  }
  return json({});
}) as typeof fetch;

afterEach(() => {
  cleanup();
  asked.length = 0;
  pending = onePage;
  knowledgeFails = false;
  decided = false;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function Badge() {
  const { count } = usePendingApprovals();
  return <output data-testid="badge">{String(count)}</output>;
}

function mount(children: ReactNode) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ApprovalsProvider>{children}</ApprovalsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

test("an agent's badge counts the documents waiting, and never asks for knowledge suggestions", async () => {
  role = "AGENT";
  mount(<Badge />);
  await waitFor(() =>
    expect(screen.getByTestId("badge").textContent).toBe("1"),
  );
  expect(asked.some((u) => u.includes("/knowledge/approvals"))).toBe(false);
});

test("an admin's badge counts both kinds", async () => {
  role = "TENANT_ADMIN";
  mount(<Badge />);
  await waitFor(() =>
    expect(screen.getByTestId("badge").textContent).toBe("2"),
  );
});

test("the queue lists a waiting document with a link to its approval page", async () => {
  role = "AGENT";
  mount(<ApprovalsPage />);
  const link = await screen.findByRole("link", {
    name: /Orçamento for Ana Ribeiro/,
  });
  expect(link.getAttribute("href")).toBe("/document-approvals/41");
  expect(screen.queryByText("Knowledge suggestions")).toBeNull();
});

test("an admin's queue carries the knowledge suggestions beside the documents", async () => {
  role = "TENANT_ADMIN";
  mount(<ApprovalsPage />);
  await screen.findByRole("link", { name: /Orçamento for Ana Ribeiro/ });
  expect(screen.getByText("Knowledge suggestions")).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByText("Refund window")).not.toBeNull(),
  );
});

test("the badge counts every request waiting, not only the page the queue shows", async () => {
  role = "AGENT";
  pending = () => ({ requests: [DOCUMENT], total: 230, nextAfter: "41" });
  mount(<Badge />);
  await waitFor(() =>
    expect(screen.getByTestId("badge").textContent).toBe("230"),
  );
});

test("the queue reaches the requests past its first page", async () => {
  role = "AGENT";
  const SECOND = { ...DOCUMENT, id: "42", contactName: "Bruno Lima" };
  pending = (url) =>
    url.includes("after=41")
      ? { requests: [SECOND], total: 2, nextAfter: null }
      : { requests: [DOCUMENT], total: 2, nextAfter: "41" };
  mount(<ApprovalsPage />);
  await screen.findByRole("link", { name: /Orçamento for Ana Ribeiro/ });
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  await screen.findByRole("link", { name: /Orçamento for Bruno Lima/ });
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

test("a knowledge queue that failed to load is never called empty", async () => {
  role = "TENANT_ADMIN";
  knowledgeFails = true;
  mount(<ApprovalsPage />);
  await screen.findByRole("link", { name: /Orçamento for Ana Ribeiro/ });
  await new Promise((r) => setTimeout(r, 50));
  expect(
    screen.queryByText("No knowledge suggestion is waiting for review."),
  ).toBeNull();
});

test("a decision on a request's page clears it from the badge without another navigation", async () => {
  role = "AGENT";
  pending = () =>
    decided
      ? { requests: [], total: 0, nextAfter: null }
      : { requests: [DOCUMENT], total: 1, nextAfter: null };
  render(
    <MemoryRouter initialEntries={["/document-approvals/41"]}>
      <ToastProvider>
        <ApprovalsProvider>
          <Badge />
          <Routes>
            <Route
              path="/document-approvals/:id"
              element={<DocumentApprovalPage />}
            />
          </Routes>
        </ApprovalsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("badge").textContent).toBe("1"),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve and send" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("badge").textContent).toBe("0"),
  );
});

test("a next page that fails says so and keeps what was loaded", async () => {
  role = "AGENT";
  pending = (url) =>
    url.includes("after=41")
      ? new Response(JSON.stringify({ error: "Fila indisponível agora." }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      : { requests: [DOCUMENT], total: 2, nextAfter: "41" };
  mount(<ApprovalsPage />);
  await screen.findByRole("link", { name: /Orçamento for Ana Ribeiro/ });
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  await screen.findByText("Fila indisponível agora.");
  expect(
    screen.getByRole("link", { name: /Orçamento for Ana Ribeiro/ }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
});
