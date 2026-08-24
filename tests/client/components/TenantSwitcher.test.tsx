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
const sentTenantHeaders: Array<string | null> = [];
const realFetch = globalThis.fetch;

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
  setActiveTenantId(null);
  installFetchStub();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
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

  test("a stored tenant the fleet still has is left alone", async () => {
    setActiveTenantId("1");
    tenantsPayload = [{ id: "1", name: "Acme" }];
    mount();
    await waitFor(() => {
      expect(sentTenantHeaders.length).toBeGreaterThan(0);
    });
    expect(getActiveTenantId()).toBe("1");
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
  });
});
