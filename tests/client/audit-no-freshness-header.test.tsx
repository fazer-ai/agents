/// <reference lib="dom" />

// The trail-wide newest row is IN THE RESPONSE and must not be ON THE PAGE. `latestAt` stays on the
// wire for REST and MCP, so the type still offers it. A freshness line has nothing to report: the
// audit row is written inside the mutation's transaction, so there is no ingestion lag.
// Asserted as absence of the VALUE, not of a label, so it survives a rewording.

import {
  afterEach,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";

// The page reads the principal's role to decide whether to offer the scope selector. These files
// are not about that, so the mock hands it an ordinary TENANT_ADMIN.
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { role: "TENANT_ADMIN" } }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { AuditPage } = await import("@/client/pages/AuditPage");

const realFetch = globalThis.fetch;

// An instant no row carries and no preset resolves to, so finding it on the page can only mean the
// page printed `latestAt`.
const LATEST_AT = "2019-03-17T04:05:06.000Z";
const ROW = {
  id: "1",
  tenantId: "1",
  actorId: "1",
  actorType: "user",
  action: "agent.create",
  target: "agent:1",
  before: null,
  after: { name: "Ana" },
  createdAt: "2026-09-03T12:00:00.000Z",
};

beforeEach(() => {
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        entries: [ROW],
        nextCursor: null,
        latestAt: LATEST_AT,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  setSystemTime();
});

test("the trail-wide newest row is not printed anywhere", async () => {
  // NOTE: the rows carry a `<Tooltip>`, and Radix's Root refuses to mount without a provider under
  // this harness (the app supplies its own).
  const view = render(
    <ToastProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/audit"]}>
          <AuditPage />
        </MemoryRouter>
      </TooltipProvider>
    </ToastProvider>,
  );

  // The row landed, so the response WAS read and the assertion below is about rendering.
  await waitFor(() =>
    expect(view.container.textContent).toContain("agent.create"),
  );

  const text = view.container.textContent ?? "";
  for (const fragment of ["2019", "04:05", "4:05"]) {
    expect(text).not.toContain(fragment);
  }
});
