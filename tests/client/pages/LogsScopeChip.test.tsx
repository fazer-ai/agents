/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { LogsPage } from "@/client/pages/LogsPage";

// THE OTHER PLACE THE PAGE NAMES A GROUP, AND IT WAS NAMING IT SOMETHING ELSE.
//
// #357 taught the group card to say what its rows are; the chip that scopes the whole page to one
// `turnId` kept saying "Turn {{id}}" unconditionally, so the same group was named twice on one
// screen and the two disagreed (issue #374). Measured against a running console with a real dead
// delivery: the card read "Webhook de saída" while the chip above it read "Turno ccfb7540-…".
//
// The invariant asserted here is the agreement, not a particular sentence: whatever the card
// decides this group is, the chip says the same thing and adds the id, which is what the chip
// exists to name.
//
// NOTE: every assertion reduces to a string or a boolean BEFORE expect. A failing expectation still
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

// `mock.module` is process-global in Bun and leaks across files in the same worker, so this file
// states the i18n surface it needs rather than depending on which file ran first.
mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) => {
      const text = typeof fallback === "string" ? fallback : key;
      if (!vars) return text;
      return text.replace(/\{\{(\w+)\}\}/g, (m, name) =>
        name in vars ? String(vars[name]) : m,
      );
    },
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

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

// The two labels on the screen, as text: the scope chip, and the title line of the one group card.
// Both reduced to strings here so no DOM node reaches an assertion.
async function labels(
  scopeTurnId: string,
  rows: Row[],
): Promise<{ chip: string; card: string | null }> {
  items = rows.map(row);
  const { container } = render(
    <MemoryRouter initialEntries={[`/logs?turnId=${scopeTurnId}`]}>
      <TooltipPrimitive.Provider>
        <ToastProvider>
          <LogsPage />
        </ToastProvider>
      </TooltipPrimitive.Provider>
    </MemoryRouter>,
  );
  return await waitFor(() => {
    const chipEl = [...container.querySelectorAll("span")].find((s) =>
      s.querySelector('button[aria-label="Clear filter"]'),
    );
    if (!chipEl) throw new Error("no scope chip rendered yet");
    const clear = chipEl.querySelector("button")?.textContent ?? "";
    const chip = (chipEl.textContent ?? "")
      .slice(0, (chipEl.textContent ?? "").length - clear.length)
      .trim();
    const card =
      container.querySelector("button[aria-expanded] span.truncate")
        ?.textContent ?? null;
    if (rows.length > 0 && card === null)
      throw new Error("no group card rendered yet");
    return { chip, card };
  });
}

describe("the chip that scopes the Logs page to one correlation id", () => {
  test("names a dead outbound delivery by what it is, and keeps the id", async () => {
    const { chip } = await labels("t-webhook", [
      { turnId: "t-webhook", stage: "webhook" },
    ]);
    expect(chip).toBe("Outbound webhook · t-webhook");
    expect(/\bTurn\b/.test(chip)).toBe(false);
  });

  test("says exactly what the group card says, plus the id", async () => {
    for (const rows of [
      [{ turnId: "t-1", stage: "webhook" }],
      [{ turnId: "t-1", stage: "delivery" }],
      [{ turnId: "t-1", stage: "generate", conversationId: "12" }],
      [{ turnId: "t-1", stage: "generate", threadId: "1:playground:1:ab" }],
      // Mixed stages with neither: the card's own answer here is still "Turn", and the point is
      // that the chip does not get to have a different opinion about the same group.
      [
        { turnId: "t-1", stage: "generate" },
        { turnId: "t-1", stage: "tool" },
      ],
    ] satisfies Row[][]) {
      const { chip, card } = await labels("t-1", rows);
      expect(chip).toBe(`${card} · t-1`);
      cleanup();
    }
  });

  test("names nothing but the id when no group in hand is the one being scoped to", async () => {
    // The rows in state can belong to the PREVIOUS filter for one render after the URL changes.
    // Naming the chip from whatever group happens to be first would label this id with another
    // group's answer.
    const { chip } = await labels("t-wanted", [
      { turnId: "t-other", stage: "webhook" },
    ]);
    expect(chip).toBe("t-wanted");
  });
});

beforeAll(() => {
  globalThis.fetch = stubFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  cleanup();
});
