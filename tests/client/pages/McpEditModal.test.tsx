/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider, useModalController } from "@/client/components";
import { AuthContext } from "@/client/contexts/AuthContext";
import { invalidateVault } from "@/client/lib/vaultCache";
import { McpEditModal } from "@/client/pages/resources/McpEditModal";

const SERVER_URL = "https://mcp.example.com/sse";
const CREDENTIAL_URL = "https://credential.example/mcp";

const realFetch = globalThis.fetch;
// The vault list is cached per process, and a file that ran before this one can leave a request in
// flight that never answers: every test starts from an empty cache.
beforeEach(() => {
  invalidateVault();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  invalidateVault();
});

// A stored HTTP connection whose credential is one vault entry of `kind`, holding a base URL.
async function openStored(kind: string) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    if (path === "/api/v1/mcp-connections/1") {
      return json({
        connection: {
          id: "1",
          name: "docs",
          transport: "streamableHttp",
          url: SERVER_URL,
          command: null,
          credentialRef: "vault:5",
          headers: {},
          enabled: true,
        },
      });
    }
    if (path === "/api/v1/vault") {
      return json({
        entries: [
          { id: "5", name: `key-${kind}`, kind, baseUrl: CREDENTIAL_URL },
        ],
      });
    }
    return json({ items: [], entries: [] });
  }) as unknown as typeof fetch;
  function Harness() {
    const modal = useModalController<{ id?: string }>();
    const opened = useRef(false);
    useEffect(() => {
      if (opened.current) return;
      opened.current = true;
      modal.open({ id: "1" });
    }, [modal]);
    return <McpEditModal modal={modal as never} />;
  }
  render(
    <MemoryRouter>
      <AuthContext.Provider value={{ mcpStdioEnabled: false } as never}>
        <ToastProvider>
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </ToastProvider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  await screen.findByText(`key-${kind}`);
}

// What the URL field shows, and whether the operator can still type in it.
function urlField(): { value: string; locked: boolean } {
  const input = screen.getByPlaceholderText(
    "https://mcp.example.com/sse",
  ) as HTMLInputElement;
  return { value: input.value, locked: input.disabled };
}

// The credential's base LOCKS the connection URL and fills it. A base stored on a kind that takes
// none is never dialled, so locking the field to it would show an endpoint the runtime ignores and
// let Save pass with the real URL hidden.
describe("the connection URL and the credential's base", () => {
  test("a kind that carries a base URL locks the field to it", async () => {
    await openStored("bearer_token");
    expect(urlField()).toEqual({ value: CREDENTIAL_URL, locked: true });
  });

  test("a base URL on a kind that cannot carry one leaves the server's own URL editable", async () => {
    await openStored("openai");
    expect(urlField()).toEqual({ value: SERVER_URL, locked: false });
  });
});
