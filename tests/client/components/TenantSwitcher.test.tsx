/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { TenantSwitcher } from "@/client/components/TenantSwitcher";
import {
  getActiveTenantId,
  setActiveTenantId,
  TENANTS_CHANGED_EVENT,
} from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";

// What the reconciliation actually buys, measured where the operator pays for it: the console stops
// sending a selector for a tenant that is not there. Until it does, EVERY request carries the dead
// id (src/client/lib/api.ts attaches it from storage), so the settings screens load empty and the
// first save comes back refused. Issue #223.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

let tenantsPayload: Array<{ id: string; name: string }> = [];
let tenantsFails = false;
// When set, each /v1/tenants call takes the next entry instead of `tenantsPayload`, so a test can
// choose which read answers first. `release` resolves that call's response.
let scripted: Array<{
  payload: Array<{ id: string; name: string }>;
  gate: Promise<void>;
  release: () => void;
}> = [];
const sentTenantHeaders: Array<string | null> = [];
const reloads: number[] = [];
const assigns: string[] = [];
let pathname = "/dashboard";
const realFetch = globalThis.fetch;
const realLocation = window.location;

function headerOf(input: RequestInfo | URL, init?: RequestInit): string | null {
  if (input instanceof Request) return input.headers.get("X-Tenant-Id");
  const h = init?.headers;
  if (h instanceof Headers) return h.get("X-Tenant-Id");
  if (Array.isArray(h))
    return h.find(([k]) => k.toLowerCase() === "x-tenant-id")?.[1] ?? null;
  if (h && typeof h === "object") {
    const found = Object.entries(h).find(
      ([k]) => k.toLowerCase() === "x-tenant-id",
    );
    return found ? String(found[1]) : null;
  }
  return null;
}

function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/v1/")) {
      sentTenantHeaders.push(headerOf(input, init));
      if (url.includes("/v1/tenants")) {
        if (tenantsFails) {
          return new Response(JSON.stringify({ error: "boom" }), {
            status: 500,
          });
        }
        const step = scripted.shift();
        if (step) {
          await step.gate;
          return new Response(JSON.stringify({ tenants: step.payload }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ tenants: tenantsPayload }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as RequestInfo | URL, init);
  }) as typeof fetch;
}

function mount() {
  return render(
    <MemoryRouter>
      <TenantSwitcher />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  tenantsPayload = [];
  tenantsFails = false;
  sentTenantHeaders.length = 0;
  reloads.length = 0;
  assigns.length = 0;
  pathname = "/dashboard";
  scripted = [];
  setActiveTenantId(null);
  installFetchStub();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...realLocation,
      // NOTE: a getter, because the route a test wants is set in the test body, after this ran.
      get pathname() {
        return pathname;
      },
      reload: () => reloads.push(1),
      assign: (to: string) => assigns.push(to),
    },
  });
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
  setActiveTenantId(null);
});

describe("a stored tenant the fleet no longer has", () => {
  test("is dropped, and the next request goes out without it", async () => {
    setActiveTenantId("999");
    tenantsPayload = [{ id: "1", name: "Acme" }];
    mount();
    await waitFor(() => {
      expect(getActiveTenantId()).toBeNull();
    });
    // The observable: the very next call carries no selector, so the API answers about nothing
    // instead of about a tenant that is not there.
    sentTenantHeaders.length = 0;
    await api.api.v1.agents.get();
    expect(sentTenantHeaders).toEqual([null]);
  });

  test("takes the page with it, because the page was built on the dead id", async () => {
    // This hook lives in the header, so the routed page mounted alongside it and already sent its own
    // requests with the dead selector. Clearing storage does not remount or retry those, so without
    // the reload a one-shot loader sits in its error state until someone retries it by hand.
    setActiveTenantId("999");
    tenantsPayload = [{ id: "1", name: "Acme" }];
    mount();
    await waitFor(() => {
      expect(reloads.length).toBe(1);
    });
  });

  test("a stored tenant the fleet still has is left alone", async () => {
    setActiveTenantId("1");
    tenantsPayload = [{ id: "1", name: "Acme" }];
    mount();
    await waitFor(() => {
      expect(sentTenantHeaders.length).toBeGreaterThan(0);
    });
    expect(getActiveTenantId()).toBe("1");
    // Nothing was dropped, so nothing is reloaded: the ordinary load must not cost a second one.
    expect(reloads.length).toBe(0);
  });

  test("an answer that arrived late does not undo the one that arrived first", async () => {
    // Two reads of the same URL overlap: the one on mount, and the one a tenant creation triggers.
    // Nothing orders their answers, and the older one describes a fleet that no longer exists.
    // Acting on it would clear a selection the newer answer had just confirmed, and reload on top.
    const step = (payload: Array<{ id: string; name: string }>) => {
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      return { payload, gate, release };
    };
    const first = step([{ id: "1", name: "Acme" }]);
    const second = step([
      { id: "1", name: "Acme" },
      { id: "9", name: "New" },
    ]);
    scripted = [first, second];

    setActiveTenantId("9");
    mount();
    // The creation's read is the second one out, and it answers first, confirming the selection.
    window.dispatchEvent(new Event(TENANTS_CHANGED_EVENT));
    await waitFor(() => {
      expect(scripted.length).toBe(0);
    });
    second.release();
    await waitFor(() => {
      expect(getActiveTenantId()).toBe("9");
    });
    // Then the mount's read lands, carrying the older fleet.
    first.release();
    await new Promise((r) => setTimeout(r, 30));
    expect(getActiveTenantId()).toBe("9");
    expect(reloads.length).toBe(0);
  });

  test("on a detail route it lands on the list root, not on the dead id", async () => {
    // The route names an agent of the tenant that is gone, so reloading in place would look that id
    // up under whichever tenant is seeded next and answer 404. The switch already knew this; the
    // reconciliation did not, and both now ask the same function (reloadOntoSafeRoute).
    pathname = "/agents/42";
    setActiveTenantId("999");
    tenantsPayload = [{ id: "1", name: "Acme" }];
    mount();
    await waitFor(() => {
      expect(assigns).toEqual(["/agents"]);
    });
    expect(reloads.length).toBe(0);
  });

  test("a list we could not read decides nothing", async () => {
    // A failed read is not the claim "there are no tenants". Clearing on it would cost the operator
    // their tenant on every server blip, which is a worse defect than the one being fixed.
    setActiveTenantId("999");
    tenantsFails = true;
    mount();
    await waitFor(() => {
      expect(sentTenantHeaders.length).toBeGreaterThan(0);
    });
    expect(getActiveTenantId()).toBe("999");
    expect(reloads.length).toBe(0);
  });
});
