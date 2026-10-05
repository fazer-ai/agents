/// <reference lib="dom" />

// The page a Chatwoot conversation links to: one match goes straight to the conversation (through
// `switchTenant` when it lives in another tenant), none says so, several are listed to choose from.

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ToastProvider } from "@/client/components";

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: {
      role: "AGENT",
      tenantId: "1",
      tenants: [
        { id: "1", name: "Clínica", role: "AGENT" },
        { id: "2", name: "Loja", role: "AGENT" },
      ],
    },
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ChatwootConversationLinkPage } = await import(
  "@/client/pages/ChatwootConversationLinkPage"
);

const realFetch = globalThis.fetch;
let answer: { status: number; body: unknown } = { status: 200, body: {} };
let requested = "";

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input instanceof Request ? input.url : input);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function Landed() {
  const loc = useLocation();
  return <p data-testid="landed">{loc.pathname + loc.search}</p>;
}

function open(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/chatwoot/accounts/:accountId/conversations/:conversationId"
            element={<ChatwootConversationLinkPage />}
          />
          <Route path="/conversations/:id" element={<Landed />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const matches = (...m: { id: string; tenantId: string }[]) => ({
  status: 200,
  body: { matches: m },
});

test("one match in the active tenant opens the conversation, and the inbox reaches the query", async () => {
  answer = matches({ id: "55", tenantId: "1" });
  const view = open("/chatwoot/accounts/3/conversations/42?inbox=9");
  await waitFor(() =>
    expect(view.getByTestId("landed").textContent).toBe("/conversations/55"),
  );
  const q = new URL(requested).searchParams;
  expect([
    q.get("accountId"),
    q.get("conversationId"),
    q.get("inboxId"),
  ]).toEqual(["3", "42", "9"]);
});

test("one match in another tenant of the person opens it there", async () => {
  answer = matches({ id: "56", tenantId: "2" });
  const view = open("/chatwoot/accounts/3/conversations/42");
  await waitFor(() =>
    expect(view.getByTestId("landed").textContent).toBe(
      "/conversations/56?switchTenant=2",
    ),
  );
});

test("no match says the conversation is not here, naming what was asked", async () => {
  answer = matches();
  const view = open("/chatwoot/accounts/3/conversations/42");
  await waitFor(() => expect(view.container.textContent).toContain("42"));
  expect(view.queryByTestId("landed")).toBeNull();
  expect(view.container.textContent).toMatch(/não está aqui|not here/i);
});

test("a malformed link reads as one that names nothing, not as an error", async () => {
  answer = { status: 400, body: { error: "bad" } };
  const view = open("/chatwoot/accounts/3/conversations/abc");
  await waitFor(() =>
    expect(view.container.textContent).toMatch(/não está aqui|not here/i),
  );
});

test("several matches are listed, each linking to its own tenant", async () => {
  answer = matches({ id: "55", tenantId: "1" }, { id: "56", tenantId: "2" });
  const view = open("/chatwoot/accounts/3/conversations/42");
  await waitFor(() => expect(view.getAllByRole("link")).toHaveLength(2));
  const hrefs = view.getAllByRole("link").map((a) => a.getAttribute("href"));
  expect(hrefs).toEqual([
    "/conversations/55",
    "/conversations/56?switchTenant=2",
  ]);
  expect(view.container.textContent).toContain("Loja");
});
