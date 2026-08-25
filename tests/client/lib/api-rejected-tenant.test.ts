/// <reference lib="dom" />

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  getActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { REJECTED_TENANT_SELECTOR_HEADER } from "@/lib/console-params";

// The reconciliation that does NOT wait for a page load, driven through the real Eden client.
//
// `dropSelectionIfRejected` is a decision, and a decision nothing calls changes nothing: what this
// file asserts is the call site. Until the console acts on the refusal, an operator who deletes the
// tenant they are working in keeps a dead id in every request until they reload by hand, which is
// the half of #223 that its fix did not reach.
//
// NOTE: every assertion reduces to a number, a string or a boolean BEFORE expect. A failing
// expectation holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

let responder: () => Response = () => new Response(null, { status: 204 });
const reloads: number[] = [];
const realFetch = globalThis.fetch;
const realLocation = window.location;

const refusal = (rejectedId: string | null) =>
  new Response(JSON.stringify({ error: "Tenant not found" }), {
    status: 404,
    headers: {
      "content-type": "application/json",
      ...(rejectedId ? { [REJECTED_TENANT_SELECTOR_HEADER]: rejectedId } : {}),
    },
  });

beforeEach(() => {
  reloads.length = 0;
  setActiveTenantId(null);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/")) return responder();
    return realFetch(input as RequestInfo | URL);
  }) as typeof fetch;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, reload: () => reloads.push(1) },
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
  setActiveTenantId(null);
});

describe("a request refused because the selector it carried is dead", () => {
  test("drops the selection and takes the page with it", async () => {
    setActiveTenantId("999");
    responder = () => refusal("999");
    await api.api.v1.agents.get();
    expect(getActiveTenantId()).toBeNull();
    // The page on screen was built on that id and its one-shot loaders will not retry themselves,
    // which is why a tenant SWITCH reloads for the same reason (see TenantSwitcher).
    expect(reloads.length).toBe(1);
  });

  test("a burst of them reloads once, not once per request", async () => {
    setActiveTenantId("999");
    responder = () => refusal("999");
    await Promise.all([
      api.api.v1.agents.get(),
      api.api.v1.tenants.get(),
      api.api.v1.agents.get(),
    ]);
    expect(getActiveTenantId()).toBeNull();
    expect(reloads.length).toBe(1);
  });

  test("a 404 that names no selector is left to the page that asked", async () => {
    // The status alone is not the signal: an agent, a document or a tenant the operator NAMED can be
    // missing, and none of those says anything about what the browser is holding.
    setActiveTenantId("7");
    responder = () => refusal(null);
    await api.api.v1.agents.get();
    expect(getActiveTenantId()).toBe("7");
    expect(reloads.length).toBe(0);
  });

  test("a refusal naming an id the console has already left is ignored", async () => {
    // The request went out under the old selection and was refused after the operator switched.
    setActiveTenantId("7");
    responder = () => refusal("999");
    await api.api.v1.agents.get();
    expect(getActiveTenantId()).toBe("7");
    expect(reloads.length).toBe(0);
  });
});
