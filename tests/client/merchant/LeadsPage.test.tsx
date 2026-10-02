/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The merchant /leads page is the operator's view of the ingest scorer's
// output: every row has to carry the score badge and the matched product names
// the scorer wrote, or the console is showing a post without its "why". The
// stub below answers the treaty client's GET /api/v1/merchant/leads with a row
// in the shape listLeads returns (ids stringified, createdAt ISO string).

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
    if (method === "GET" && url.pathname === "/api/v1/merchant/leads") {
      return json({
        instance: { instanceId: "test", name: "agents", version: "0.0.0" },
        leads: [
          {
            id: "1",
            platform: "facebook",
            authorName: "Nguyễn Thảo",
            authorHandle: null,
            text: "Cần mua serum trị mụn cho da dầu, budget 300k",
            sourceUrl: null,
            groupName: "Hội mỹ phẩm chính hãng",
            score: 100,
            status: "NEW",
            matches: [
              {
                productId: "5",
                productName: "Serum trị mụn BHA 2%",
                score: 0.95,
                reason: 'post names product "Serum trị mụn BHA 2%"',
              },
            ],
            createdAt: "2026-10-01T20:24:15.000Z",
          },
        ],
        nextCursor: null,
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

const { LeadsPage } = await import("@/client/merchant/pages/LeadsPage");
const { ToastProvider } = await import("@/client/components/Toast");

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("merchant LeadsPage", () => {
  test("renders scored rows with the score badge and matched products", async () => {
    installFetchStub();
    render(
      <MemoryRouter initialEntries={["/leads"]}>
        <ToastProvider>
          <LeadsPage />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText("Nguyễn Thảo") !== null).toBe(true);
    });
    expect(screen.queryByText("100") !== null).toBe(true);
    expect(screen.queryByText("Serum trị mụn BHA 2%") !== null).toBe(true);
    expect(screen.queryByText("New") !== null).toBe(true);
    expect(screen.queryByText("facebook") !== null).toBe(true);
    expect(
      requests.some(
        (r) => r.method === "GET" && r.path === "/api/v1/merchant/leads",
      ),
    ).toBe(true);
  });
});
