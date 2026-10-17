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
import { ChannelsPage } from "@/client/pages/ChannelsPage";
import { WHATSAPP_CHANNEL } from "@/modules/voice-call/channel";
import { withI18n } from "../utils/i18n";

// The calls picker on a WhatsApp inbox. A binding the server saved but could not carry to Chatwoot
// answers 502: the page reads the inbox list again, so the picker shows what is stored and the
// previous agent can be picked to put it back.

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

const AGENTS = [
  {
    id: "p1",
    name: "Atendente",
    mode: "production",
    enabled: true,
    kind: "text",
  },
  {
    id: "v1",
    name: "Voz antiga",
    mode: "production",
    enabled: true,
    kind: "voice",
  },
  {
    id: "v2",
    name: "Voz nova",
    mode: "production",
    enabled: true,
    kind: "voice",
  },
];

function serve() {
  // What the server holds: the PUT saves before it reaches Chatwoot.
  let voiceAgentId: string | null = "v1";
  const reads: string[] = [];
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
    if (path === "/api/v1/chatwoot/inboxes" && method === "GET") {
      reads.push(voiceAgentId ?? "none");
      return json({
        inboxes: [
          {
            id: "i1",
            name: "WhatsApp",
            agentId: "p1",
            observerAgentIds: [],
            voiceAgentId,
            chatwootInstanceId: "a1",
            chatwootInboxId: 100,
            channelType: WHATSAPP_CHANNEL,
          },
        ],
      });
    }
    if (path === "/api/v1/chatwoot/inboxes/bot-status")
      return json({ statuses: {}, observerStatuses: {} });
    if (path === "/api/v1/agents")
      return json({ agents: AGENTS, total: AGENTS.length });
    if (
      path === "/api/v1/chatwoot/inboxes/i1/voice-agent" &&
      method === "PUT"
    ) {
      voiceAgentId = JSON.parse(String(init?.body)).agentId;
      return json({ error: "Chatwoot is down" }, 502);
    }
    if (path.endsWith("/sync-inboxes")) return json({ result: { created: 0 } });
    return json({});
  }) as unknown as typeof fetch;
  return reads;
}

describe("the calls picker on the Channels page", () => {
  test("a binding that saved but missed Chatwoot shows what is stored", async () => {
    const reads = serve();
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
    const picker = await screen.findByRole("button", { name: "Calls agent" });
    expect(picker.textContent).toContain("Voz antiga");
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Voz nova" }));
    await waitFor(() => expect(reads.at(-1)).toBe("v2"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Calls agent" }).textContent,
      ).toContain("Voz nova"),
    );
  });
});
