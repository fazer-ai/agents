/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";

// A request's approval page (docs/documents.md, Approval): it shows one request at a time, offers to
// finish an approval that never issued its document, and says why the server refused an action.

const { DocumentApprovalPage } = await import(
  "@/client/pages/DocumentApprovalPage"
);
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
URL.createObjectURL = ((blob: Blob) =>
  `blob:${(blob as Blob & { tag?: string }).tag ?? "x"}`) as typeof URL.createObjectURL;
URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

// The server's clock as the responses state it; the browser's is left alone.
let serverOffsetMs = 0;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      date: new Date(Date.now() + serverOffsetMs).toUTCString(),
    },
  });
}

function request(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    templateId: "1",
    title: `Orçamento ${id}`,
    status: "PENDING",
    threadId: "t",
    conversationId: "7",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    reviewerUserId: null,
    note: null,
    decidedAt: null,
    issuedDocumentId: null,
    createdAt: new Date(0).toISOString(),
    ...over,
  };
}

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let handler: Handler = async () => json({});
const posted: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (init?.method === "POST") posted.push(url);
  return handler(url, init);
}) as typeof fetch;

function context() {
  return json({
    conversation: null,
    contact: null,
    messages: [],
    messagesUnavailable: false,
  });
}

function pdf(tag: string) {
  const res = new Response("%PDF-", {
    headers: { "content-type": "application/pdf" },
  });
  const blob = res.blob.bind(res);
  res.blob = async () => Object.assign(await blob(), { tag });
  return res;
}

let goTo: (path: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  goTo = navigate;
  return null;
}

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Navigator />
        <Routes>
          <Route
            path="/document-approvals/:id"
            element={<DocumentApprovalPage />}
          />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  posted.length = 0;
  serverOffsetMs = 0;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

function gate() {
  let open: () => void = () => {};
  const shut = new Promise<void>((r) => {
    open = r;
  });
  return { open, shut };
}

test("moving to another request drops the previous request's preview at once", async () => {
  const next = gate();
  handler = async (url) => {
    if (url.includes("/document-approvals/6/preview")) return pdf("old");
    if (url.includes("/document-approvals/6/context")) return context();
    if (url.includes("/document-approvals/6")) {
      return json({ request: request("6", { status: "EXPIRED" }) });
    }
    if (url.includes("/document-approvals/26")) await next.shut;
    if (url.includes("/document-approvals/26/preview")) return pdf("new");
    if (url.includes("/document-approvals/26/context")) return context();
    if (url.includes("/document-approvals/26")) {
      return json({ request: request("26") });
    }
    return json({});
  };
  mount("/document-approvals/6");
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "blob:old",
    ),
  );
  act(() => goTo("/document-approvals/26"));
  await waitFor(() => expect(screen.queryByText("Orçamento 6")).toBeNull());
  expect(document.querySelector("iframe")).toBeNull();
  next.open();
  await screen.findByText("Orçamento 26");
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "blob:new",
    ),
  );
});

test("a load of the previous request that lands after the next one changes nothing", async () => {
  const old = gate();
  handler = async (url) => {
    if (url.includes("/document-approvals/6")) await old.shut;
    if (url.includes("/preview"))
      return pdf(url.includes("/6/") ? "old" : "new");
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/6")) {
      return json({ request: request("6", { status: "EXPIRED" }) });
    }
    if (url.includes("/document-approvals/26")) {
      return json({ request: request("26") });
    }
    return json({});
  };
  mount("/document-approvals/6");
  act(() => goTo("/document-approvals/26"));
  await screen.findByText("Orçamento 26");
  old.open();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText("Orçamento 6")).toBeNull();
  expect(screen.getByText("Orçamento 26")).toBeTruthy();
  expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
    "blob:new",
  );
});

test("an approval that never issued its document can be approved again", async () => {
  handler = async (url, init) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.endsWith("/approve") && init?.method === "POST") {
      return json({ request: request("9"), document: { number: "ORC-0003" } });
    }
    if (url.includes("/document-approvals/9")) {
      return json({
        request: request("9", { status: "APPROVED", issuedDocumentId: null }),
      });
    }
    return json({});
  };
  mount("/document-approvals/9");
  const again = await screen.findByRole("button", { name: "Approve again" });
  fireEvent.click(again);
  await waitFor(() =>
    expect(
      posted.some((u) => u.endsWith("/document-approvals/9/approve")),
    ).toBe(true),
  );
});

test("a refused action shows the server's own reason", async () => {
  handler = async (url, init) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.endsWith("/request-again") && init?.method === "POST") {
      return json({ error: "O campo validade não aceita esse valor." }, 422);
    }
    if (url.includes("/document-approvals/5")) {
      return json({ request: request("5", { status: "EXPIRED" }) });
    }
    return json({});
  };
  mount("/document-approvals/5");
  fireEvent.click(await screen.findByRole("button", { name: "Request again" }));
  await screen.findByText("O campo validade não aceita esse valor.");
});

test("a request the server still holds open offers the decision, even when this machine's clock is ahead", async () => {
  // The server is two hours behind this browser, and the request has one hour left by its clock.
  serverOffsetMs = -2 * 3_600_000;
  handler = async (url) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/11")) {
      return json({
        request: request("11", {
          expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      });
    }
    return json({});
  };
  mount("/document-approvals/11");
  await screen.findByRole("button", { name: "Approve and send" });
});

test("a pending request whose time runs out moves to request again without a reload", async () => {
  let reads = 0;
  handler = async (url) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/12")) {
      reads += 1;
      return json({
        request:
          reads === 1
            ? request("12", {
                expiresAt: new Date(Date.now() + 100).toISOString(),
              })
            : request("12", { status: "EXPIRED" }),
      });
    }
    return json({});
  };
  mount("/document-approvals/12");
  await screen.findByRole("button", { name: "Approve and send" });
  await screen.findByRole(
    "button",
    { name: "Request again" },
    { timeout: 4000 },
  );
});

test("a context that never answers does not hold back the document and the decision", async () => {
  handler = async (url) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return new Promise<Response>(() => {});
    if (url.includes("/document-approvals/13")) {
      return json({ request: request("13") });
    }
    return json({});
  };
  mount("/document-approvals/13");
  await screen.findByText("Orçamento 13");
  await screen.findByRole("button", { name: "Approve and send" });
});

test("an overdue request read back still pending is read again until the expiry closes it", async () => {
  let reads = 0;
  // One instant for every read, as the server returns the same row until the expiry runs.
  const overdue = new Date(Date.now() - 1000).toISOString();
  handler = async (url) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/14")) {
      reads += 1;
      // The first two reads still find it pending past its time; the third finds it closed.
      return json({
        request:
          reads < 3
            ? request("14", { expiresAt: overdue })
            : request("14", { status: "EXPIRED" }),
      });
    }
    return json({});
  };
  mount("/document-approvals/14");
  await screen.findByRole(
    "button",
    { name: "Request again" },
    { timeout: 9000 },
  );
  expect(reads).toBe(3);
}, 12_000);

test("an approval whose answer cannot be read says so and reads the request again", async () => {
  let reads = 0;
  handler = async (url, init) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.endsWith("/approve") && init?.method === "POST") {
      return new Response("{", {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/document-approvals/15")) {
      reads += 1;
      return json({ request: request("15") });
    }
    return json({});
  };
  mount("/document-approvals/15");
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve and send" }),
  );
  await screen.findByText("Could not approve.");
  await waitFor(() => expect(reads).toBe(2));
});

test("a request again that answers after the reviewer moved on leaves them where they went", async () => {
  const answer = gate();
  handler = async (url, init) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.endsWith("/request-again") && init?.method === "POST") {
      await answer.shut;
      return json({ request: request("30") });
    }
    if (url.includes("/document-approvals/30")) {
      return json({ request: request("30") });
    }
    if (url.includes("/document-approvals/26")) {
      return json({ request: request("26") });
    }
    if (url.includes("/document-approvals/16")) {
      return json({ request: request("16", { status: "EXPIRED" }) });
    }
    return json({});
  };
  mount("/document-approvals/16");
  fireEvent.click(await screen.findByRole("button", { name: "Request again" }));
  act(() => goTo("/document-approvals/26"));
  await screen.findByText("Orçamento 26");
  answer.open();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByText("Orçamento 26")).toBeTruthy();
  expect(screen.queryByText("Orçamento 30")).toBeNull();
});

test("a page load renders the request's preview once", async () => {
  let previews = 0;
  handler = async (url) => {
    if (url.includes("/preview")) {
      previews += 1;
      return pdf("p");
    }
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/17")) {
      return json({ request: request("17") });
    }
    return json({});
  };
  mount("/document-approvals/17");
  await screen.findByRole("button", { name: "Approve and send" });
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "blob:p",
    ),
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(previews).toBe(1);
});

test("a message that is only a voice note shows its transcription, and a bare file says what it was", async () => {
  handler = async (url) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) {
      return json({
        conversation: null,
        contact: { name: "Ana", phone: null, email: null },
        messages: [
          {
            id: 1,
            content: null,
            fromCustomer: true,
            senderName: null,
            createdAt: null,
            attachments: [
              { fileType: "audio", transcribedText: "três salas, por favor" },
            ],
          },
          {
            id: 2,
            content: null,
            fromCustomer: true,
            senderName: null,
            createdAt: null,
            attachments: [{ fileType: "image", transcribedText: null }],
          },
        ],
        messagesUnavailable: false,
      });
    }
    if (url.includes("/document-approvals/18")) {
      return json({ request: request("18") });
    }
    return json({});
  };
  mount("/document-approvals/18");
  await screen.findByText("Transcription: três salas, por favor");
  expect(screen.getByText("Image")).toBeTruthy();
});

test("a decided request shows who decided, what it came to, and the issued document instead of the draft", async () => {
  let drafts = 0;
  handler = async (url) => {
    if (url.includes("/preview")) {
      drafts += 1;
      return pdf("draft");
    }
    if (url.includes("/documents/5/pdf")) return pdf("issued");
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/18")) {
      return json({
        request: request("18", {
          status: "APPROVED",
          reviewerName: "Ana Souza",
          decidedAt: new Date().toISOString(),
          issuedDocumentId: "5",
          outcome: "DELIVERED",
          outcomeAt: new Date().toISOString(),
        }),
      });
    }
    return json({});
  };
  mount("/document-approvals/18");
  await screen.findByText(/Decided by Ana Souza/);
  await screen.findByText(/Sent to the customer/);
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "blob:issued",
    ),
  );
  expect(drafts).toBe(0);
  expect(
    screen
      .getByRole("link", { name: "Back to approvals" })
      .getAttribute("href"),
  ).toBe("/approvals?tab=history");
});

test("an approval whose outcome has not landed yet is read again until it does", async () => {
  let reads = 0;
  handler = async (url) => {
    if (url.includes("/pdf") || url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/19")) {
      reads += 1;
      return json({
        request: request("19", {
          status: "APPROVED",
          decidedAt: new Date().toISOString(),
          issuedDocumentId: "6",
          outcome: reads > 1 ? "DELIVERED" : null,
          outcomeAt: reads > 1 ? new Date().toISOString() : null,
        }),
      });
    }
    return json({});
  };
  mount("/document-approvals/19");
  await screen.findByText(/The agent sends the document/);
  await screen.findByText(/Sent to the customer/, {}, { timeout: 6000 });
}, 10_000);

test("a rejected request says what the rejection came to in the conversation", async () => {
  handler = async (url) => {
    if (url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/20")) {
      return json({
        request: request("20", {
          status: "REJECTED",
          reviewerName: "Ana Souza",
          note: "valor errado",
          decidedAt: new Date().toISOString(),
          outcome: "HANDED",
          outcomeAt: new Date().toISOString(),
        }),
      });
    }
    return json({});
  };
  mount("/document-approvals/20");
  await screen.findByText(/Rejected with the note: valor errado/);
  await screen.findByText("Conversation handed to a person");
});

test("an approval that could not be sent points to the numbered document to send by hand, and an expiry says when it expired", async () => {
  handler = async (url) => {
    if (url.includes("/pdf") || url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/21")) {
      return json({
        request: request("21", {
          status: "APPROVED",
          reviewerName: "Ana Souza",
          decidedAt: new Date().toISOString(),
          issuedDocumentId: "8",
          outcome: "NOTED",
          outcomeAt: new Date().toISOString(),
        }),
      });
    }
    if (url.includes("/document-approvals/22")) {
      return json({
        request: request("22", {
          status: "EXPIRED",
          expiresAt: new Date(0).toISOString(),
          decidedAt: new Date().toISOString(),
        }),
      });
    }
    return json({});
  };
  mount("/document-approvals/21");
  await screen.findByText(/to send from Chatwoot/);
  cleanup();
  mount("/document-approvals/22");
  await screen.findByText(/^Expired /);
  expect(screen.queryByText(/^Decided /)).toBeNull();
});

test("approving drops the draft at once and shows the issued document when it arrives", async () => {
  let approved = false;
  const issued = gate();
  handler = async (url, init) => {
    if (url.includes("/preview")) return pdf("draft");
    if (url.includes("/documents/9/pdf")) {
      await issued.shut;
      return pdf("issued");
    }
    if (url.includes("/context")) return context();
    if (
      url.endsWith("/document-approvals/23/approve") &&
      init?.method === "POST"
    ) {
      approved = true;
      return json({ request: {}, document: { number: "ORC-9" } });
    }
    if (url.includes("/document-approvals/23")) {
      return json({
        request: request(
          "23",
          approved
            ? {
                status: "APPROVED",
                decidedAt: new Date().toISOString(),
                issuedDocumentId: "9",
                outcome: "DELIVERED",
                outcomeAt: new Date().toISOString(),
              }
            : {},
        ),
      });
    }
    return json({});
  };
  mount("/document-approvals/23");
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "blob:draft",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
  await screen.findByText(/Sent to the customer/);
  expect(
    document.querySelector("iframe")?.getAttribute("src") ?? null,
  ).not.toBe("blob:draft");
  issued.open();
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "blob:issued",
    ),
  );
});

test("an untouched page stops saying the document is on its way when that runs out", async () => {
  handler = async (url) => {
    if (url.includes("/pdf") || url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (url.includes("/document-approvals/24")) {
      return json({
        request: request("24", {
          status: "APPROVED",
          // Ten minutes after the decision, less a second and a half.
          decidedAt: new Date(Date.now() - 10 * 60_000 + 1500).toISOString(),
          issuedDocumentId: "10",
          outcome: null,
        }),
      });
    }
    return json({});
  };
  mount("/document-approvals/24");
  await screen.findByText("On its way to the customer");
  await screen.findByText(
    "No confirmation that it was sent",
    {},
    { timeout: 5000 },
  );
}, 10_000);

test("approving again an old approval whose document was never issued reads its new outcome", async () => {
  let completed = false;
  let reads = 0;
  handler = async (url, init) => {
    if (url.includes("/pdf") || url.includes("/preview")) return pdf("p");
    if (url.includes("/context")) return context();
    if (
      url.endsWith("/document-approvals/25/approve") &&
      init?.method === "POST"
    ) {
      completed = true;
      return json({ request: {}, document: { number: "ORC-11" } });
    }
    if (url.includes("/document-approvals/25")) {
      if (completed) reads += 1;
      return json({
        request: request("25", {
          status: "APPROVED",
          // The first decision, long before this page.
          decidedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
          issuedDocumentId: completed ? "11" : null,
          outcome: completed && reads > 1 ? "DELIVERED" : null,
          outcomeAt: completed && reads > 1 ? new Date().toISOString() : null,
        }),
      });
    }
    return json({});
  };
  mount("/document-approvals/25");
  fireEvent.click(await screen.findByRole("button", { name: "Approve again" }));
  await screen.findByText(/Sent to the customer/, {}, { timeout: 6000 });
}, 10_000);
