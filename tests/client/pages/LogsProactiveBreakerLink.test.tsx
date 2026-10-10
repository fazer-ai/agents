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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { LogsPage } from "@/client/pages/LogsPage";
import { withI18n } from "@/tests/utils/i18n";

// A proactive breaker line on the Logs page links to the breaker's card, where an admin resumes it,
// raises the limit or turns it off. Every assertion reduces to a string or a boolean before expect.
const realFetch = globalThis.fetch;
let items: unknown[] = [];

function line(stage: string, level: string): unknown {
  return {
    id: `${stage}-${level}`,
    turnId: `t-${stage}-${level}`,
    conversationId: "12",
    agentId: null,
    inboxId: null,
    threadId: null,
    stage,
    level,
    status: level === "error" ? "error" : "skipped",
    provider: null,
    model: null,
    durationMs: null,
    source: "inbox",
    detail: { outcome: "not_sent" },
    errorMessage: "Proactive messages paused for the whole account",
    createdAt: "2026-10-10T12:00:00.000Z",
  };
}

const stubFetch = (async (input: unknown) => {
  const url = String(
    typeof input === "string" ? input : ((input as Request).url ?? input),
  );
  if (url.includes("/logs"))
    return new Response(JSON.stringify({ items, nextCursor: null }), {
      headers: { "content-type": "application/json" },
    });
  return new Response("{}", { status: 500 });
}) as unknown as typeof globalThis.fetch;

async function cardLinks(stage: string): Promise<string[]> {
  items = [line(stage, "error")];
  const { container } = render(
    withI18n(
      <MemoryRouter initialEntries={["/logs"]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <LogsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
  await waitFor(() => {
    if (!container.querySelector("button[aria-expanded]"))
      throw new Error("no group yet");
  });
  for (const b of [
    ...container.querySelectorAll("button[aria-expanded='false']"),
  ])
    fireEvent.click(b);
  await waitFor(() => {
    if (
      container.querySelectorAll("button[aria-expanded='false']").length > 0
    ) {
      for (const b of [
        ...container.querySelectorAll("button[aria-expanded='false']"),
      ])
        fireEvent.click(b);
      throw new Error("still collapsed");
    }
  });
  return [...container.querySelectorAll("a")]
    .map((a) => a.getAttribute("href") ?? "")
    .filter((h) => h.includes("/resources/advanced"));
}

describe("a proactive breaker line on the Logs page", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("links to the breaker's card", async () => {
    expect(await cardLinks("proactive_breaker")).toEqual([
      "/resources/advanced?section=proactive-breaker",
    ]);
  });

  test("another stage's line does not", async () => {
    expect(await cardLinks("proactive_limit")).toEqual([]);
  });
});
