/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { AuthProvider } from "@/client/contexts/AuthContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { AgentsPage } from "@/client/pages/AgentsPage";
import { withI18n } from "../utils/i18n";

// The create modal offers no choice of kind: the agent it creates answers messages.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function serve() {
  const created: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/auth/me")
      return json({
        user: { id: "u1", email: "a@b.c", role: "ADMIN", tenantId: "t1" },
      });
    if (path === "/api/v1/agents" && method === "POST") {
      created.push(JSON.parse(String(init?.body)));
      return json({ agent: { id: "new1" } });
    }
    if (path === "/api/v1/agents") return json({ agents: [], total: 0 });
    return json({});
  }) as unknown as typeof fetch;
  return created;
}

describe("the create-agent modal", () => {
  test("offers no kind and creates a text agent", async () => {
    const created = serve();
    render(
      withI18n(
        <MemoryRouter>
          <ThemeProvider>
            <AuthProvider>
              <ToastProvider>
                <TooltipPrimitive.Provider>
                  <AgentsPage />
                </TooltipPrimitive.Provider>
              </ToastProvider>
            </AuthProvider>
          </ThemeProvider>
        </MemoryRouter>,
      ),
    );
    const [open] = await screen.findAllByRole("button", { name: /New agent/ });
    fireEvent.click(open as HTMLElement);
    const dialog = await screen.findByRole("dialog");

    expect(dialog.querySelector('[data-testid="kind-voice"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="kind-text"]')).toBeNull();
    expect(dialog.textContent).not.toContain("WhatsApp calls");

    const name = dialog.querySelector("input") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Atendente" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({ name: "Atendente", kind: "text" });
  });
});
