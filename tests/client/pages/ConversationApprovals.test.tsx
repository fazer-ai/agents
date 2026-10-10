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
// Set per test: how long a read takes, and a rewrite of the rows at each read.
let readDelayMs = 0;
let onRead: ((url: string) => void) | null = null;

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  asked.push(url);
  onRead?.(url);
  if (readDelayMs > 0) await new Promise((r) => setTimeout(r, readDelayMs));
  // As the server answers: the pending ones on their own, else the latest.
  const answer = url.includes("waiting=true")
    ? rows.filter((r) => {
        const { status, expiresAt } = r as {
          status: string;
          expiresAt?: string;
        };
        return (
          status === "PENDING" &&
          !(expiresAt && new Date(expiresAt).getTime() <= Date.now())
        );
      })
    : rows.slice(0, 1);
  return new Response(JSON.stringify({ requests: answer }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

afterEach(() => {
  cleanup();
  asked.length = 0;
  rows = [];
  readDelayMs = 0;
  onRead = null;
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
      issuedNumber: "ORC-0009",
    }),
  ];
  render(
    <MemoryRouter>
      <ConversationApprovals conversationId="29" refreshKey={0} />
    </MemoryRouter>,
  );
  await screen.findByText("Approved by Ana Souza");
  screen.getByText(/ ORC-0009$/);
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

test("a waiting request older than many decided ones still shows", async () => {
  rows = [
    ...Array.from({ length: 12 }, (_, i) =>
      row(String(100 - i), { status: "REJECTED" }),
    ),
    row("3"),
  ];
  render(
    <MemoryRouter>
      <ConversationApprovals conversationId="29" refreshKey={0} />
    </MemoryRouter>,
  );
  await screen.findByText("Waiting for approval");
  expect(
    screen.getByRole("link", { name: "Review" }).getAttribute("href"),
  ).toBe("/document-approvals/3");
  expect(screen.queryByText("Rejected")).toBeNull();
});

test("a decision whose reads are slow still lands its outcome", async () => {
  rows = [
    row("7", {
      status: "APPROVED",
      decidedAt: new Date().toISOString(),
      issuedDocumentId: "2",
    }),
  ];
  let reads = 0;
  onRead = (url) => {
    // One read is the pending query and then the latest; count the latest.
    if (url.includes("waiting=true")) return;
    reads += 1;
    // Slower than the poll from the second read on, and answered by then.
    if (reads >= 2) {
      readDelayMs = 3500;
      rows = [{ ...(rows[0] as object), outcome: "DELIVERED" }];
    }
  };
  render(
    <MemoryRouter>
      <ConversationApprovals conversationId="29" refreshKey={0} />
    </MemoryRouter>,
  );
  await screen.findByText("On its way to the customer");
  await screen.findByText("Sent to the customer", {}, { timeout: 12_000 });
}, 15_000);

test("a waiting request decided without a new message still moves on", async () => {
  rows = [row("8")];
  render(
    <MemoryRouter>
      <ConversationApprovals conversationId="29" refreshKey={0} />
    </MemoryRouter>,
  );
  await screen.findByText("Waiting for approval");
  rows = [
    row("8", {
      status: "REJECTED",
      reviewerName: "Ana Souza",
      decidedAt: new Date().toISOString(),
      outcome: "NO_AGENT",
    }),
  ];
  await screen.findByText("Rejected by Ana Souza", {}, { timeout: 18_000 });
}, 22_000);

test("a request past its validity that the expiry has not closed reads as expired, not as a review", async () => {
  rows = [row("6", { expiresAt: new Date(Date.now() - 60_000).toISOString() })];
  render(
    <MemoryRouter>
      <ConversationApprovals conversationId="29" refreshKey={0} />
    </MemoryRouter>,
  );
  await screen.findByText("Expired");
  expect(screen.queryByRole("link", { name: "Review" })).toBeNull();
  screen.getByRole("link", { name: "View approval" });
});
