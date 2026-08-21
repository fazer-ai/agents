/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ToastProvider } from "@/client/components";

// Issue #151: `credential_create` answers with a `fillAt` link so the operator can put the secret in
// out of band. The vault panel looked the id up in the tenant the browser happened to have selected
// and, when it was not there, stripped `?fill` anyway. The result was a page that behaved as if the
// operator had navigated there by hand: no modal, no message, and the link spent, so refreshing did
// not retry it.
//
// These drive the panel through the same `?fill` a real link carries. The assertion that matters is
// the URL: a miss must leave the parameter alone, because that is what lets the operator switch
// tenant in the header (a full reload) and have the same link resolve.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

let entriesPayload: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let vaultFails = false;

function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/vault/references")) return json({ references: [] });
    if (url.includes("/vault")) {
      if (vaultFails) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return json({ entries: entriesPayload });
    }
    return realFetch(input as RequestInfo | URL, init);
  }) as typeof fetch;
}

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      typeof fallback === "string" ? fallback : key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

mock.module("@/client/contexts/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
  }),
  useThemedAsset: (path: string) => ({ src: path }),
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

const { VaultPanel } = await import("@/client/pages/resources/VaultPanel");

// Reports the live URL so the assertion is about what the address bar holds, not about internals.
let seenSearch = "";
function SearchProbe() {
  seenSearch = useLocation().search;
  return null;
}

function renderPanel(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/resources/vault${search}`]}>
      <ToastProvider>
        <SearchProbe />
        <Routes>
          <Route path="/resources/vault" element={<VaultPanel />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("vault fill deeplink", () => {
  beforeEach(() => {
    seenSearch = "";
    vaultFails = false;
    installFetchStub();
  });
  afterEach(cleanup);
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("an id this tenant does not have keeps the parameter and says so", async () => {
    entriesPayload = [
      { id: "9", name: "OpenAI", kind: "openai", isSet: true, references: 0 },
    ];
    renderPanel("?fill=5");
    // The message is the half the operator can act on: the link is not lost, it is in another tenant.
    await waitFor(() => {
      expect(
        screen.queryAllByText(/not in the tenant you have open/i).length,
      ).toBeGreaterThan(0);
    });
    expect(seenSearch).toBe("?fill=5");
  });

  // A failed load leaves the list empty, which looks exactly like "the tenant does not have it" and
  // is a different claim: nothing authoritative was read. Saying it anyway would send the operator
  // switching tenants over what is really a 500, past the panel's own error state and its retry.
  test("a failed load reports nothing about tenants, and keeps the parameter", async () => {
    vaultFails = true;
    entriesPayload = [];
    renderPanel("?fill=5");
    await waitFor(() => {
      expect(seenSearch).toBe("?fill=5");
    });
    // Give the effect every chance to fire before concluding it did not.
    await new Promise((r) => setTimeout(r, 40));
    expect(
      document.body.textContent?.includes("not in the tenant you have open"),
    ).toBe(false);
    expect(seenSearch).toBe("?fill=5");
  });

  test("an id this tenant does have opens the modal and spends the parameter", async () => {
    entriesPayload = [
      { id: "5", name: "OpenAI", kind: "openai", isSet: false, references: 0 },
    ];
    renderPanel("?fill=5");
    await waitFor(() => {
      expect(seenSearch).toBe("");
    });
    // Spending it is only correct because it was used: the fill modal is open on that entry.
    expect(screen.queryAllByText("OpenAI").length).toBeGreaterThan(0);
  });
});
