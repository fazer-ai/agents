/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter } from "react-router";

// THE REFUSAL THAT REACHES THE INPUT IT NAMES, ON THE FORMS THAT WRITE.
//
// #232 built the mechanism and wired one card as the reference. This file holds the sweep's own
// proof, on the screen the defect was MEASURED on: creating a second MCP connection under a name
// already taken answers 409 "mcp connection name already in use", and the modal answered "Could not
// save (check the URL/command)" — the wrong input, named confidently (#329).
//
// Both halves are asserted, because the rule is that exactly one channel fires: the sentence lands
// at the control the server named, and the form's own error line stays empty. A message rendered at
// the input AND repeated in the banner is the noise that teaches people to stop reading either.

const { McpEditModal } = await import("@/client/pages/resources/McpEditModal");
const { ToastProvider, useModalController } = await import(
  "@/client/components"
);
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// Everything the tree needs to render answers 200; the one write under test answers the refusal.
function refusing(body: { error: string; field?: string }, status = 409) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.includes("/api/v1/mcp-connections")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/auth/me")) {
      return new Response(
        JSON.stringify({
          user: { id: "1", email: "a@b.co", role: "TENANT_ADMIN", name: "A" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function OpenMcpModal() {
  const modal = useModalController<{ id?: string }>();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open({});
  }, [modal]);
  return (
    <McpEditModal
      modal={modal as unknown as Parameters<typeof McpEditModal>[0]["modal"]}
    />
  );
}

function mount() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <OpenMcpModal />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

async function fillAndSave(name: string, url: string) {
  const nameBox = await screen.findByRole("textbox", { name: /name|nome/i });
  fireEvent.change(nameBox, { target: { value: name } });
  const urlBox = screen.getByRole("textbox", { name: /url/i });
  fireEvent.change(urlBox, { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));
}

// The field the sentence was rendered INTO, by the input that shares its FormField. Asserting only
// that the text is on screen somewhere passes with the sentence sitting in the banner, which is the
// state this whole sweep is replacing.
function fieldShowing(text: string): HTMLElement | null {
  for (const node of screen.queryAllByText(text)) {
    const field = node.closest("label, [role='group']");
    const control = field?.querySelector("input, select, textarea");
    if (control) return control as HTMLElement;
  }
  return null;
}

test("a name already taken marks the name input, not the URL", async () => {
  const reason = "mcp connection name already in use";
  refusing({ error: reason, field: "name" });
  mount();
  await fillAndSave("Servidor Alfa", "https://mcp.example.com/sse");

  await waitFor(() => {
    expect(fieldShowing(reason)).not.toBeNull();
  });
  // AT the name, and nowhere else: the control the sentence renders under is the one holding the
  // value the server refused.
  expect((fieldShowing(reason) as HTMLInputElement).value).toBe(
    "Servidor Alfa",
  );
  // The sentence the operator was being sent to the wrong input by.
  expect(
    screen.queryAllByText(/check the URL\/command|URL\/comando/i).length,
  ).toBe(0);
});

test("a refusal about no input at all still reaches the operator", async () => {
  // The other direction: a refusal the form has no control for must not be swallowed by the
  // mechanism that places the ones it does. Silence is what a scheme like this breaks first.
  const reason = "this tenant cannot create more MCP connections";
  refusing({ error: reason });
  mount();
  await fillAndSave("Servidor Beta", "https://mcp.example.com/sse");

  await waitFor(() => {
    expect(screen.queryAllByText(reason).length).toBeGreaterThan(0);
  });
});
