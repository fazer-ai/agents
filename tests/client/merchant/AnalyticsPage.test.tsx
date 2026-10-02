/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The merchant /analytics page is the operator's funnel readout: stat cards
// for the topline numbers, breakdown tables for status/platform/source, top
// matched products, orders by status, and the 14-day lead series. The stub
// answers GET /api/v1/merchant/analytics/summary in the shape the service
// returns and the test asserts the numbers land where the operator reads
// them - a card that drops a breakdown is a silent wrong answer.

const realFetch = globalThis.fetch;
const requests: Array<{ method: string; path: string }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const SUMMARY = {
  leads: {
    total: 3,
    byStatus: [
      { status: "NEW", count: 2 },
      { status: "CONVERTED", count: 1 },
    ],
    byPlatform: [
      { platform: "facebook", count: 2 },
      { platform: "tiktok", count: 1 },
    ],
    bySource: [
      { sourceId: "9", name: "FB group", count: 2 },
      { sourceId: null, name: null, count: 1 },
    ],
  },
  topProducts: [
    { productId: "5", name: "Serum BHA 2%", matches: 2 },
    { productId: "6", name: "Váy suông", matches: 1 },
  ],
  orders: {
    total: 2,
    totalAmount: 370000,
    fromLeads: 1,
    byStatus: [
      { status: "PAID", count: 1, totalAmount: 250000 },
      { status: "DRAFT", count: 1, totalAmount: 120000 },
    ],
  },
  conversion: { convertedLeads: 1, pct: 33.3 },
  leadsPerDay: Array.from({ length: 14 }, (_, i) => ({
    day: `2026-10-${String(i + 1).padStart(2, "0")}`,
    count: i === 13 ? 3 : 0,
  })),
};

function installFetchStub() {
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    requests.push({ method, path: url.pathname });
    if (
      method === "GET" &&
      url.pathname === "/api/v1/merchant/analytics/summary"
    ) {
      return json({
        instance: { instanceId: "test", name: "agents", version: "0.0.0" },
        summary: SUMMARY,
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

const { AnalyticsPage } = await import("@/client/merchant/pages/AnalyticsPage");

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("merchant AnalyticsPage", () => {
  test("renders the stat cards and every breakdown table", async () => {
    installFetchStub();
    render(
      <MemoryRouter initialEntries={["/analytics"]}>
        <AnalyticsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText("Analytics") !== null).toBe(true);
      expect(screen.queryByText("Serum BHA 2%") !== null).toBe(true);
    });
    // Topline cards.
    expect(screen.queryByText("33.3%") !== null).toBe(true);
    expect(screen.queryByText("370.000 ₫") !== null).toBe(true);
    // Breakdowns: named source plus the manual bucket, platform, statuses.
    expect(screen.queryByText("FB group") !== null).toBe(true);
    expect(screen.queryByText("Manual") !== null).toBe(true);
    expect(screen.queryByText("facebook") !== null).toBe(true);
    expect(screen.queryByText("Converted") !== null).toBe(true);
    expect(screen.queryByText("Paid") !== null).toBe(true);
    expect(screen.queryByText("Váy suông") !== null).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" && r.path === "/api/v1/merchant/analytics/summary",
      ),
    ).toBe(true);
  });
});
