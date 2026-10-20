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
import { ChannelsTab } from "@/client/pages/agents/ChannelsTab";
import { ChannelsPage } from "@/client/pages/ChannelsPage";
import { withI18n } from "../utils/i18n";

// Binding an agent to an inbox another vendor's Agent Bot answers: the server refuses with
// `field: "replaceForeignBot"` and a sentence naming the bot, the page asks with that sentence, and
// only a confirmation sends the bind again with the flag.

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

const REFUSAL =
  'This inbox is answered by the Agent Bot "Menu antigo", which is not from this instance. Binding replaces it, and unbinding later does not bring it back.';

function serve(opts: { confirmedFails?: boolean } = {}) {
  const patches: Array<Record<string, unknown>> = [];
  let agentId: string | null = null;
  const inbox = () => ({
    id: "i1",
    name: "WhatsApp",
    agentId,
    observerAgentIds: [],
    voiceAgentId: null,
    chatwootInstanceId: "a1",
    chatwootInboxId: 100,
    channelType: "Channel::Api",
    provider: null,
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/auth/me")
      return json({
        user: { id: "u1", email: "a@b.c", role: "SUPER_ADMIN", tenantId: null },
      });
    if (path === "/api/v1/chatwoot/deployment")
      return json({
        deployment: { baseUrl: "https://chat.example.com" },
        accounts: [
          {
            id: "a1",
            accountId: 1,
            accountName: "Conta",
            disconnectedAt: null,
          },
        ],
      });
    if (path === "/api/v1/chatwoot/inboxes" && method === "GET")
      return json({ inboxes: [inbox()] });
    if (path === "/api/v1/chatwoot/inboxes/bot-status")
      return json({ statuses: {}, observerStatuses: {} });
    if (path === "/api/v1/agents")
      return json({
        agents: [
          {
            id: "p1",
            name: "Atendente",
            mode: "production",
            enabled: true,
            kind: "text",
          },
        ],
        total: 1,
      });
    if (path === "/api/v1/chatwoot/inboxes/i1" && method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      patches.push(body);
      if (body.replaceForeignBot !== true)
        return json({ error: REFUSAL, field: "replaceForeignBot" }, 409);
      if (opts.confirmedFails)
        return json({ error: "could not sync the bot with Chatwoot" }, 502);
      agentId = body.agentId;
      return json({ inbox: inbox() });
    }
    if (path.endsWith("/sync-inboxes")) return json({ result: { created: 0 } });
    return json({});
  }) as unknown as typeof fetch;
  return patches;
}

function renderPage() {
  render(
    withI18n(
      <MemoryRouter>
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <TooltipPrimitive.Provider>
                <ChannelsPage />
              </TooltipPrimitive.Provider>
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>,
    ),
  );
}

async function pickAtendente() {
  const picker = await screen.findByRole("button", { name: "Answering agent" });
  fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Atendente" }));
}

describe("binding an inbox another vendor's bot answers, on the Channels page", () => {
  test("asks with the server's sentence and binds only after the confirmation", async () => {
    const patches = serve();
    renderPage();
    await pickAtendente();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(REFUSAL);
    expect(patches).toEqual([{ agentId: "p1" }]);

    fireEvent.click(screen.getByRole("button", { name: "Replace bot" }));
    await waitFor(() =>
      expect(patches.at(-1)).toEqual({
        agentId: "p1",
        replaceForeignBot: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Answering agent" }).textContent,
      ).toContain("Atendente"),
    );
  });

  test("cancelling sends nothing more and keeps the inbox unbound", async () => {
    const patches = serve();
    renderPage();
    await pickAtendente();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(patches).toEqual([{ agentId: "p1" }]);
    expect(
      screen.getByRole("button", { name: "Answering agent" }).textContent,
    ).not.toContain("Atendente");
  });
});

describe("binding an inbox another vendor's bot answers, on the agent's Channels tab", () => {
  test("a confirmed bind that fails keeps the dialog open to retry", async () => {
    const patches = serve({ confirmedFails: true });
    render(
      withI18n(
        <MemoryRouter>
          <ToastProvider>
            <TooltipPrimitive.Provider>
              <ChannelsTab
                agentId="p1"
                agentName="Atendente"
                mode="production"
              />
            </TooltipPrimitive.Provider>
          </ToastProvider>
        </MemoryRouter>,
      ),
    );
    const [sw] = await screen.findAllByRole("switch");
    fireEvent.click(sw as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(REFUSAL);

    fireEvent.click(screen.getByRole("button", { name: "Replace bot" }));
    await waitFor(() =>
      expect(patches.at(-1)).toEqual({
        agentId: "p1",
        replaceForeignBot: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Replace bot" }),
      ).not.toBeDisabled(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(patches).toHaveLength(2);
  });
});
