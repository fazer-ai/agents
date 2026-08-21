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
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ToastProvider } from "@/client/components";

// The decision this applies has a table of its own (tests/client/lib/tenantDeepLink.test.ts). What
// is tested HERE is the part a pure function cannot see: when the parameter is consumed.
//
// It is the whole feature. The tenant list is fetched asynchronously, so on the first render the
// answer is "cannot tell yet", and treating that as "nothing to do" (which it looked like) makes
// this component strip `?tenant` on the spot. The value the pending fetch was going to be judged
// against is then gone, the effect that fetches it is cancelled by its own dependency, and the
// switch never happens: the link silently behaves exactly like the tenant-less link it replaced.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const KEY = "@app:active-tenant";
let tenantsPayload: Array<{ id: string; name: string }> = [];
let tenantsGate: Promise<void> | null = null;
let role = "SUPER_ADMIN";
const realFetch = globalThis.fetch;
const reloads: number[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/v1/tenants")) {
      if (tenantsGate) await tenantsGate;
      return json({ tenants: tenantsPayload });
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

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "1", role }, loading: false }),
}));

const { TenantDeepLink } = await import("@/client/components/TenantDeepLink");

let seenSearch = "";
function SearchProbe() {
  seenSearch = useLocation().search;
  return null;
}

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/resources/vault${search}`]}>
      <ToastProvider>
        <SearchProbe />
        <Routes>
          <Route
            path="/resources/vault"
            element={
              <>
                <TenantDeepLink />
                <div>panel</div>
              </>
            }
          />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("TenantDeepLink", () => {
  beforeEach(() => {
    seenSearch = "";
    reloads.length = 0;
    role = "SUPER_ADMIN";
    tenantsGate = null;
    tenantsPayload = [
      { id: "10", name: "A" },
      { id: "20", name: "B" },
    ];
    localStorage.setItem(KEY, "10");
    installFetchStub();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload: () => reloads.push(1) },
    });
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem(KEY);
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("a link for another tenant switches to it and reloads", async () => {
    renderAt("?tenant=20&fill=5");
    await waitFor(() => {
      expect(reloads.length).toBe(1);
    });
    expect(localStorage.getItem(KEY)).toBe("20");
    // The parameter survives the switch on purpose: it is consumed only after the reload lands on
    // the tenant it names. Everything else on the URL rides along.
    expect(seenSearch).toBe("?tenant=20&fill=5");
  });

  test("the parameter is not consumed while the tenant list is still loading", async () => {
    let open!: () => void;
    tenantsGate = new Promise<void>((r) => {
      open = r;
    });
    renderAt("?tenant=20&fill=5");
    // Several frames with the answer still unknown: the parameter must still be there.
    await new Promise((r) => setTimeout(r, 30));
    expect(seenSearch).toBe("?tenant=20&fill=5");
    expect(reloads.length).toBe(0);
    open();
    await waitFor(() => {
      expect(reloads.length).toBe(1);
    });
  });

  test("a tenant this session cannot open is reported, and nothing is switched", async () => {
    tenantsPayload = [{ id: "10", name: "A" }];
    renderAt("?tenant=20");
    await waitFor(() => {
      expect(document.body.textContent?.includes("cannot open")).toBe(true);
    });
    expect(reloads.length).toBe(0);
    expect(localStorage.getItem(KEY)).toBe("10");
  });

  test("already on the tenant the link names: nothing happens and the parameter is cleaned up", async () => {
    renderAt("?tenant=10&fill=5");
    await waitFor(() => {
      expect(seenSearch).toBe("?fill=5");
    });
    expect(reloads.length).toBe(0);
  });

  test("a tenant-scoped user never switches, and the inert parameter is cleaned up", async () => {
    role = "TENANT_ADMIN";
    renderAt("?tenant=20&fill=5");
    await waitFor(() => {
      expect(seenSearch).toBe("?fill=5");
    });
    expect(reloads.length).toBe(0);
    expect(localStorage.getItem(KEY)).toBe("10");
  });
});
