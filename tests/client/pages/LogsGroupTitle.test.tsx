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
import { LogsPage } from "@/client/pages/LogsPage";
import { withI18n } from "@/tests/utils/i18n";

// Issue #357: a Logs group whose rows have no conversation announces itself as "Turn", and the one
// stage that can NEVER be a turn (`webhook`: an outbound delivery on a worker tick, long after
// whatever produced the event) is exactly the one that always lands there. So this asserts what the
// operator reads on the card, not that the card exists: a group that renders and lies about what it
// is passes any structural test and fails the issue.
//
// NOTE: every assertion reduces to a string or a boolean BEFORE expect. A failing expectation still
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

// This file asserts on rendered LABELS, so what `t` answers is part of the fixture. It used to
// secure that by replacing `react-i18next` in the module registry, which secured it for every other
// file in the process too: the stub the last such file installed was what they all got. `withI18n`
// hands this tree its own i18next by context instead: same answers, no reach past this file.
const realFetch = globalThis.fetch;

interface Row {
  turnId: string;
  stage: string;
  conversationId?: string | null;
  threadId?: string | null;
}

let items: unknown[] = [];

function row(r: Row): unknown {
  return {
    id: `${r.turnId}-${r.stage}`,
    turnId: r.turnId,
    conversationId: r.conversationId ?? null,
    agentId: null,
    inboxId: null,
    threadId: r.threadId ?? null,
    stage: r.stage,
    level: "info",
    status: "ok",
    provider: null,
    model: null,
    durationMs: null,
    source: "inbox",
    detail: {},
    errorMessage: null,
    createdAt: "2026-08-26T12:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const stubFetch = (async (input: unknown) => {
  const url = String(
    typeof input === "string" ? input : ((input as Request).url ?? input),
  );
  if (url.includes("/logs")) return json({ items, nextCursor: null });
  return json({ error: "nope" }, 500);
}) as unknown as typeof globalThis.fetch;

// The group card's own title line: the <button> that toggles the disclosure. Reduced to its text
// before it leaves this helper, so no DOM node reaches an assertion.
async function titles(rows: Row[]): Promise<string[]> {
  items = rows.map(row);
  render(
    withI18n(
      <MemoryRouter>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <LogsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    ),
  );
  return await waitFor(() => {
    const found = screen
      .getAllByRole("button", { expanded: false })
      .map((b) => (b.textContent ?? "").trim());
    if (found.length === 0) throw new Error("no group card rendered yet");
    return found;
  });
}

beforeAll(() => {
  globalThis.fetch = stubFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  cleanup();
});

describe("what a Logs group calls itself", () => {
  test("a dead outbound delivery is named by its stage, never 'Turn'", async () => {
    const [title] = await titles([{ turnId: "t-webhook", stage: "webhook" }]);
    expect(title ?? "").toContain("Outbound webhook");
    expect(/\bTurn\b/.test(title ?? "")).toBe(false);
  });

  test("a group tied to a conversation still names the conversation", async () => {
    const [title] = await titles([
      { turnId: "t-conv", stage: "generate", conversationId: "12" },
    ]);
    expect(title ?? "").toContain("Conversation #12");
  });

  test("a playground turn keeps naming its thread", async () => {
    const [title] = await titles([
      { turnId: "t-thread", stage: "generate", threadId: "1:playground:1:ab" },
    ]);
    expect(title ?? "").toContain("1:playground:1:ab");
  });
});
