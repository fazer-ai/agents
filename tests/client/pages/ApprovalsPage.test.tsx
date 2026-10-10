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
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";

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
let knowledgeNone = false;
// Decided rows the history answers before the default one, set per test.
let extraDecided: unknown[] | (() => unknown[]) = [];
// The history answers only the rows a test sets, without the default one, when true.
let decidedOnlyExtra = false;
// The history's next cursor, set per test.
let decidedCursor: string | null = null;
// One request read by id, set per test.
let requestById: Record<string, unknown> = {};

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
  const single = url.match(/\/document-approvals\/(\d+)$/);
  if (single?.[1] && requestById[single[1]]) {
    return json({ request: requestById[single[1]] });
  }
  if (url.includes("/document-approvals/decided")) {
    const extra =
      typeof extraDecided === "function" ? extraDecided() : extraDecided;
    if (decidedOnlyExtra) {
      return json({ requests: extra, nextCursor: decidedCursor });
    }
    return json({
      requests: [
        ...extra,
        {
          ...DOCUMENT,
          id: "40",
          status: "APPROVED",
          decidedAt: new Date(0).toISOString(),
          reviewerName: "Bruno Lima",
          outcome: "DELIVERED",
          issuedDocumentId: "5",
          issuedNumber: "ORC-0005",
        },
      ],
      nextCursor: decidedCursor,
    });
  }
  if (url.includes("/document-approvals/pending")) {
    const answer = await pending(url);
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
    return json({ approvals: knowledgeNone ? [] : [SUGGESTION] });
  }
  return json({});
}) as typeof fetch;

afterEach(() => {
  cleanup();
  asked.length = 0;
  pending = onePage;
  knowledgeFails = false;
  knowledgeNone = false;
  decided = false;
  extraDecided = [];
  requestById = {};
  decidedCursor = null;
  decidedOnlyExtra = false;
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

let goTo: (path: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  goTo = navigate;
  return null;
}

test("a badge count read later from another snapshot never calls a shown knowledge queue empty", async () => {
  role = "TENANT_ADMIN";
  mount(
    <>
      <Navigator />
      <ApprovalsPage />
    </>,
  );
  await screen.findByText("Refund window");
  // The suggestion is decided elsewhere: the badge's own read, on the next navigation, finds none,
  // while the queue on this page still shows the card it loaded.
  knowledgeNone = true;
  const before = asked.length;
  goTo("/elsewhere");
  await waitFor(() =>
    expect(
      asked
        .slice(before)
        .some(
          (u) => u.includes("/knowledge/approvals") && !u.includes("discarded"),
        ),
    ).toBe(true),
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByText("Refund window")).toBeTruthy();
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

test("an older count that lands after a newer refresh does not bring the old number back", async () => {
  role = "AGENT";
  let open: () => void = () => {};
  const slow = new Promise<void>((r) => {
    open = r;
  });
  let calls = 0;
  pending = () => {
    calls += 1;
    // The first read (the mount's) is held; the second (the refresh) answers at once.
    if (calls === 1) {
      return slow.then(() => json({ requests: [], total: 5, nextAfter: null }));
    }
    return { requests: [DOCUMENT], total: 1, nextAfter: null };
  };
  function Refresher() {
    const { refresh } = usePendingApprovals();
    return (
      <button type="button" onClick={refresh}>
        again
      </button>
    );
  }
  mount(
    <>
      <Badge />
      <Refresher />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "again" }));
  await waitFor(() =>
    expect(screen.getByTestId("badge").textContent).toBe("1"),
  );
  open();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByTestId("badge").textContent).toBe("1");
});

test("the history tab lists the decided documents with who decided and what they came to", async () => {
  role = "AGENT";
  mount(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  const link = await screen.findByRole("link", {
    name: /Orçamento ORC-0005 for Ana Ribeiro/,
  });
  expect(link.getAttribute("href")).toBe("/document-approvals/40");
  expect(link.textContent).toContain("by Bruno Lima");
  expect(link.textContent).toContain("Sent to the customer");
  expect(screen.queryByText("Knowledge suggestions")).toBeNull();
});

test("an untouched history stops saying a document is on its way when that runs out", async () => {
  role = "AGENT";
  extraDecided = [
    {
      ...DOCUMENT,
      id: "44",
      contactName: "Caio Prado",
      status: "APPROVED",
      // Ten minutes after the decision, less a second and a half.
      decidedAt: new Date(Date.now() - 10 * 60_000 + 1500).toISOString(),
      reviewerName: null,
      outcome: null,
      issuedDocumentId: "3",
    },
  ];
  mount(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  const link = await screen.findByRole("link", { name: /for Caio Prado/ });
  expect(link.textContent).toContain("On its way to the customer");
  await waitFor(
    () =>
      expect(link.textContent).toContain("No confirmation that it was sent"),
    { timeout: 5000 },
  );
}, 10_000);

test("the history reads again a decision whose outcome has not landed, until it does", async () => {
  role = "AGENT";
  let reads = 0;
  extraDecided = () => {
    reads += 1;
    return [
      {
        ...DOCUMENT,
        id: "45",
        contactName: "Rita Gomes",
        status: "APPROVED",
        decidedAt: new Date().toISOString(),
        reviewerName: null,
        outcome: reads > 1 ? "DELIVERED" : null,
        issuedDocumentId: "4",
      },
    ];
  };
  mount(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  const link = await screen.findByRole("link", { name: /for Rita Gomes/ });
  expect(link.textContent).toContain("On its way to the customer");
  await waitFor(
    () =>
      expect(
        screen.getByRole("link", { name: /for Rita Gomes/ }).textContent,
      ).toContain("Sent to the customer"),
    { timeout: 8000 },
  );
}, 12_000);

test("an approval still issuing its document is read again, not called not issued", async () => {
  role = "AGENT";
  let reads = 0;
  extraDecided = () => {
    reads += 1;
    return [
      {
        ...DOCUMENT,
        id: "46",
        contactName: "Tiago Reis",
        status: "APPROVED",
        decidedAt: new Date().toISOString(),
        reviewerName: null,
        // Committed APPROVED, document not linked yet on the first read.
        outcome: reads > 1 ? "DELIVERED" : null,
        issuedDocumentId: reads > 1 ? "7" : null,
      },
    ];
  };
  mount(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  const link = await screen.findByRole("link", { name: /for Tiago Reis/ });
  expect(link.textContent).toContain("On its way to the customer");
  await waitFor(
    () =>
      expect(
        screen.getByRole("link", { name: /for Tiago Reis/ }).textContent,
      ).toContain("Sent to the customer"),
    { timeout: 8000 },
  );
}, 12_000);

test("a decision taken while the history waits joins it, whatever order its request was asked in", async () => {
  role = "AGENT";
  let reads = 0;
  const landing = {
    ...DOCUMENT,
    id: "50",
    contactName: "Rita Gomes",
    status: "APPROVED",
    decidedAt: new Date().toISOString(),
    reviewerName: null,
    outcome: null,
    issuedDocumentId: "4",
  };
  extraDecided = () => {
    reads += 1;
    if (reads === 1) return [landing];
    // An older request (a lower id) decided meanwhile, and the outcome landed.
    return [
      {
        ...DOCUMENT,
        id: "30",
        contactName: "Caio Prado",
        status: "REJECTED",
        decidedAt: new Date().toISOString(),
        reviewerName: null,
        outcome: "HANDED",
        issuedDocumentId: null,
      },
      { ...landing, outcome: "DELIVERED" },
    ];
  };
  mount(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  await screen.findByRole("link", { name: /for Rita Gomes/ });
  await screen.findByRole(
    "link",
    { name: /for Caio Prado/ },
    { timeout: 8000 },
  );
  expect(
    screen.getByRole("link", { name: /for Rita Gomes/ }).textContent,
  ).toContain("Sent to the customer");
}, 12_000);

test("an outcome still landing on a row the first page no longer carries is read by id", async () => {
  role = "AGENT";
  let reads = 0;
  const landing = {
    ...DOCUMENT,
    id: "52",
    contactName: "Rita Gomes",
    status: "APPROVED",
    decidedAt: new Date().toISOString(),
    reviewerName: null,
    outcome: null,
    issuedDocumentId: "4",
  };
  extraDecided = () => {
    reads += 1;
    // Pushed off the first page after the first read.
    return reads === 1 ? [landing] : [];
  };
  requestById = { "52": { ...landing, outcome: "DELIVERED" } };
  mount(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  await screen.findByRole("link", { name: /for Rita Gomes/ });
  await waitFor(
    () =>
      expect(
        screen.getByRole("link", { name: /for Rita Gomes/ }).textContent,
      ).toContain("Sent to the customer"),
    { timeout: 8000 },
  );
}, 12_000);

test("returning to the waiting tab reads the queue again", async () => {
  role = "AGENT";
  mount(<ApprovalsPage />);
  await screen.findByRole("link", { name: /Orçamento for Ana Ribeiro/ });
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  pending = () => ({ requests: [], total: 0, nextAfter: null });
  fireEvent.click(screen.getByRole("tab", { name: /Waiting/ }));
  await screen.findByText("No document is waiting for approval.");
});

test("a history refresh with nothing in common with what is shown starts over with its own cursor", async () => {
  role = "AGENT";
  decidedOnlyExtra = true;
  let reads = 0;
  extraDecided = () => {
    reads += 1;
    if (reads === 1) {
      return [
        {
          ...DOCUMENT,
          id: "60",
          contactName: "Rita Gomes",
          status: "APPROVED",
          decidedAt: new Date().toISOString(),
          reviewerName: null,
          outcome: null,
          issuedDocumentId: "4",
        },
      ];
    }
    decidedCursor = "70";
    return [
      {
        ...DOCUMENT,
        id: "71",
        contactName: "Caio Prado",
        status: "REJECTED",
        decidedAt: new Date().toISOString(),
        reviewerName: null,
        outcome: "HANDED",
        issuedDocumentId: null,
      },
    ];
  };
  mount(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  await screen.findByRole("link", { name: /for Rita Gomes/ });
  await screen.findByRole(
    "link",
    { name: /for Caio Prado/ },
    { timeout: 8000 },
  );
  // The rows from before the gap are gone, and the next page continues from the fresh cursor.
  expect(screen.queryByRole("link", { name: /for Rita Gomes/ })).toBeNull();
  await screen.findByRole("button", { name: "Show more" });
}, 12_000);

test("a next page asked before the queue was read again is dropped, not appended", async () => {
  role = "AGENT";
  const SECOND = { ...DOCUMENT, id: "42", contactName: "Bruno Lima" };
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  pending = async (url) => {
    if (url.includes("after=41")) {
      await held;
      return { requests: [SECOND], total: 2, nextAfter: null };
    }
    return { requests: [DOCUMENT], total: 2, nextAfter: "41" };
  };
  mount(<ApprovalsPage />);
  await screen.findByRole("link", { name: /Orçamento for Ana Ribeiro/ });
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  fireEvent.click(screen.getByRole("tab", { name: /Waiting/ }));
  await screen.findByRole("link", { name: /Orçamento for Ana Ribeiro/ });
  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(
    screen.queryByRole("link", { name: /Orçamento for Bruno Lima/ }),
  ).toBeNull();
});

test("a next page cannot be asked while the queue is read again", async () => {
  role = "AGENT";
  const SECOND = { ...DOCUMENT, id: "42", contactName: "Bruno Lima" };
  // Set once the history is open: from then on, every first-page read (the queue's and the badge's)
  // waits until released.
  let holding = false;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const asked: string[] = [];
  pending = async (url) => {
    asked.push(url);
    if (url.includes("after=41")) {
      return { requests: [SECOND], total: 2, nextAfter: null };
    }
    if (holding) await held;
    return { requests: [DOCUMENT], total: 2, nextAfter: "41" };
  };
  mount(<ApprovalsPage />);
  await screen.findByRole("link", { name: /Orçamento for Ana Ribeiro/ });
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  holding = true;
  fireEvent.click(screen.getByRole("tab", { name: /Waiting/ }));
  const more = await screen.findByRole("button", { name: "Show more" });
  await waitFor(() => expect((more as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(more);
  await new Promise((r) => setTimeout(r, 50));
  expect(asked.some((u) => u.includes("after=41"))).toBe(false);
  release();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Show more" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

test("an older first-page read answering last does not bring back what a newer one cleared", async () => {
  role = "AGENT";
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let reads = 0;
  pending = async () => {
    reads += 1;
    if (reads === 1) {
      await held;
      return { requests: [DOCUMENT], total: 1, nextAfter: null };
    }
    return { requests: [], total: 0, nextAfter: null };
  };
  mount(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  fireEvent.click(screen.getByRole("tab", { name: /Waiting/ }));
  await screen.findByText("No document is waiting for approval.");
  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(
    screen.queryByRole("link", { name: /Orçamento for Ana Ribeiro/ }),
  ).toBeNull();
});

test("a history page asked before the rows started over is dropped", async () => {
  role = "AGENT";
  decidedOnlyExtra = true;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const decided = (id: string, name: string, outcome: string | null) => ({
    ...DOCUMENT,
    id,
    contactName: name,
    status: "APPROVED",
    decidedAt: new Date().toISOString(),
    reviewerName: null,
    outcome,
    issuedDocumentId: "4",
  });
  let firstPages = 0;
  extraDecided = () => {
    firstPages += 1;
    if (firstPages === 1) {
      decidedCursor = "60";
      return [decided("60", "Rita Gomes", null)];
    }
    decidedCursor = "71";
    return [decided("71", "Caio Prado", "DELIVERED")];
  };
  const realFetchHere = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (
      url.includes("/document-approvals/decided") &&
      url.includes("cursor=60")
    ) {
      await held;
      return json({
        requests: [decided("58", "Old Page", "DELIVERED")],
        nextCursor: null,
      });
    }
    return realFetchHere(input, init);
  }) as typeof fetch;
  try {
    mount(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "History" }));
    await screen.findByRole("link", { name: /for Rita Gomes/ });
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByRole(
      "link",
      { name: /for Caio Prado/ },
      { timeout: 8000 },
    );
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("link", { name: /for Old Page/ })).toBeNull();
  } finally {
    globalThis.fetch = realFetchHere;
  }
}, 12_000);
