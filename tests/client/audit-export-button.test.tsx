/// <reference lib="dom" />

// The export is quoted to a customer or an auditor, so the failure worth designing against is a
// correct CSV of rows the operator was not looking at. The assertions are about the REQUEST: every
// applied filter, the scope, and no cursor. The server owns bounding and serialization.
// Truncation has its own test: an export that was cut and says nothing is a wrong answer.

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

const mockUser = { role: "TENANT_ADMIN" as string };

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockUser }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const clicked: { href: string; download: string }[] = [];

const { AuditPage } = await import("@/client/pages/AuditPage");

// One row and a next cursor, so the pager is live and the walk this file needs can happen at all.
const LIST_ROWS = [
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
const realCreateObjectURL = globalThis.URL.createObjectURL;
const realRevokeObjectURL = globalThis.URL.revokeObjectURL;
// Undo callbacks for the globals each test patches, drained in `afterEach`.
const restore: (() => void)[] = [];
let sent: string[] = [];
let dump = {
  filename: "agents-audit-2026-09-03T12-00-00.csv",
  contentType: "text/csv;charset=utf-8",
  content: "id,created_at\r\n1,2026-09-03T12:00:00.000Z",
  count: 1,
  truncated: false,
  truncatedBy: null as string | null,
};

beforeEach(() => {
  sent = [];
  clicked.length = 0;
  mockUser.role = "TENANT_ADMIN";
  dump = { ...dump, count: 1, truncated: false, truncatedBy: null };
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    sent.push(url);
    const body = url.includes("/audit/export")
      ? dump
      : { entries: LIST_ROWS, nextCursor: "115", latestAt: null };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  // NOTE: the download is a DOM gesture: capture the anchor rather than let happy-dom navigate.
  // Restored in `afterEach` because these are GLOBALS and Bun runs a worker's files in one process:
  // a `document.createElement` left patched answers for every suite sharing the worker.
  globalThis.URL.createObjectURL = () => "blob:stub";
  globalThis.URL.revokeObjectURL = () => {};
  const realCreate = document.createElement.bind(document);
  restore.push(() => {
    document.createElement = realCreate;
    globalThis.URL.createObjectURL = realCreateObjectURL;
    globalThis.URL.revokeObjectURL = realRevokeObjectURL;
  });
  document.createElement = ((tag: string) => {
    const el = realCreate(tag) as HTMLElement;
    if (tag === "a") {
      el.click = () => {
        clicked.push({
          href: (el as HTMLAnchorElement).href,
          download: (el as HTMLAnchorElement).download,
        });
      };
    }
    return el;
  }) as typeof document.createElement;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  for (const undo of restore.splice(0)) undo();
  setSystemTime();
});

function mount(url: string) {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[url]}>
          <AuditPage />
        </MemoryRouter>
      </TooltipProvider>
    </ToastProvider>,
  );
}

// The real provider, with the toast read off the screen. A `mock.module` of
// `@/client/components/Toast` is installed for the WHOLE WORKER and outlives `afterAll` for files
// that reach `useToast` through the components barrel. Radix renders each toast as an `<li>`.
const toastText = () =>
  Array.from(document.querySelectorAll("li[data-state]"))
    .map((el) => el.textContent ?? "")
    .join(" | ");
const toastCount = () => document.querySelectorAll("li[data-state]").length;

const exportAsked = () =>
  sent.filter((u) => u.includes("/audit/export")).at(-1) ?? "";
const listAsked = () =>
  sent.filter((u) => !u.includes("/audit/export")).at(-1) ?? "";

async function clickExport(view: ReturnType<typeof mount>) {
  const btn = await waitFor(() =>
    view.getByRole("button", { name: /export/i }),
  );
  await act(async () => {
    fireEvent.click(btn);
  });
  await waitFor(() => expect(exportAsked()).not.toBe(""));
}

test("the button is on the page and downloads the server's file under its own name", async () => {
  const view = mount("/audit");
  await clickExport(view);
  expect(clicked).toHaveLength(1);
  expect(clicked[0]?.download).toBe("agents-audit-2026-09-03T12-00-00.csv");
});

// From page three: on page one the cursor is null, so an export that forwarded the page's position
// would send nothing and still pass. The walk has to happen before the question is worth asking.
test("every applied filter reaches the export, and the page's position does not", async () => {
  const view = mount(
    "/audit?action=agent.update&actorType=mcp&from=2026-08-01&to=2026-08-31",
  );
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  const next = view.getByRole("button", { name: /next/i });
  for (const _step of [1, 2]) {
    await act(async () => {
      fireEvent.click(next);
    });
  }
  await waitFor(() => expect(listAsked()).toContain("cursor="));

  await clickExport(view);
  const q = new URLSearchParams(exportAsked().split("?")[1] ?? "");
  expect(q.get("action")).toBe("agent.update");
  expect(q.get("actorType")).toBe("mcp");
  expect(q.get("since")).toBeTruthy();
  expect(q.get("until")).toBeTruthy();
  // A cursor would start the dump halfway down the trail, under a filename that claims the filter.
  expect(q.get("cursor")).toBeNull();
});

test("an unfiltered trail exports with no filter, rather than with today's", async () => {
  const view = mount("/audit");
  await clickExport(view);
  const q = new URLSearchParams(exportAsked().split("?")[1] ?? "");
  expect([...q.keys()].filter((k) => k !== "scope")).toEqual([]);
});

test("the scope travels with it", async () => {
  mockUser.role = "SUPER_ADMIN";
  const view = mount("/audit?scope=fleet");
  await clickExport(view);
  expect(exportAsked()).toContain("scope=fleet");
});

test("a scope the operator cannot use is not exported either", async () => {
  const view = mount("/audit?scope=all");
  await clickExport(view);
  expect(exportAsked()).not.toContain("scope=");
});

test("a truncated export says so, and says how many it kept", async () => {
  dump = { ...dump, count: 500, truncated: true, truncatedBy: "bytes" };
  const view = mount("/audit");
  await clickExport(view);
  await waitFor(() => expect(toastCount()).toBeGreaterThan(0));
  // The count is IN the sentence: "we cut it" without saying where to is a warning the operator
  // cannot act on.
  expect(toastText()).toContain("500");
});

// A cut that kept nothing is not an empty match. When the newest matching row alone exceeds the
// byte ceiling the server answers `count: 0, truncated: true`; reading only the count would tell
// the operator nothing happened in the period they audit.
test("a cut that kept nothing is not reported as an empty match", async () => {
  dump = {
    ...dump,
    count: 0,
    content: "id,created_at",
    truncated: true,
    truncatedBy: "bytes",
  };
  const view = mount("/audit");
  await clickExport(view);
  await waitFor(() => expect(toastCount()).toBeGreaterThan(0));
  expect(clicked).toHaveLength(0);
  expect(toastText().toLowerCase()).not.toContain("nothing to export");
  expect(toastText().toLowerCase()).toContain("too large");
});

test("an empty match downloads nothing and says nothing matched", async () => {
  dump = { ...dump, count: 0, content: "id,created_at" };
  const view = mount("/audit");
  await clickExport(view);
  await waitFor(() => expect(toastCount()).toBeGreaterThan(0));
  expect(clicked).toHaveLength(0);
  expect(toastText().toLowerCase()).toContain("nothing to export");
});
