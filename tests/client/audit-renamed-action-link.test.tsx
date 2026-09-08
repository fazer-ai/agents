/// <reference lib="dom" />

// A LINK SAVED BEFORE THE RENAME STILL OPENS THE ROWS IT NAMED (issue #555).
//
// The two consent actions were renamed and every row moved, and the old spellings left the catalog
// the picker is built from. That leaves a saved `/audit?action=mcp_oauth_consent_granted` — a
// bookmark, a link pasted in a ticket, a dashboard's deep link — naming something no row carries
// any more, and the answer would be an empty trail: the page saying "no consent decision was ever
// recorded" about rows sitting one name over.
//
// What is asserted here is BOTH halves, because either alone is still broken for the operator:
// the request goes out under the name the rows carry, AND the control on screen shows that name
// rather than the dead one. A page that quietly asks the right question while displaying the old
// spelling teaches the operator a name that no longer works.

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";

const mockUser = { role: "SUPER_ADMIN" as string };

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockUser }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { AuditPage } = await import("@/client/pages/AuditPage");

const realFetch = globalThis.fetch;
let sent: string[] = [];

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(
      JSON.stringify({ entries: [], nextCursor: null, latestAt: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function mountAt(search: string) {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/audit${search}`]}>
          <AuditPage />
        </MemoryRouter>
      </TooltipProvider>
    </ToastProvider>,
  );
}

test("an old spelling in the URL asks for the name the rows carry", async () => {
  mountAt("?action=mcp_oauth_consent_granted");
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  const asked = sent.at(-1) ?? "";
  expect(asked).toContain(encodeURIComponent("mcp_oauth_consent.grant"));
  expect(asked).not.toContain("mcp_oauth_consent_granted");
});

test("and the filter on screen shows that name, not the dead one", async () => {
  const view = mountAt("?action=mcp_oauth_consent_denied");
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  const text = view.container.textContent ?? "";
  expect(text).toContain("mcp_oauth_consent.deny");
  expect(text).not.toContain("mcp_oauth_consent_denied");
});

// The redirect is for the two names it names and nothing else: a value the catalog never had is the
// operator's own typing, and rewriting it would hide their mistake behind a filter that looks fine.
test("an unrelated value is left exactly as it was asked", async () => {
  mountAt("?action=not_an_action");
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  expect(sent.at(-1) ?? "").toContain("not_an_action");
});
