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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
