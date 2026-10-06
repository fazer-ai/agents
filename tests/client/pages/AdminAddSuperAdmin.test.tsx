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

// "Add super admin" on the users tab: shown only to a fleet administrator, in two steps. The email
// first; then a confirmation that says what will happen (promote now, or a one-time link) and takes
// the ACTING admin's password, so that password is never read as the other person's.
//
// Every assertion reduces to a string, number or boolean BEFORE expect: a failing expectation
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.
let role = "SUPER_ADMIN";
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "1", email: "admin@fazer.ai", role },
    loading: false,
    logout: async () => {},
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ToastProvider } = await import("@/client/components/Toast");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { AdminUsersPage } = await import("@/client/pages/admin/AdminUsersPage");

const realFetch = globalThis.fetch;
let posts: unknown[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };
let listed: Array<{ email: string; role: string; unproved?: boolean }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    const path = url.pathname;
    if (method === "POST" && path === "/api/admin/super-admins") {
      posts.push(init?.body ? JSON.parse(String(init.body)) : {});
      return json(answer.body, answer.status);
    }
    if (path === "/api/admin/super-admins/preview") {
      const q = (url.searchParams.get("email") ?? "").toLowerCase();
      const hit = listed.find((u) => u.email === q);
      return json({
        outcome: !hit
          ? "invite"
          : hit.role === "SUPER_ADMIN"
            ? "already"
            : hit.unproved
              ? "verify"
              : "promote",
      });
    }
    if (path === "/api/admin/users") {
      return json({ users: [], total: 0, page: 1, totalPages: 1 });
    }
    if (path === "/api/admin/tenants") return json({ tenants: [] });
    if (path === "/api/admin/stats") {
      return json({ stats: { totalUsers: 0, adminCount: 0 } });
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

async function enterEmail(email: string) {
  fireEvent.click(
    await screen.findByRole("button", { name: "Add super admin" }),
  );
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Email of the person"), {
    target: { value: email },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
  return dialog;
}

async function confirm(
  dialog: ReturnType<typeof within>,
  action: string,
  password: string,
) {
  fireEvent.change(await dialog.findByLabelText("Confirm with your password"), {
    target: { value: password },
  });
  fireEvent.click(dialog.getByRole("button", { name: action }));
  await waitFor(() => {
    expect(posts.length).toBe(1);
  });
}

beforeEach(() => {
  role = "SUPER_ADMIN";
  posts = [];
  listed = [];
  installFetchStub();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("adding a super admin from the users tab", () => {
  test("a tenant administrator is not offered the action", async () => {
    role = "TENANT_ADMIN";
    mount();
    await screen.findByRole("button", { name: "Invite user" });
    expect(
      screen.queryAllByRole("button", { name: "Add super admin" }).length,
    ).toBe(0);
  });

  test("an existing account: the confirmation says it is promoted now, and the write carries email and password", async () => {
    listed = [{ email: "maria@acme.test", role: "TENANT_ADMIN" }];
    answer = {
      status: 200,
      body: {
        result: "promoted",
        user: { id: "7", email: "maria@acme.test", name: null },
      },
    };
    mount();
    const dialog = await enterEmail(" Maria@acme.test ");
    await dialog.findByText(/maria@acme.test already has an account/);
    expect(posts.length).toBe(0);
    expect(
      (
        (await dialog.findByLabelText(
          "Confirm with your password",
        )) as HTMLInputElement
      ).autocomplete,
    ).toBe("current-password");
    await confirm(dialog, "Promote now", "s3cret-pass");
    expect(JSON.stringify(posts[0])).toBe(
      JSON.stringify({ email: "maria@acme.test", password: "s3cret-pass" }),
    );
    await dialog.findByText(/maria@acme.test is now a super admin/);
  });

  test("an email with no account: the confirmation says a link is coming, then shows it", async () => {
    listed = [{ email: "other-new@acme.test", role: "AGENT" }];
    answer = {
      status: 200,
      body: {
        result: "invited",
        invite: {
          id: "3",
          email: "new@acme.test",
          acceptUrl: "http://localhost/accept-invite?token=abc",
          expiresAt: "2026-10-06T00:00:00.000Z",
        },
      },
    };
    mount();
    const dialog = await enterEmail("new@acme.test");
    await dialog.findByText(/new@acme.test has no account yet/);
    await confirm(dialog, "Create invitation", "s3cret-pass");
    const link = await dialog.findByText(
      "http://localhost/accept-invite?token=abc",
    );
    expect(link.textContent).toBe("http://localhost/accept-invite?token=abc");
  });

  test("someone already a super admin is stopped at the email, before any password", async () => {
    listed = [{ email: "boss@acme.test", role: "SUPER_ADMIN" }];
    mount();
    const dialog = await enterEmail("boss@acme.test");
    await dialog.findByText("boss@acme.test is already a super admin.");
    expect(
      dialog.queryAllByLabelText("Confirm with your password").length,
    ).toBe(0);
    expect(posts.length).toBe(0);
  });

  test("a wrong password keeps the confirmation open and says so", async () => {
    answer = { status: 403, body: { error: "Incorrect password" } };
    mount();
    const dialog = await enterEmail("maria@acme.test");
    await confirm(dialog, "Create invitation", "wrong");
    await dialog.findByText("Incorrect password");
    expect(
      dialog.queryAllByLabelText("Confirm with your password").length,
    ).toBe(1);
  });

  test("an account nothing proved (open signup): the confirmation says a link is coming, not a promotion", async () => {
    listed = [{ email: "maybe@acme.test", role: "AGENT", unproved: true }];
    mount();
    const dialog = await enterEmail("maybe@acme.test");
    await dialog.findByText(/nothing proved that address belongs/);
    expect(
      dialog.queryAllByRole("button", { name: "Promote now" }).length,
    ).toBe(0);
    expect(
      dialog.queryAllByRole("button", { name: "Create invitation" }).length,
    ).toBe(1);
  });
});
