/// <reference lib="dom" />

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

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

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  asked.push(url);
  if (url.includes("/document-approvals/pending")) {
    return json({ requests: [DOCUMENT] });
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
