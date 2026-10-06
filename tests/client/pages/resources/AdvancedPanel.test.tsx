/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/client/components/Toast";
import { AdvancedPanel } from "@/client/pages/resources/AdvancedPanel";

// THE ADVANCED SCREEN HAS AN INDEX, like the agent's Behavior tab: four tall cards, one entry each,
// in the order they are drawn, and each entry pointing at an anchor its card carries.

const realFetch = globalThis.fetch;
const realObserver = globalThis.IntersectionObserver;

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver =
  NoopObserver as unknown as typeof IntersectionObserver;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname === "/api/v1/tenant-settings") {
    return json({
      instance: {},
      embedding: { credentialRef: null },
      langfuse: {
        enabled: false,
        credentialRef: null,
        sendContent: false,
        debug: false,
      },
      spendCeiling: {
        enabled: false,
        monthlyInboxUsd: null,
        monthlyPlaygroundUsd: null,
        overCeilingMessage: null,
        handoffEnabled: false,
        noticeCooldownSeconds: 3600,
        warnAtPercent: 80,
        legacyTokens: null,
      },
      priceOverrides: { overrides: [], savedAt: null },
    });
  }
  return json({}, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.IntersectionObserver = realObserver;
});

describe("the Advanced screen's index", () => {
  test("lists the four cards in the order they are drawn, each pointing at its card", async () => {
    render(
      <ToastProvider>
        <AdvancedPanel />
      </ToastProvider>,
    );
    const nav = await waitFor(() =>
      screen.getByRole("navigation", { name: "Sections" }),
    );
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((a) => a.textContent)).toEqual([
      "Spend ceiling",
      "Model prices",
      "Embedding",
      "Observability (Langfuse)",
    ]);
    const anchors = links.map((a) =>
      (a.getAttribute("href") ?? "").replace(/^#/, ""),
    );
    const cards = anchors.map((id) => document.getElementById(id));
    expect(cards.every((el) => el !== null)).toBe(true);
    // Drawn in the same order the index lists them.
    for (let i = 1; i < cards.length; i++) {
      const prev = cards[i - 1] as HTMLElement;
      const next = cards[i] as HTMLElement;
      expect(
        prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // Each anchor holds its own card's title.
    expect(cards[0]?.textContent).toContain("Spend ceiling");
    expect(cards[3]?.textContent).toContain("Observability (Langfuse)");
  });
});
