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
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { AuthContext } from "@/client/contexts/AuthContext";
import { LogsPage } from "@/client/pages/LogsPage";
import { withI18n } from "@/tests/utils/i18n";

// Under the client source the Logs page narrows to one audience (signed-in users or anonymous
// visitors), and a turn served to an anonymous visitor's session says so on its card. An audience
// left in a link under any other source is not sent and not shown.
//
// Every assertion reduces to a string BEFORE expect: a failing expectation still holding a DOM node
// serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const asked: URL[] = [];

function line(turnId: string, anonymous: boolean) {
  return {
    id: turnId,
    turnId,
    conversationId: null,
    agentId: "1",
    inboxId: null,
    threadId: `1:client:1:${turnId}`,
    stage: "generate",
    level: "info",
    status: "ok",
    provider: null,
    model: null,
    durationMs: null,
    source: "client",
    anonymous,
    detail: null,
    errorMessage: null,
    createdAt: "2026-10-10T12:00:00.000Z",
  };
}

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(
      typeof input === "string" ? input : ((input as Request).url ?? input),
    );
    const u = new URL(url, "http://localhost");
    if (u.pathname.endsWith("/logs")) {
      asked.push(u);
      return new Response(
        JSON.stringify({
          items: [line("t-anon", true), line("t-ana", false)],
          nextCursor: null,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
  }) as unknown as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  cleanup();
  asked.length = 0;
});

async function open(path: string) {
  const { container } = render(
    withI18n(
      <AuthContext.Provider
        value={
          { clientChannelEnabled: true } as unknown as NonNullable<
            React.ContextType<typeof AuthContext>
          >
        }
      >
        <MemoryRouter initialEntries={[path]}>
          <TooltipPrimitive.Provider>
            <ToastProvider>
              <LogsPage />
            </ToastProvider>
          </TooltipPrimitive.Provider>
        </MemoryRouter>
      </AuthContext.Provider>,
    ),
  );
  await waitFor(() => {
    if (!container.textContent?.includes("t-an") && asked.length === 0)
      throw new Error("no logs yet");
    if (!container.querySelector("[aria-expanded]"))
      throw new Error("no turn cards yet");
  });
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Audience"]',
  );
  return {
    asked: asked.at(-1)?.searchParams.get("audience") ?? null,
    shown: select ? select.value : null,
    badges: [...container.querySelectorAll("span")].filter(
      (el) => el.textContent === "Anonymous visitor",
    ).length,
  };
}

describe("the logs' client audience", () => {
  test("under the client source, an audience is asked for, shown, and an anonymous turn is marked", async () => {
    expect(await open("/logs?source=client&audience=anonymous")).toEqual({
      asked: "anonymous",
      shown: "anonymous",
      badges: 1,
    });
  });

  test("both audiences is the absence of the parameter", async () => {
    expect(await open("/logs?source=client")).toEqual({
      asked: null,
      shown: "",
      badges: 1,
    });
  });

  test("under another source, a leftover audience is neither sent nor offered", async () => {
    const r = await open("/logs?source=all&audience=anonymous");
    expect({ asked: r.asked, shown: r.shown }).toEqual({
      asked: null,
      shown: null,
    });
  });
});
