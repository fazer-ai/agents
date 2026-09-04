/// <reference lib="dom" />

// The trail-wide newest row is IN THE RESPONSE and must not be ON THE PAGE.
//
// `latestAt` stays on the wire for the REST and MCP transports, so the type still offers it and
// nothing in the compiler objects to printing it. What was removed is the affordance: a "Trail
// recorded up to" line above the filters, which duplicated the first card when unfiltered and, when
// filtered, invited a comparison against a record's own `updatedAt` — a comparison that finds a bug
// rather than a state, because the audit row is written inside the mutation's transaction and there
// is no ingestion lag for a freshness line to report. #526.
//
// Asserted as ABSENCE OF THE VALUE rather than absence of a label, so it survives a rewording: the
// stub answers with an instant that appears nowhere else on the page.

import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

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
  // The rows carry a `<Tooltip>`, and Radix's Root refuses to mount without a provider under this
  // harness. The app supplies one on its own (verified live: the trigger reaches `delayed-open` and
  // the content renders); this is the same wrapper `KnowledgeDocsBlock.test.tsx` already uses.
  const view = render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/audit"]}>
        <AuditPage />
      </MemoryRouter>
    </TooltipProvider>,
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
