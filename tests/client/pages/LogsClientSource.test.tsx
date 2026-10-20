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

// The client source exists only where the install runs the client channel (CLIENT_CHANNEL_ENABLED).
// With it off, a saved `source=client` link reads as the default source: the filter shown and the
// rows asked for stay the same thing, instead of a select reading "Real" over client rows.
//
// Every assertion reduces to a string BEFORE expect: a failing expectation still holding a DOM node
// serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const asked: URL[] = [];

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(
      typeof input === "string" ? input : ((input as Request).url ?? input),
    );
    const u = new URL(url, "http://localhost");
    if (u.pathname.endsWith("/logs")) {
      asked.push(u);
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        headers: { "content-type": "application/json" },
      });
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

async function sourceAsked(clientChannel: boolean | undefined) {
  const page = (
    <MemoryRouter initialEntries={["/logs?source=client"]}>
      <TooltipPrimitive.Provider>
        <ToastProvider>
          <LogsPage />
        </ToastProvider>
      </TooltipPrimitive.Provider>
    </MemoryRouter>
  );
  const { container } = render(
    withI18n(
      clientChannel === undefined ? (
        page
      ) : (
        <AuthContext.Provider
          value={
            { clientChannelEnabled: clientChannel } as unknown as NonNullable<
              React.ContextType<typeof AuthContext>
            >
          }
        >
          {page}
        </AuthContext.Provider>
      ),
    ),
  );
  await waitFor(() => {
    if (asked.length === 0) throw new Error("no logs request yet");
  });
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Source"]',
  );
  return {
    asked: asked[0]?.searchParams.get("source") ?? null,
    shown: select?.value ?? null,
  };
}

describe("the logs' client source follows the install's switch", () => {
  test("off: a client link asks for and shows the default source", async () => {
    expect(await sourceAsked(false)).toEqual({
      asked: "inbox",
      shown: "inbox",
    });
  });

  test("outside a session, the switch reads as off", async () => {
    expect(await sourceAsked(undefined)).toEqual({
      asked: "inbox",
      shown: "inbox",
    });
  });

  test("on: a client link asks for and shows the client source", async () => {
    expect(await sourceAsked(true)).toEqual({
      asked: "client",
      shown: "client",
    });
  });
});
