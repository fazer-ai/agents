/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The drafts modal is where the human-in-the-loop rail lives: opening a lead
// must list its drafts with statuses, and generating a DM opener must POST to
// the lead's drafts endpoint - otherwise the operator thinks copy exists when
// nothing was drafted.

const realFetch = globalThis.fetch;
const requests: Array<{ method: string; path: string; body?: string }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const DRAFT = {
  id: "50",
  leadId: "11",
  kind: "DM_OPENER",
  body: "Chào chị Thảo, em có Serum BHA 289k ạ",
  status: "DRAFT",
  error: null,
  sentAt: null,
  createdBy: "1",
  createdAt: "2026-10-02T08:00:00.000Z",
  updatedAt: "2026-10-02T08:00:00.000Z",
};

function installFetchStub() {
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, path: url.pathname, body });
    if (method === "GET" && url.pathname === "/api/v1/merchant/leads/11/drafts") {
      return json({
        instance: { instanceId: "test", name: "agents", version: "0.0.0" },
        drafts: [DRAFT],
      });
    }
    if (
      method === "POST" &&
      url.pathname === "/api/v1/merchant/leads/11/drafts"
    ) {
      return json({
        instance: { instanceId: "test", name: "agents", version: "0.0.0" },
        draft: { ...DRAFT, id: "51", kind: "PUBLIC_REPLY" },
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

const { LeadDraftsModal } = await import(
  "@/client/merchant/components/LeadDraftsModal"
);
const { useModalController } = await import("@/client/components");
const { ToastProvider } = await import("@/client/components/Toast");

function Harness() {
  const modal = useModalController<{ id: string; authorName: string }>();
  return (
    <>
      <button
        type="button"
        onClick={() => modal.open({ id: "11", authorName: "Nguyễn Thảo" })}
      >
        open
      </button>
      <LeadDraftsModal modal={modal} onChanged={() => {}} />
    </>
  );
}

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("merchant LeadDraftsModal", () => {
  test("loads and lists the lead's drafts when opened", async () => {
    installFetchStub();
    render(
      <MemoryRouter>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => {
      expect(
        screen.queryByText("Chào chị Thảo, em có Serum BHA 289k ạ") !== null,
      ).toBe(true);
    });
    expect(screen.queryAllByText("DM opener").length > 0).toBe(true);
    expect(screen.queryAllByText("Draft").length > 0).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/api/v1/merchant/leads/11/drafts",
      ),
    ).toBe(true);
  });

  test("generating a public reply POSTs to the lead's drafts endpoint", async () => {
    installFetchStub();
    render(
      <MemoryRouter>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => {
      expect(screen.queryByText("Approve") !== null).toBe(true);
    });
    fireEvent.click(screen.getByText("Public reply"));
    await waitFor(() => {
      expect(
        requests.some(
          (r) =>
            r.method === "POST" &&
            r.path === "/api/v1/merchant/leads/11/drafts" &&
            r.body?.includes('"kind":"PUBLIC_REPLY"'),
        ),
      ).toBe(true);
    });
  });
});
