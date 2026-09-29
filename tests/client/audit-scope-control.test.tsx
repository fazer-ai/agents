/// <reference lib="dom" />

// The scope, on the page. The three answers are not three filters over one query: the selector
// exists only for the role that may use it, the row grows a tenant column where "which tenant" stops
// being implied, and a scope this operator cannot use leaves the URL as well as the query (a shared
// link would otherwise carry a trail the page is not reading).

import {
  afterEach,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { ToastProvider } from "@/client/components";

const mockUser = { role: "TENANT_ADMIN" as string };

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockUser }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { AuditPage } = await import("@/client/pages/AuditPage");

const realFetch = globalThis.fetch;

// One row per tenant plus one keyed to none, so the tenant column has all three cases to render:
// a tenant, another tenant, and the fleet.
const ROWS = [
  { tenantId: "7", target: "t:seven" },
  { tenantId: "9", target: "t:nine" },
  { tenantId: null, target: "t:fleet" },
].map((r, i) => ({
  id: String(i + 1),
  tenantId: r.tenantId,
  actorId: "1",
  actorType: "user",
  action: "agent.create",
  target: r.target,
  before: null,
  after: { name: "Ana" },
  createdAt: "2026-09-03T12:00:00.000Z",
}));

let sent: string[] = [];
let search = "";

function Probe() {
  search = useLocation().search;
  return null;
}

beforeEach(() => {
  sent = [];
  mockUser.role = "TENANT_ADMIN";
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(
      JSON.stringify({ entries: ROWS, nextCursor: null, latestAt: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  setSystemTime();
});

function mount(url: string) {
  const view = render(
    <ToastProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[url]}>
          <AuditPage />
          <Probe />
        </MemoryRouter>
      </TooltipProvider>
    </ToastProvider>,
  );
  return {
    ...view,
    selects: () => Array.from(view.container.querySelectorAll("select")),
  };
}

const asked = () => sent.at(-1) ?? "";

test("a tenant admin is not offered the selector", async () => {
  const view = mount("/audit");
  await waitFor(() => expect(view.selects().length).toBeGreaterThan(0));
  // The door and the period, and nothing before them.
  expect(view.selects()).toHaveLength(2);
});

test("a super admin is", async () => {
  mockUser.role = "SUPER_ADMIN";
  const view = mount("/audit");
  await waitFor(() => expect(view.selects()).toHaveLength(3));
  expect((view.selects()[0] as HTMLSelectElement).value).toBe("tenant");
});

// The default must not put a scope on the wire: the endpoint's own default is the tenant read, and
// sending `scope=tenant` would make every existing caller's request differ for no reason.
test("the tenant scope is not sent", async () => {
  mockUser.role = "SUPER_ADMIN";
  mount("/audit");
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  expect(asked()).not.toContain("scope=");
});

test("a chosen scope reaches the request and the URL", async () => {
  mockUser.role = "SUPER_ADMIN";
  mount("/audit?scope=fleet");
  await waitFor(() => expect(asked()).toContain("scope=fleet"));
  expect(new URLSearchParams(search).get("scope")).toBe("fleet");
});

// A scope this operator may not use is dropped from BOTH, and the URL is the half that matters: the
// service would refuse it with a 403, and an address bar still saying `scope=all` would describe a
// trail nobody read.
test("a scope a tenant admin cannot use leaves the URL as well as the query", async () => {
  mount("/audit?scope=all");
  await waitFor(() =>
    expect(new URLSearchParams(search).get("scope")).toBeNull(),
  );
  expect(asked()).not.toContain("scope=");
});

test("a scope that is not a scope is dropped too", async () => {
  mockUser.role = "SUPER_ADMIN";
  mount("/audit?scope=everything");
  await waitFor(() =>
    expect(new URLSearchParams(search).get("scope")).toBeNull(),
  );
  expect(asked()).not.toContain("scope=");
});

// WHICH TENANT, and only where the answer is not already the page's.
test("the tenant column appears on a wider scope", async () => {
  mockUser.role = "SUPER_ADMIN";
  const view = mount("/audit?scope=all");
  await waitFor(() => expect(asked()).toContain("scope=all"));
  const text = view.container.textContent ?? "";
  expect(text).toContain("#7");
  expect(text).toContain("#9");
  // `null` is the fleet, not a missing value.
  expect(text).toContain("fleet");
});

test("and not on the tenant's own trail, where every row is its own", async () => {
  mockUser.role = "SUPER_ADMIN";
  const view = mount("/audit");
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  const text = view.container.textContent ?? "";
  expect(text).not.toContain("#7");
  expect(text).not.toContain("#9");
});

// The cursor belongs to one trail, and the scope chooses the trail. A keyset cursor handed to
// another scope still means `id < N`, silently dropping every newer row of the new trail and
// labelling what survives "Page 2".
test("switching scope restarts the walk instead of carrying the cursor over", async () => {
  mockUser.role = "SUPER_ADMIN";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(
      JSON.stringify({ entries: ROWS, nextCursor: "42", latestAt: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const view = mount("/audit");
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));

  const next = view.getByRole("button", { name: /next/i });
  act(() => {
    fireEvent.click(next);
  });
  await waitFor(() => expect(asked()).toContain("cursor=42"));
  expect(view.container.textContent).toContain("Page 2");

  const scopeSelect = view.selects()[0] as HTMLSelectElement;
  const mark = sent.length;
  act(() => {
    fireEvent.change(scopeSelect, { target: { value: "fleet" } });
  });
  await waitFor(() => expect(asked()).toContain("scope=fleet"));
  expect(asked()).not.toContain("cursor=");
  expect(view.container.textContent).toContain("Page 1");
  // NOTE: every request the change produced, not just the one that won: `reqRef` discards a stale
  // answer, so the screen is right either way and only the requests show a stale cursor sent with
  // the new filter.
  expect(sent.slice(mark).filter((u) => u.includes("cursor="))).toEqual([]);
});

// The empty state has to say what was searched. On a tenant's trail a fleet-level action can only
// come back empty (those rows are keyed to no tenant), so the page says the emptiness proves
// nothing. On `fleet` or `all` the page searched those rows, so the disclaimer would be false.
test("on a wider scope, an empty fleet-level action is a real answer", async () => {
  mockUser.role = "SUPER_ADMIN";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(
      JSON.stringify({ entries: [], nextCursor: null, latestAt: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const view = mount("/audit?scope=fleet&action=mcp_client.create");
  await waitFor(() => expect(asked()).toContain("scope=fleet"));
  const text = view.container.textContent ?? "";
  expect(text).not.toContain("not recorded on a tenant's trail");
  expect(text).toContain("No entries match these filters");
});

// The tenant scope keeps the disclaimer, so the fix above cannot be "delete the branch".
test("on the tenant's own trail it still says the emptiness proves nothing", async () => {
  mockUser.role = "SUPER_ADMIN";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(
      JSON.stringify({ entries: [], nextCursor: null, latestAt: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const view = mount("/audit?action=mcp_client.create");
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  expect(view.container.textContent).toContain(
    "not recorded on a tenant's trail",
  );
});
