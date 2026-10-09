/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The approvals a conversation's page shows (docs/documents.md, Approval): every request still waiting
// on the team, or else the latest one with its decision and what it came to.

const { ConversationApprovals, shownApprovals } = await import(
  "@/client/pages/approvals/ConversationApprovals"
);

const realFetch = globalThis.fetch;
const asked: string[] = [];
let rows: unknown[] = [];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  asked.push(url);
  return new Response(JSON.stringify({ requests: rows }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

afterEach(() => {
  cleanup();
  asked.length = 0;
  rows = [];
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `Orçamento ${id}`,
    status: "PENDING",
    reviewerName: null,
    decidedAt: null,
    outcome: null,
    ...over,
  };
}

test("waiting requests win over the latest decided one", () => {
  const decided = row("3", { status: "APPROVED" });
  const waiting = row("2");
  expect(shownApprovals([decided, waiting] as never).map((r) => r.id)).toEqual([
    "2",
  ]);
  expect(
    shownApprovals([decided, row("1", { status: "REJECTED" })] as never).map(
      (r) => r.id,
    ),
  ).toEqual(["3"]);
  expect(shownApprovals([])).toEqual([]);
});

test("a decided request says who decided and what it came to, with the way to its page", async () => {
  rows = [
    row("9", {
      status: "APPROVED",
      reviewerName: "Ana Souza",
      decidedAt: new Date(0).toISOString(),
      outcome: "DELIVERED",
    }),
  ];
  render(
    <MemoryRouter>
      <ConversationApprovals conversationId="29" refreshKey={0} />
    </MemoryRouter>,
  );
  await screen.findByText("Approved by Ana Souza");
  screen.getByText("Sent to the customer");
  expect(
    screen.getByRole("link", { name: "View approval" }).getAttribute("href"),
  ).toBe("/document-approvals/9");
  expect(asked[0]).toContain("conversationId=29");
});

test("a waiting request offers the review", async () => {
  rows = [row("4")];
  render(
    <MemoryRouter>
      <ConversationApprovals conversationId="29" refreshKey={0} />
    </MemoryRouter>,
  );
  await screen.findByText("Waiting for approval");
  expect(
    screen.getByRole("link", { name: "Review" }).getAttribute("href"),
  ).toBe("/document-approvals/4");
});

test("a conversation with no request shows nothing", async () => {
  const { container } = render(
    <MemoryRouter>
      <ConversationApprovals conversationId="29" refreshKey={0} />
    </MemoryRouter>,
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(container.textContent).toBe("");
});
