/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The merchant /orders page is the operator's view of orders attributed back
// to the lead that produced them: every row has to carry the contact, the lead
// author, the line items, and the VND total, or the console is showing an
// order without its provenance. The stub below answers the treaty client's
// GET /api/v1/merchant/orders with a row in the shape listOrders returns (ids
// stringified, totalAmount a number, createdAt ISO string).

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
    if (method === "GET" && url.pathname === "/api/v1/merchant/orders") {
      return json({
        instance: { instanceId: "test", name: "agents", version: "0.0.0" },
        orders: [
          {
            id: "1",
            leadId: "1",
            leadAuthorName: "Nguyễn Thảo",
            contactName: "Nguyễn Thảo",
            contactPhone: "0901234567",
            contactAddress: "Quận 1, TP.HCM",
            status: "CONFIRMED",
            totalAmount: 289000,
            note: "Chốt qua inbox, COD",
            items: [
              {
                id: "1",
                productId: "5",
                productName: "Serum trị mụn BHA 2%",
                qty: 1,
                unitPrice: 289000,
              },
            ],
            createdAt: "2026-10-01T20:24:17.000Z",
          },
        ],
        nextCursor: null,
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

const { OrdersPage } = await import("@/client/merchant/pages/OrdersPage");

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("merchant OrdersPage", () => {
  test("renders order rows with contact, items, lead, and total", async () => {
    installFetchStub();
    render(
      <MemoryRouter initialEntries={["/orders"]}>
        <OrdersPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText("#1") !== null).toBe(true);
    });
    expect(screen.queryAllByText("Nguyễn Thảo").length).toBeGreaterThan(0);
    expect(screen.queryByText("1× Serum trị mụn BHA 2%") !== null).toBe(true);
    expect(screen.queryByText("289.000 ₫") !== null).toBe(true);
    expect(screen.queryByText("Confirmed") !== null).toBe(true);
    expect(
      requests.some(
        (r) => r.method === "GET" && r.path === "/api/v1/merchant/orders",
      ),
    ).toBe(true);
  });
});
