/// <reference lib="dom" />

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  getActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { mediaFetch } from "@/client/lib/media";
import { REJECTED_TENANT_SELECTOR_HEADER } from "@/lib/console-params";

// The recovery at both of its call sites, because a decision nothing calls changes nothing.
//
// Two things in the console send the tenant selector — the Eden client, on every API call, and
// `mediaFetch`, on the raw fetches that carry media bytes, PDFs and previews — and until this both
// of them could be told their selector was dead and do nothing about it. The `mediaFetch` half is
// the one that stays broken longest when it is missed: every caller there is a one-shot loader that
// reports its own 404 and stops, so the console would sit on a dead selection until some unrelated
// treaty call happened to be refused. Issue #252.
//
// NOTE: every assertion reduces to a string, number or boolean BEFORE expect. A failing expectation
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

let responder: () => Response = () => new Response(null, { status: 204 });
let pathname = "/dashboard";
const reloads: number[] = [];
const assigns: string[] = [];
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
  assigns.length = 0;
  pathname = "/dashboard";
  setActiveTenantId(null);
  // The per-window once-flag, reset because each test is a fresh page.
  (window as unknown as Record<string, unknown>).__tenantSelectorReloading =
    undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/")) return responder();
    return realFetch(input as RequestInfo | URL);
  }) as typeof fetch;
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

afterAll(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
  setActiveTenantId(null);
});

describe("a request refused because the selector it carried is dead", () => {
  test("through the API client: drops the selection and takes the page with it", async () => {
    setActiveTenantId("999");
    responder = () => refusal("999");
    await api.api.v1.agents.get();
    expect(getActiveTenantId()).toBeNull();
    // The page on screen was built on that id and its one-shot loaders will not retry themselves,
    // which is why a tenant SWITCH reloads for the same reason (see TenantSwitcher).
    expect(reloads.length).toBe(1);
  });

  test("through mediaFetch: the same, on the path a native <img> cannot take", async () => {
    setActiveTenantId("999");
    responder = () => refusal("999");
    const res = await mediaFetch("/api/v1/documents/7/pdf");
    // The caller still gets its own answer to report; the recovery is on top of it, not instead.
    expect(res.status).toBe(404);
    expect(getActiveTenantId()).toBeNull();
    expect(reloads.length).toBe(1);
  });

  test("a burst reloads once, not once per request", async () => {
    setActiveTenantId("999");
    responder = () => refusal("999");
    await Promise.all([
      api.api.v1.agents.get(),
      api.api.v1.tenants.get(),
      mediaFetch("/api/v1/documents/7/pdf"),
    ]);
    expect(getActiveTenantId()).toBeNull();
    expect(reloads.length).toBe(1);
  });

  test("a tab whose storage another tab already cleared still reloads itself", async () => {
    // localStorage is shared across tabs of the same origin. This tab is rendered against 999 and
    // still sending it; the neighbour that was refused first cleared the key. Reading that as
    // "already handled" is what would leave this tab on screen with no selector at all.
    responder = () => refusal("999");
    await api.api.v1.agents.get();
    expect(reloads.length).toBe(1);
  });

  test("on a detail route it lands on the list root, not on the dead id", async () => {
    // The route names a resource of the tenant that just died, so reloading in place would answer
    // 404 under whichever tenant /auth/me seeds next. Same answer a tenant SWITCH already gives.
    pathname = "/agents/42";
    setActiveTenantId("999");
    responder = () => refusal("999");
    await api.api.v1.agents.get();
    expect(assigns).toEqual(["/agents"]);
    expect(reloads.length).toBe(0);
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
    setActiveTenantId("7");
    responder = () => refusal("999");
    await api.api.v1.agents.get();
    expect(getActiveTenantId()).toBe("7");
    expect(reloads.length).toBe(0);
  });
});
