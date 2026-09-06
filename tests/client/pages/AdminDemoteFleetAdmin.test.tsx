/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

// Demoting a FLEET administrator from the console (#534). Their row has no tenant, and the row that
// would replace it cannot exist without one, so the click is a question and not a write: the page
// has to ask which tenant before it PATCHes anything. Driven through the real page, because the
// claim is about the BRANCH — a handler that always PATCHes looks right in isolation and is what
// produced the 500 the issue reports.
//
// NOTE: every assertion reduces to a string, number or boolean BEFORE expect. A failing expectation
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "1", email: "admin@fazer.ai", role: "SUPER_ADMIN" },
    loading: false,
    logout: async () => {},
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ToastProvider } = await import("@/client/components/Toast");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { AdminUsersPage } = await import("@/client/pages/admin/AdminUsersPage");

const realFetch = globalThis.fetch;
let patches: Array<{ id: string; body: unknown }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const USERS = [
  {
    id: "10",
    email: "fleet@fazer.ai",
    name: "Fleet",
    role: "SUPER_ADMIN",
    tenantId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastLoginAt: null,
  },
  {
    id: "11",
    email: "boss@acme.test",
    name: "Boss",
    role: "TENANT_ADMIN",
    tenantId: "42",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastLoginAt: null,
  },
];

function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    const path = url.pathname;
    const rolePatch = /^\/api\/admin\/users\/(\d+)\/role$/.exec(path);
    if (method === "PATCH" && rolePatch) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      patches.push({ id: rolePatch[1] as string, body });
      return json({ user: { ...USERS[1], role: body.role } });
    }
    if (path === "/api/admin/users") {
      return json({ users: USERS, total: USERS.length, page: 1, limit: 20 });
    }
    if (path === "/api/admin/tenants") {
      return json({
        tenants: [
          {
            id: "42",
            name: "Acme",
            slug: "acme",
            userCount: 1,
            demoMode: false,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (path === "/api/admin/stats") {
      return json({
        stats: { totalUsers: 2, totalAdmins: 2, totalTenants: 1 },
      });
    }
    if (path === "/api/admin/invitations") return json({ invitations: [] });
    return json({}, 404);
  }) as typeof fetch;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <TooltipProvider>
        <ToastProvider>
          <NavGuardProvider>
            <AdminUsersPage />
          </NavGuardProvider>
        </ToastProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

async function clickDemote(email: string) {
  const row = (await screen.findByText(email)).closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByLabelText("Demote to User"));
}

beforeEach(() => {
  patches = [];
  installFetchStub();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("demoting from the users tab", () => {
  test("a fleet administrator is asked for a tenant, and the write carries it", async () => {
    mount();
    await clickDemote("fleet@fazer.ai");
    const dialog = await screen.findByRole("dialog");
    expect(patches.length).toBe(0);

    const scope = within(dialog);
    const submit = scope.getByRole("button", { name: "Demote" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(scope.getByRole("combobox"), { target: { value: "42" } });
    fireEvent.click(scope.getByRole("button", { name: "Demote" }));
    await waitFor(() => {
      expect(patches.length).toBe(1);
    });
    expect(JSON.stringify(patches[0])).toBe(
      JSON.stringify({ id: "10", body: { role: "AGENT", tenantId: "42" } }),
    );
  });

  test("a tenant administrator is demoted in one click, with no tenant named", async () => {
    mount();
    await clickDemote("boss@acme.test");
    await waitFor(() => {
      expect(patches.length).toBe(1);
    });
    expect(JSON.stringify(patches[0])).toBe(
      JSON.stringify({ id: "11", body: { role: "AGENT" } }),
    );
    expect(screen.queryAllByRole("dialog").length).toBe(0);
  });
});
