/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { AuthProvider } from "@/client/contexts/AuthContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { ChannelsTab } from "@/client/pages/agents/ChannelsTab";
import { ChannelsPage } from "@/client/pages/ChannelsPage";
import { withI18n } from "../utils/i18n";

// The Channels tab of a watcher. The role an agent has on an inbox is a property of the INBOX ROW,
// not of the mode: an inbox can carry a monitoring agent as its responder (the state a mode change
// on a bound agent leaves, which docs/chatwoot.md keeps). Rendered against a stubbed Chatwoot API,
// with every write recorded.

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

type Inbox = {
  id: string;
  name: string;
  agentId: string | null;
  observerAgentIds: string[];
};

interface Api {
  writes: string[];
  // What an observe answers, per inbox: the roles the server ended up with.
  observeAnswer: (inboxId: string) => {
    agentId: string | null;
    observerAgentIds: string[];
  };
  unobserveFails: boolean;
}

const AGENTS = [
  { id: "w1", name: "Vigia", mode: "monitoring", enabled: true },
  { id: "w2", name: "Outro vigia", mode: "monitoring", enabled: true },
  { id: "p1", name: "Atendente", mode: "production", enabled: true },
];

function serveChannels(
  inboxes: Inbox[],
  opts: {
    disconnected?: boolean;
    statuses?: Record<string, "active" | "missing">;
    observerStatuses?: Record<string, "active" | "missing">;
  } = {},
): Api {
  const api: Api = {
    writes: [],
    observeAnswer: (inboxId) => {
      const ib = inboxes.find((i) => i.id === inboxId) as Inbox;
      return {
        agentId: ib.agentId,
        observerAgentIds: [...ib.observerAgentIds, "w1"],
      };
    },
    unobserveFails: false,
  };
  const rows = inboxes.map((ib, i) => ({
    ...ib,
    chatwootInstanceId: "a1",
    chatwootInboxId: 100 + i,
    channelType: "Channel::Api",
  }));
  const dto = (
    inboxId: string,
    roles: { agentId: string | null; observerAgentIds: string[] },
  ) => ({
    inbox: { ...(rows.find((r) => r.id === inboxId) ?? {}), ...roles },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") api.writes.push(`${method} ${path}`);
    if (path === "/api/auth/me") {
      return json({
        user: { id: "u1", email: "a@b.c", role: "SUPER_ADMIN", tenantId: null },
      });
    }
    if (path === "/api/v1/chatwoot/deployment" && method === "GET") {
      return json({
        deployment: { baseUrl: "https://chat.example.com" },
        accounts: [
          {
            id: "a1",
            accountId: 1,
            accountName: "Conta",
            disconnectedAt: opts.disconnected
              ? "2026-01-01T00:00:00.000Z"
              : null,
          },
        ],
      });
    }
    if (path === "/api/v1/chatwoot/inboxes" && method === "GET") {
      return json({ inboxes: rows });
    }
    if (path === "/api/v1/chatwoot/inboxes/bot-status") {
      return json({
        statuses: opts.statuses ?? {},
        observerStatuses: opts.observerStatuses ?? {},
      });
    }
    if (path === "/api/v1/agents") {
      return json({ agents: AGENTS, total: AGENTS.length });
    }
    const observe = /^\/api\/v1\/chatwoot\/inboxes\/([^/]+)\/observers$/.exec(
      path,
    );
    if (observe && method === "POST") {
      return json(
        dto(observe[1] as string, api.observeAnswer(observe[1] as string)),
      );
    }
    const unobserve =
      /^\/api\/v1\/chatwoot\/inboxes\/([^/]+)\/observers\/([^/]+)$/.exec(path);
    if (unobserve && method === "DELETE") {
      if (api.unobserveFails) return json({ error: "Chatwoot is down" }, 502);
      const ib = inboxes.find((i) => i.id === unobserve[1]) as Inbox;
      return json(
        dto(ib.id, {
          agentId: ib.agentId,
          observerAgentIds: ib.observerAgentIds.filter(
            (a) => a !== unobserve[2],
          ),
        }),
      );
    }
    if (path.endsWith("/sync-inboxes")) return json({ result: { created: 0 } });
    if (method === "PATCH" || method === "POST") return json({ ok: true });
    return json({});
  }) as unknown as typeof fetch;
  return api;
}

async function renderTab(mode: "monitoring" | "production" = "monitoring") {
  render(
    withI18n(
      <MemoryRouter>
        <ToastProvider>
          <TooltipPrimitive.Provider>
            <ChannelsTab agentId="w1" agentName="Vigia" mode={mode} />
          </TooltipPrimitive.Provider>
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
  await screen.findAllByRole("switch");
}

// The row's switch, by the inbox name its label carries, as primitives.
function row(name: string) {
  const sw = screen
    .getAllByRole("switch")
    .find((s) => (s.getAttribute("aria-label") ?? "").includes(name));
  if (!sw) throw new Error(`no switch for ${name}`);
  return {
    sw,
    checked: sw.getAttribute("aria-checked") === "true",
    label: sw.getAttribute("aria-label") ?? "",
    disabled: sw.hasAttribute("disabled"),
  };
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest("li") as HTMLElement;
}

describe("the Channels tab of a watcher", () => {
  test("reads both roles off the inbox row", async () => {
    const api = serveChannels([
      // A monitoring agent left as the responder by a mode change.
      { id: "i1", name: "Responde", agentId: "w1", observerAgentIds: [] },
      { id: "i2", name: "Observa", agentId: null, observerAgentIds: ["w1"] },
      { id: "i3", name: "Nenhum", agentId: null, observerAgentIds: [] },
      { id: "i4", name: "Ambos", agentId: "w1", observerAgentIds: ["w1"] },
    ]);
    await renderTab();
    expect(
      ["Responde", "Observa", "Nenhum", "Ambos"].map((n) => row(n).checked),
    ).toEqual([true, true, false, true]);
    // Turning off an inbox carrying both removes both: the observer first, then the responder.
    fireEvent.click(row("Ambos").sw);
    await waitFor(() => expect(api.writes.length).toBe(2));
    expect(api.writes).toEqual([
      "DELETE /api/v1/chatwoot/inboxes/i4/observers/w1",
      "PATCH /api/v1/chatwoot/inboxes/i4",
    ]);
  });

  test("judges and repairs the observer bot on its own pair", async () => {
    const api = serveChannels(
      [
        // Answered by another agent whose bot is gone; this agent only watches, and its pair is fine.
        { id: "i2", name: "Saudavel", agentId: "p1", observerAgentIds: ["w1"] },
        // This agent's observer bot is gone.
        { id: "i3", name: "Quebrado", agentId: "p1", observerAgentIds: ["w1"] },
      ],
      {
        statuses: { i2: "missing", i3: "active" },
        observerStatuses: { "i2:w1": "active", "i3:w1": "missing" },
      },
    );
    await renderTab();
    await waitFor(() =>
      expect(within(rowOf("Quebrado")).queryAllByText("Reconnect").length).toBe(
        1,
      ),
    );
    expect(within(rowOf("Saudavel")).queryAllByText("Reconnect").length).toBe(
      0,
    );
    // The repair for the observer pair is an observe, not the inbox reconnect.
    fireEvent.click(within(rowOf("Quebrado")).getByText("Reconnect"));
    await waitFor(() => expect(api.writes.length).toBe(1));
    expect(api.writes).toEqual(["POST /api/v1/chatwoot/inboxes/i3/observers"]);
  });

  // An inbox carries several watchers, so no switch is blocked because another agent already
  // observes the inbox.
  test("another agent watching an inbox blocks neither the switch nor the add menu", async () => {
    const api = serveChannels([
      { id: "i5", name: "Vigiada", agentId: null, observerAgentIds: ["w2"] },
    ]);
    await renderTab();
    expect(row("Vigiada")).toMatchObject({ checked: false, disabled: false });
    fireEvent.click(row("Vigiada").sw);
    await waitFor(() =>
      expect(api.writes).toEqual([
        "POST /api/v1/chatwoot/inboxes/i5/observers",
      ]),
    );
  });

  // Racing a bind of this same agent, `observeInbox` lets the RESPONDER win and answers 200 naming
  // this agent as responder and no observer row. Both roles are applied from the answer.
  test("an observe applies both roles from the answer, on both callers", async () => {
    const won = { agentId: "w1", observerAgentIds: [] as string[] };
    for (const caller of ["switch", "repair"] as const) {
      const api = serveChannels(
        caller === "switch"
          ? [
              {
                id: "i6",
                name: "Disputada",
                agentId: null,
                observerAgentIds: [],
              },
            ]
          : [
              {
                id: "i6",
                name: "Disputada",
                agentId: null,
                observerAgentIds: ["w1"],
              },
            ],
        caller === "repair" ? { observerStatuses: { "i6:w1": "missing" } } : {},
      );
      api.observeAnswer = () => won;
      await renderTab();
      if (caller === "switch") fireEvent.click(row("Disputada").sw);
      else {
        fireEvent.click(
          await within(rowOf("Disputada")).findByText("Reconnect"),
        );
      }
      await waitFor(() => expect(row("Disputada").label).toContain("Answer"));
      expect({ caller, checked: row("Disputada").checked }).toEqual({
        caller,
        checked: true,
      });
      if (caller === "switch") {
        // Counted inside the toast list: Radix repeats a toast's text in a visually hidden live
        // region from two animation frames after it opens until a second later, so a page-wide count
        // reads 2 whenever the worker is slow enough to reach this line inside that window.
        const toasts = screen.getByRole("region", { name: /notifications/i });
        expect(
          within(toasts).queryAllByText(/was bound as the inbox's responder/)
            .length,
        ).toBe(1);
      }
      cleanup();
    }
  });

  test("the combined removal does not unbind the responder after a failed unobserve", async () => {
    const api = serveChannels([
      { id: "i4", name: "Ambos", agentId: "w1", observerAgentIds: ["w1"] },
    ]);
    api.unobserveFails = true;
    await renderTab();
    fireEvent.click(row("Ambos").sw);
    await screen.findByText("Chatwoot is down");
    await act(async () => {});
    expect(api.writes).toEqual([
      "DELETE /api/v1/chatwoot/inboxes/i4/observers/w1",
    ]);
  });

  test("an observer can be removed while the account is disconnected", async () => {
    const api = serveChannels(
      [
        { id: "i2", name: "Observa", agentId: null, observerAgentIds: ["w1"] },
        { id: "i3", name: "Nenhum", agentId: null, observerAgentIds: [] },
      ],
      { disconnected: true },
    );
    await renderTab();
    // The observed row keeps a checked switch, which is the removal; the other has none.
    expect(row("Observa").checked).toBe(true);
    expect(within(rowOf("Nenhum")).queryAllByRole("switch").length).toBe(0);
    expect(
      within(rowOf("Nenhum")).queryAllByText("Account disconnected").length,
    ).toBe(1);
    fireEvent.click(row("Observa").sw);
    await waitFor(() =>
      expect(api.writes).toEqual([
        "DELETE /api/v1/chatwoot/inboxes/i2/observers/w1",
      ]),
    );
  });
});

// The main Channels page's add menu on an inbox: every monitoring agent not already on it.
describe("the Channels page's observer menu", () => {
  test("another agent watching an inbox blocks neither the switch nor the add menu", async () => {
    serveChannels([
      { id: "i5", name: "Vigiada", agentId: "p1", observerAgentIds: ["w2"] },
    ]);
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
    const add = await screen.findByRole("button", { name: "Add observer" });
    fireEvent.pointerDown(add, { button: 0, ctrlKey: false });
    const offered = (await screen.findAllByRole("menuitem")).map(
      (m) => m.textContent,
    );
    // w2 already observes it, p1 answers it and is no watcher: only w1 is offered.
    expect(offered).toEqual(["Vigia"]);
  });
});
