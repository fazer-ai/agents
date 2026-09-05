/// <reference lib="dom" />

// THE WALK RESTARTS WHENEVER THE QUESTION CHANGES (issue #532).
//
// A keyset cursor is an id cut from the page before, and it only means "continue" against the rows
// it was cut from. Every filter on this page changes which rows those are, so every one of them has
// to restart the walk -- and the reset has to be visible on the render that recreates the load, not
// one commit later.
//
// WHAT MAKES THESE TESTS DIFFERENT from the ones already in `audit-scope-control.test.tsx` is not
// the filter they drive, it is that they assert EVERY request the change produced. The page has
// always ended up on the right rows, because `reqRef` discards the answer to the stale pair; the
// defect was only ever visible in the requests that were made and thrown away. A test that reads
// the last URL is green against both the bug and the fix.

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
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";

const mockUser = { role: "SUPER_ADMIN" as string };

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockUser }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { AuditPage } = await import("@/client/pages/AuditPage");

const ROWS = [
  {
    id: "200",
    tenantId: null,
    actorId: "1",
    actorType: "user",
    action: "agent.update",
    target: "t:1",
    before: null,
    after: { name: "Ana" },
    createdAt: "2026-09-03T12:00:00.000Z",
  },
];

const realFetch = globalThis.fetch;
let sent: string[] = [];

beforeEach(() => {
  sent = [];
  mockUser.role = "SUPER_ADMIN";
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    // A live next cursor, so the pager works and page two can be reached at all.
    return new Response(
      JSON.stringify({ entries: ROWS, nextCursor: "42", latestAt: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  setSystemTime();
});

function mount() {
  const view = render(
    <ToastProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/audit"]}>
          <AuditPage />
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

// Walks to page two, so there is a cursor to carry over in the first place. On page one the cursor
// is null and any reset looks correct: the assertion would hold against the bug.
async function toPageTwo(view: ReturnType<typeof mount>) {
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  const next = view.getByRole("button", { name: /next/i });
  act(() => {
    fireEvent.click(next);
  });
  await waitFor(() => expect(asked()).toContain("cursor=42"));
  return sent.length;
}

async function changing(
  label: RegExp,
  value: string,
): Promise<{ after: string[]; text: string }> {
  const view = mount();
  const mark = await toPageTwo(view);
  const select = (await waitFor(() =>
    view.getByLabelText(label),
  )) as HTMLSelectElement;
  act(() => {
    fireEvent.change(select, { target: { value } });
  });
  await waitFor(() => expect(sent.length).toBeGreaterThan(mark));
  return { after: sent.slice(mark), text: view.container.textContent ?? "" };
}

for (const [name, label, value] of [
  ["the door", /authenticated as/i, "mcp"],
  ["the trail", /trail/i, "fleet"],
  ["the period", /period/i, "yesterday"],
] as const) {
  test(`changing ${name} on page two makes no request carrying the old cursor`, async () => {
    const { after, text } = await changing(label, value);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((u) => u.includes("cursor="))).toEqual([]);
    expect(text).toContain("Page 1");
  });
}

// The action filter is not a <select>, it is set from a row's own action chip -- the same reset has
// to happen there, and it is the path an operator actually takes.
test("filtering by an action from the table restarts the walk too", async () => {
  const view = mount();
  const mark = await toPageTwo(view);
  const chip = await waitFor(() =>
    view.getByLabelText(/show only agent\.update/i),
  );
  act(() => {
    fireEvent.click(chip);
  });
  await waitFor(() => expect(asked()).toContain("action=agent.update"));
  expect(sent.slice(mark).filter((u) => u.includes("cursor="))).toEqual([]);
  expect(view.container.textContent).toContain("Page 1");
});
