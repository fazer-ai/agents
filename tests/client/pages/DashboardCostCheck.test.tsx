import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { DashboardPage } from "@/client/pages/DashboardPage";
import { withI18n } from "@/tests/utils/i18n";

// Issue #868: the cost check compares this app's costs with Langfuse's, so without Langfuse it
// cannot run, and the screen has to say so rather than read as a check that passed.

const realFetch = globalThis.fetch;
let costs: Record<string, unknown> = { status: "disabled" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const KPIS = {
  totalConversations: 0,
  involved: 0,
  resolvedByBot: 0,
  handoff: 0,
  resolvedBeforeTracking: 0,
  involvementRate: 0,
  resolutionRate: 0,
  automationRate: 0,
  firstResponseSeconds: null,
  firstResponseSampled: 0,
};

const METRICS = {
  llm: {
    calls: 10,
    promptTokens: 1,
    completionTokens: 1,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    byAgent: [],
    byInbox: [],
    byModel: [],
  },
  conversations: { total: 3, byStatus: [] },
};

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(
      typeof input === "string" ? input : ((input as Request).url ?? input),
    );
    if (url.includes("/metrics/kpis"))
      return json({ instance: "i", kpis: KPIS });
    if (url.includes("/agents")) return json({ agents: [] });
    if (url.includes("/metrics/costs")) return json({ costs });
    if (url.includes("/metrics/timeseries")) return json({ points: [] });
    if (url.includes("/spend-ceiling/usage"))
      return json({
        instance: {},
        periodStart: "2026-09-01T00:00:00.000Z",
        langfuseConfigured: false,
        legacyTokens: null,
        pollIntervalMs: 300_000,
        entries: [],
      });
    if (url.includes("/metrics"))
      return json({ instance: "i", metrics: METRICS });
    return json({ error: "nope" }, 500);
  }) as unknown as typeof globalThis.fetch;
});
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function renderDash() {
  render(
    withI18n(
      <ThemeProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </ThemeProvider>,
    ),
  );
  await waitFor(() => {
    expect(screen.queryAllByText("LLM usage").length).toBeGreaterThan(0);
  });
}

test("without Langfuse the cost card says the cost check cannot run", async () => {
  costs = { status: "disabled" };
  await renderDash();
  await waitFor(() => {
    expect(screen.getByTestId("cost-check-unavailable").textContent).toContain(
      "not checked against Langfuse",
    );
  });
});

test("with Langfuse unreachable the card says so, and does not claim the check is off", async () => {
  costs = { status: "error" };
  await renderDash();
  await waitFor(() => {
    expect(
      screen.queryAllByText("Could not fetch costs from Langfuse.", {
        exact: false,
      }).length,
    ).toBeGreaterThan(0);
  });
  expect(screen.queryByTestId("cost-check-unavailable")).toBeNull();
});

// Review of #868: Langfuse answering with no models while the ledger has usage is itself a finding,
// the models only this app recorded, and the card has to carry it rather than vanish.
test("with Langfuse answering no models, the models only this app recorded are still shown", async () => {
  costs = {
    status: "ok",
    totalCostUsd: 0,
    days: [],
    byModel: [],
    baseUrl: "http://langfuse.local",
    costCheck: { models: [], onlyInLangfuse: [], onlyLocal: ["gpt-4o"] },
  };
  await renderDash();
  await waitFor(() => {
    expect(screen.getByTestId("cost-check-only-local").textContent).toBe(
      "Only in this app's usage records, not compared: gpt-4o",
    );
  });
});

test("with Langfuse answering no models and no local usage either, there is no card", async () => {
  costs = {
    status: "ok",
    totalCostUsd: 0,
    days: [],
    byModel: [],
    baseUrl: "http://langfuse.local",
    costCheck: { models: [], onlyInLangfuse: [], onlyLocal: [] },
  };
  await renderDash();
  // Let the costs request settle before asserting the absence.
  await waitFor(() => {
    expect(screen.queryByTestId("cost-check-unavailable")).toBeNull();
  });
  expect(screen.queryByText("Cost by model")).toBeNull();
});
