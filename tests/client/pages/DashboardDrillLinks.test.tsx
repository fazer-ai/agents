/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { AuthContext } from "@/client/contexts/AuthContext";
import { ConversationsPage } from "@/client/pages/ConversationsPage";
import { LogsPage } from "@/client/pages/LogsPage";
import { withI18n } from "@/tests/utils/i18n";

// WHERE A DASHBOARD CLICK LANDS. The conversation list and the Logs page read the dashboard's view
// from the link and ask the API for exactly it, and say on screen that the list is narrowed and by
// what, with a way to clear it.

const realFetch = globalThis.fetch;
const asked: URL[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const stubFetch = (async (input: unknown) => {
  const url = new URL(
    String(typeof input === "string" ? input : (input as Request).url),
    "http://localhost",
  );
  asked.push(url);
  if (url.pathname.endsWith("/logs"))
    return json({ items: [], nextCursor: null });
  if (url.pathname.endsWith("/conversations/agents"))
    return json({ agents: [] });
  if (url.pathname.endsWith("/conversations"))
    return json({ instance: "i", conversations: [], nextCursor: null });
  return json({ error: "nope" }, 500);
}) as unknown as typeof globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = stubFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  cleanup();
  asked.length = 0;
});

function mount(path: string, page: React.ReactNode) {
  render(
    withI18n(
      <MemoryRouter initialEntries={[path]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            {/* No user: the live tenant channel stays closed, which is all the list needs here. */}
            <AuthContext.Provider
              value={
                { user: null } as unknown as React.ContextType<
                  typeof AuthContext
                >
              }
            >
              {page}
            </AuthContext.Provider>
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
}

describe("the Logs page opened from the health block", () => {
  test("asks for the tool, the window, the agent and the inbox, and says so", async () => {
    mount(
      "/logs?stage=tool&level=warn&tool=consultar_pedido&source=inbox&since=2026-09-07T03:00:00.000Z&until=2026-10-07T02:59:59.999Z&agentId=7&inboxId=3",
      <LogsPage />,
    );
    await waitFor(() => {
      expect(asked.some((u) => u.pathname.endsWith("/logs"))).toBe(true);
    });
    const q = asked.find((u) => u.pathname.endsWith("/logs"))?.searchParams;
    expect({
      tool: q?.get("tool"),
      since: q?.get("since"),
      until: q?.get("until"),
      agentId: q?.get("agentId"),
      inboxId: q?.get("inboxId"),
      stage: q?.get("stage"),
      level: q?.get("level"),
    }).toEqual({
      tool: "consultar_pedido",
      since: "2026-09-07T03:00:00.000Z",
      until: "2026-10-07T02:59:59.999Z",
      agentId: "7",
      inboxId: "3",
      stage: "tool",
      level: "warn",
    });
    await waitFor(() => {
      expect(
        screen.queryAllByText(/From the dashboard: consultar_pedido/).length,
      ).toBe(1);
    });
  });
});

describe("the conversation list opened from a dashboard figure", () => {
  test("asks for the figure's window, inbox and outcome, and says so", async () => {
    mount(
      "/conversations?createdSince=2026-10-04T03:00:00.000Z&createdUntil=2026-10-05T03:00:00.000Z&outcome=handoff&agentId=7&inboxId=3",
      <ConversationsPage />,
    );
    await waitFor(() => {
      expect(asked.some((u) => u.pathname.endsWith("/v1/conversations"))).toBe(
        true,
      );
    });
    const q = asked.find((u) =>
      u.pathname.endsWith("/v1/conversations"),
    )?.searchParams;
    expect({
      createdSince: q?.get("createdSince"),
      createdUntil: q?.get("createdUntil"),
      outcome: q?.get("outcome"),
      agentId: q?.get("agentId"),
      inboxId: q?.get("inboxId"),
    }).toEqual({
      createdSince: "2026-10-04T03:00:00.000Z",
      createdUntil: "2026-10-05T03:00:00.000Z",
      outcome: "handoff",
      agentId: "7",
      inboxId: "3",
    });
    await waitFor(() => {
      expect(
        screen.queryAllByText(/From the dashboard: handed over to a person/)
          .length,
      ).toBe(1);
    });
  });

  test("without the dashboard's parameters the list asks as it always did", async () => {
    mount("/conversations?agentId=7", <ConversationsPage />);
    await waitFor(() => {
      expect(asked.some((u) => u.pathname.endsWith("/v1/conversations"))).toBe(
        true,
      );
    });
    const q = asked.find((u) =>
      u.pathname.endsWith("/v1/conversations"),
    )?.searchParams;
    expect([...(q?.keys() ?? [])]).toEqual(["agentId"]);
    expect(screen.queryAllByText(/From the dashboard/).length).toBe(0);
  });
});
