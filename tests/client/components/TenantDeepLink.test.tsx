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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ToastProvider } from "@/client/components";

// The decision this applies has a table of its own (tests/client/lib/tenantDeepLink.test.ts). What
// is tested HERE is the part a pure function cannot see: when the parameter is consumed, and when
// the page underneath is allowed to mount.
//
// The gate is the whole point. Everything this component protects against comes down to one picture:
// tenant A's page, with its buttons live, under a URL that names tenant B. So the rule is that the
// gate opens when the answer is KNOWN, not when it is convenient — a tenant we cannot open is known
// (stay put, say why), a tenant list we could not read is not (hold, offer a retry).
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const KEY = "@app:active-tenant";
let tenantsPayload: Array<{ id: string; name: string }> = [];
let tenantsGate: Promise<void> | null = null;
let tenantsFails = false;
let tenantsCalls = 0;
let role = "SUPER_ADMIN";
let userTenantId: string | null = null;
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
      tenantsCalls += 1;
      if (tenantsGate) await tenantsGate;
      if (tenantsFails) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
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
  useAuth: () => ({
    user: { id: "1", role, tenantId: userTenantId },
    loading: false,
  }),
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
              <TenantDeepLink>
                <div>panel</div>
              </TenantDeepLink>
            }
          />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const shows = (s: string) => document.body.textContent?.includes(s) === true;

describe("TenantDeepLink", () => {
  beforeEach(() => {
    seenSearch = "";
    reloads.length = 0;
    tenantsCalls = 0;
    role = "SUPER_ADMIN";
    userTenantId = null;
    tenantsGate = null;
    tenantsFails = false;
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

  // The gate is the reason this is a wrapper: while the switch is in play the page under it must not
  // mount, or it fetches the tenant the console is about to leave and shows its controls live.
  test("the page under it does not mount while a switch is being decided", async () => {
    let open!: () => void;
    tenantsGate = new Promise<void>((r) => {
      open = r;
    });
    renderAt("?switchTenant=20&fill=5");
    await new Promise((r) => setTimeout(r, 30));
    expect(shows("panel")).toBe(false);
    open();
    await waitFor(() => {
      expect(reloads.length).toBe(1);
    });
    // Still held: a reload is coming, and the old tenant's page must not flash before it.
    expect(shows("panel")).toBe(false);
  });

  test("a page with no switch parameter renders immediately", async () => {
    renderAt("?fill=5");
    expect(shows("panel")).toBe(true);
  });

  test("an unavailable target opens the gate: the console stays where it is", async () => {
    tenantsPayload = [{ id: "10", name: "A" }];
    renderAt("?switchTenant=20");
    await waitFor(() => {
      expect(shows("panel")).toBe(true);
    });
    expect(reloads.length).toBe(0);
  });

  test("a link for another tenant switches to it and reloads", async () => {
    renderAt("?switchTenant=20&fill=5");
    await waitFor(() => {
      expect(reloads.length).toBe(1);
    });
    expect(localStorage.getItem(KEY)).toBe("20");
    // The parameter survives the switch on purpose: it is consumed only after the reload lands on
    // the tenant it names. Everything else on the URL rides along.
    expect(seenSearch).toBe("?switchTenant=20&fill=5");
  });

  test("the parameter is not consumed while the tenant list is still loading", async () => {
    let open!: () => void;
    tenantsGate = new Promise<void>((r) => {
      open = r;
    });
    renderAt("?switchTenant=20&fill=5");
    // Several frames with the answer still unknown: the parameter must still be there.
    await new Promise((r) => setTimeout(r, 30));
    expect(seenSearch).toBe("?switchTenant=20&fill=5");
    expect(reloads.length).toBe(0);
    open();
    await waitFor(() => {
      expect(reloads.length).toBe(1);
    });
  });

  test("a tenant this session cannot open is reported, and nothing is switched", async () => {
    tenantsPayload = [{ id: "10", name: "A" }];
    renderAt("?switchTenant=20");
    await waitFor(() => {
      expect(shows("cannot open")).toBe(true);
    });
    expect(reloads.length).toBe(0);
    expect(localStorage.getItem(KEY)).toBe("10");
  });

  test("already on the tenant the link names: nothing happens and the parameter is cleaned up", async () => {
    renderAt("?switchTenant=10&fill=5");
    await waitFor(() => {
      expect(seenSearch).toBe("?fill=5");
    });
    expect(reloads.length).toBe(0);
  });

  // `/admin/users?tenant=<id>` is that page's fleet-wide filter and predates this component, and the
  // tenants list links straight to it. A component mounted on every protected route that switched on
  // sight of `tenant` would hijack that link: switch the console, reload, then strip the filter the
  // operator had just chosen. Hence a parameter of this component's own.
  test("the admin users filter is not a switch request", async () => {
    renderAt("?tenant=20");
    await waitFor(() => {
      expect(shows("panel")).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(reloads.length).toBe(0);
    expect(localStorage.getItem(KEY)).toBe("10");
    // And the filter is still on the URL for the page that owns it.
    expect(seenSearch).toBe("?tenant=20");
  });

  // ── a session pinned to one tenant ──

  test("a tenant-scoped session whose own tenant the link names: nothing to do, parameter cleaned up", async () => {
    role = "TENANT_ADMIN";
    userTenantId = "10";
    renderAt("?switchTenant=10&fill=5");
    await waitFor(() => {
      expect(seenSearch).toBe("?fill=5");
    });
    expect(reloads.length).toBe(0);
    // It never asks: there is no list that could change the answer.
    expect(tenantsCalls).toBe(0);
  });

  // `createAt` and `configureAt` name a ROUTE and carry no id, so nothing downstream can notice the
  // mismatch the way the vault's `?fill` lookup does. Silence here is what puts the operator on their
  // own tenant's page believing they followed the link, and creates the resource in the wrong tenant.
  test("a tenant-scoped session handed another tenant's link is told, not left to guess", async () => {
    role = "TENANT_ADMIN";
    userTenantId = "10";
    renderAt("?switchTenant=20");
    await waitFor(() => {
      expect(shows("cannot open")).toBe(true);
    });
    expect(reloads.length).toBe(0);
    expect(localStorage.getItem(KEY)).toBe("10");
    // The console stays usable where it is, which is the only place it can be.
    expect(shows("panel")).toBe(true);
    // And the parameter stays, so the URL still says what it was for.
    expect(seenSearch).toBe("?switchTenant=20");
  });

  test("a tenant-scoped session is judged by its own tenant, not by a stale stored selection", async () => {
    role = "TENANT_ADMIN";
    userTenantId = "10";
    localStorage.setItem(KEY, "20");
    renderAt("?switchTenant=20");
    await waitFor(() => {
      expect(shows("cannot open")).toBe(true);
    });
    expect(reloads.length).toBe(0);
  });

  // ── the list could not be read ──

  test("a failed tenant list holds the gate instead of showing the wrong tenant's page", async () => {
    tenantsFails = true;
    renderAt("?switchTenant=20&fill=5");
    await waitFor(() => {
      expect(shows("Could not check this link")).toBe(true);
    });
    // The whole point: tenant 10's controls must NOT be mounted under a URL naming tenant 20.
    expect(shows("panel")).toBe(false);
    expect(reloads.length).toBe(0);
    expect(localStorage.getItem(KEY)).toBe("10");
    // And it must not claim the link is bad, which is a different thing from not knowing.
    expect(shows("cannot open")).toBe(false);
    expect(seenSearch).toBe("?switchTenant=20&fill=5");
  });

  test("the retry re-reads the list, and a switch follows once it answers", async () => {
    tenantsFails = true;
    renderAt("?switchTenant=20");
    await waitFor(() => {
      expect(shows("Could not check this link")).toBe(true);
    });
    expect(tenantsCalls).toBe(1);
    tenantsFails = false;
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => {
      expect(reloads.length).toBe(1);
    });
    expect(tenantsCalls).toBe(2);
    expect(localStorage.getItem(KEY)).toBe("20");
  });

  // Ordering inside the rule: "already there" is answered before anything that can fail, so a broken
  // tenants endpoint cannot strand the operator on the tenant they successfully switched to.
  test("a failed list does not block the page the switch already landed on", async () => {
    tenantsFails = true;
    renderAt("?switchTenant=10&fill=5");
    await waitFor(() => {
      expect(shows("panel")).toBe(true);
    });
    expect(shows("Could not check this link")).toBe(false);
    expect(seenSearch).toBe("?fill=5");
  });
});
