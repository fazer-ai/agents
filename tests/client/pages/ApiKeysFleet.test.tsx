/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
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

// The API keys page shows the FLEET list to a SUPER_ADMIN and to nobody else, and minting a fleet
// key sends the password the route demands (issue #308).
//
// The role is what decides, and it decides on the client before any request: a TENANT_ADMIN never
// asks for `/api-keys/fleet` (the route would answer 403, and a section that renders an error box
// for a list the operator cannot have is a page announcing a scope it does not hold).
//
// NOTE: `mock.module` is global to the worker, so the auth stub is declared here with the role the
// page reads; the role is swapped per test through `currentRole`. Dynamic imports below for the
// same reason: a static import evaluates before the mock.

let currentRole = "SUPER_ADMIN";
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "1", email: "admin@fazer.ai", role: currentRole },
    loading: false,
    logout: async () => {},
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ToastProvider } = await import("@/client/components/Toast");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { ApiKeysPage } = await import("@/client/pages/ApiKeysPage");

const realFetch = globalThis.fetch;
const requests: Array<{ method: string; path: string; body: unknown }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function installFetchStub() {
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    const path = url.pathname;
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    if (method === "GET" && path === "/api/v1/api-keys") {
      // One key that predates the password rule: no step-up on record.
      return json({
        apiKeys: [
          {
            id: "3",
            displayName: "old integration",
            keyPrefix: "fazerai_old123",
            role: "TENANT_ADMIN",
            lastUsedAt: null,
            revokedAt: null,
            stepUpAt: null,
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/v1/api-keys/fleet") {
      return json({
        apiKeys: [
          {
            id: "7",
            displayName: "provisioner",
            keyPrefix: "fazerai_abc123",
            role: "SUPER_ADMIN",
            lastUsedAt: null,
            revokedAt: null,
            stepUpAt: "2026-09-01T00:00:00.000Z",
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (method === "POST" && path === "/api/v1/api-keys") {
      return json({
        apiKey: {
          id: "9",
          displayName: body?.displayName,
          keyPrefix: "fazerai_ten123",
          role: "TENANT_ADMIN",
          lastUsedAt: null,
          revokedAt: null,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        token: "fazerai_ten123-plaintext",
      });
    }
    if (method === "POST" && path === "/api/v1/api-keys/fleet") {
      return json({
        apiKey: {
          id: "8",
          displayName: body?.displayName,
          keyPrefix: "fazerai_new123",
          role: "SUPER_ADMIN",
          lastUsedAt: null,
          revokedAt: null,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        token: "fazerai_new123-plaintext",
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/api-keys"]}>
      <ToastProvider>
        <NavGuardProvider>
          <ApiKeysPage />
        </NavGuardProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("the fleet keys section", () => {
  // Review round 3: a key minted before the password rule has no step-up on record and keeps
  // answering with its creator's password. The list says so, because rotating it is the only way to
  // get a key that answers by itself, and nothing else on the page would tell the operator which.
  test("a key minted before the rule is marked in the list; one minted under it is not", async () => {
    currentRole = "SUPER_ADMIN";
    installFetchStub();
    renderPage();
    await waitFor(() => {
      expect(screen.queryByText("provisioner") !== null).toBe(true);
      expect(screen.queryByText("old integration") !== null).toBe(true);
    });
    const mark = "Asks the creator's password";
    const tenant = screen.getByTestId("api-keys-tenant");
    const fleet = screen.getByTestId("api-keys-fleet");
    expect(within(tenant).queryByText(mark) !== null).toBe(true);
    expect(within(fleet).queryByText(mark) === null).toBe(true);
  });

  test("a SUPER_ADMIN sees the fleet list, read from the fleet route", async () => {
    currentRole = "SUPER_ADMIN";
    installFetchStub();
    renderPage();
    await waitFor(() => {
      expect(screen.queryByText("provisioner") !== null).toBe(true);
    });
    expect(screen.queryByTestId("api-keys-fleet") !== null).toBe(true);
    expect(
      requests.some(
        (r) => r.method === "GET" && r.path === "/api/v1/api-keys/fleet",
      ),
    ).toBe(true);
  });

  test("a TENANT_ADMIN sees no fleet section and never asks for the fleet route", async () => {
    currentRole = "TENANT_ADMIN";
    installFetchStub();
    renderPage();
    await waitFor(() => {
      expect(
        requests.some(
          (r) => r.method === "GET" && r.path === "/api/v1/api-keys",
        ),
      ).toBe(true);
    });
    expect(screen.queryByTestId("api-keys-fleet") === null).toBe(true);
    expect(requests.some((r) => r.path === "/api/v1/api-keys/fleet")).toBe(
      false,
    );
  });

  // Round 1 of the review: the tenant key answers every later step-up by itself, so the session
  // that mints it answers the password here.
  test("minting a tenant key sends the password too", async () => {
    currentRole = "TENANT_ADMIN";
    installFetchStub();
    renderPage();
    await waitFor(() => {
      expect(
        requests.some(
          (r) => r.method === "GET" && r.path === "/api/v1/api-keys",
        ),
      ).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    const dialog = await screen.findByRole("dialog");
    const inputs = dialog.querySelectorAll("input");
    expect(inputs.length).toBe(2);
    fireEvent.change(inputs[0] as HTMLInputElement, {
      target: { value: "tenant bot" },
    });
    fireEvent.change(inputs[1] as HTMLInputElement, {
      target: { value: "hunter2" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create key" }));
    await waitFor(() => {
      expect(screen.queryByText("fazerai_ten123-plaintext") !== null).toBe(
        true,
      );
    });
    const posted = requests.find(
      (r) => r.method === "POST" && r.path === "/api/v1/api-keys",
    );
    expect(posted?.body).toEqual({
      displayName: "tenant bot",
      password: "hunter2",
    });
  });

  test("minting a fleet key sends the name and the password, and reveals the token once", async () => {
    currentRole = "SUPER_ADMIN";
    installFetchStub();
    renderPage();
    await waitFor(() => {
      expect(screen.queryByText("provisioner") !== null).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Create fleet key" }));
    const dialog = await screen.findByRole("dialog");
    const inputs = dialog.querySelectorAll("input");
    const name = inputs[0] as HTMLInputElement;
    const password = inputs[1] as HTMLInputElement;
    expect(password.type).toBe("password");
    const submit = screen.getByRole("button", { name: "Create key" });
    // Name alone is not enough: the button stays disabled until the password is typed.
    fireEvent.change(name, { target: { value: "deploy bot" } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(password, { target: { value: "hunter2" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.queryByText("fazerai_new123-plaintext") !== null).toBe(
        true,
      );
    });
    const posted = requests.find(
      (r) => r.method === "POST" && r.path === "/api/v1/api-keys/fleet",
    );
    expect(posted?.body).toEqual({
      displayName: "deploy bot",
      password: "hunter2",
    });
  });
});
