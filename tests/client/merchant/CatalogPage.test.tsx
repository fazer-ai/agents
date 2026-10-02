/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The merchant /catalog page is the operator's view of the product list the
// lead scorer matches posts against: every row has to carry the name, VND
// price, tags, and active state the tenant wrote, or the console is showing a
// catalog that cannot score. The stub below answers the treaty client's GET
// /api/v1/merchant/products with a row in the shape listProducts returns (ids
// stringified, price a number, createdAt ISO string).

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
    if (method === "GET" && url.pathname === "/api/v1/merchant/products") {
      return json({
        instance: { instanceId: "test", name: "agents", version: "0.0.0" },
        products: [
          {
            id: "5",
            name: "Serum trị mụn BHA 2%",
            description: "Serum BHA cho da dầu mụn.",
            price: 289000,
            stock: 120,
            tags: ["serum", "trị mụn", "BHA"],
            imageUrl: null,
            active: true,
            category: "mỹ phẩm/skincare",
            attributes: { size: "30ml", priceSegment: "trung bình" },
            taggedAt: "2026-10-02T04:42:43.000Z",
            tagSource: "llm",
            createdAt: "2026-10-01T20:24:15.000Z",
            updatedAt: "2026-10-01T20:24:15.000Z",
          },
        ],
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

const { CatalogPage } = await import("@/client/merchant/pages/CatalogPage");
const { ToastProvider } = await import("@/client/components");

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("merchant CatalogPage", () => {
  test("renders product rows with price, tags, and active badge", async () => {
    installFetchStub();
    render(
      <MemoryRouter initialEntries={["/catalog"]}>
        <ToastProvider>
          <CatalogPage />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText("Serum trị mụn BHA 2%") !== null).toBe(true);
    });
    expect(screen.queryByText("289.000 ₫") !== null).toBe(true);
    expect(screen.queryByText("trị mụn") !== null).toBe(true);
    expect(screen.queryByText("Active") !== null).toBe(true);
    // PIM-lite columns: the LLM's category and the facet summary the row shows.
    expect(screen.queryByText("mỹ phẩm/skincare") !== null).toBe(true);
    expect(
      screen.queryByText("size: 30ml · priceSegment: trung bình") !== null,
    ).toBe(true);
    expect(screen.queryByText("Re-tag") !== null).toBe(true);
    expect(
      requests.some(
        (r) => r.method === "GET" && r.path === "/api/v1/merchant/products",
      ),
    ).toBe(true);
  });
});
