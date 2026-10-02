/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";

// The /broadcasts page is the operator's list of the composer rail: each row
// must carry the resolved audience size and the manual-send ledger (sent
// count + status), or the console shows a composition without its progress.
// The stub answers GET /api/v1/merchant/broadcasts in the shape
// listBroadcasts returns (ids stringified, dates ISO).

const realFetch = globalThis.fetch;
const requests: Array<{ method: string; path: string }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function installFetchStub() {
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    requests.push({ method, path: url.pathname });
    if (method === "GET" && url.pathname === "/api/v1/merchant/broadcasts") {
      return json({
        instance: { instanceId: "test", name: "agents", version: "0.0.0" },
        broadcasts: [
          {
            id: "9",
            name: "Serum promo",
            body: "Chào {{authorName}}",
            audienceFilter: { minScore: 50 },
            status: "READY",
            sentCount: 3,
            sentAt: null,
            createdBy: "1",
            createdAt: "2026-10-02T08:00:00.000Z",
            updatedAt: "2026-10-02T08:00:00.000Z",
            recipientCount: 12,
          },
        ],
        nextCursor: null,
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

const { BroadcastsPage } = await import(
  "@/client/merchant/pages/BroadcastsPage"
);

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("merchant BroadcastsPage", () => {
  test("renders rows with audience size, status and sent count", async () => {
    installFetchStub();
    render(
      <MemoryRouter initialEntries={["/broadcasts"]}>
        <ToastProvider>
          <BroadcastsPage />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText("Serum promo") !== null).toBe(true);
    });
    expect(screen.queryByText("12") !== null).toBe(true);
    expect(screen.queryByText("3") !== null).toBe(true);
    expect(screen.queryByText("Ready") !== null).toBe(true);
    expect(
      requests.some(
        (r) => r.method === "GET" && r.path === "/api/v1/merchant/broadcasts",
      ),
    ).toBe(true);
  });
});
