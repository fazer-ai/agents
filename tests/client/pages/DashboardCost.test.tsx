import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { DashboardPage } from "@/client/pages/DashboardPage";
import { withI18n } from "@/tests/utils/i18n";

// The dashboard's cost is the ledger's: it shows on every install, Langfuse or not, says how many
// requests had no price, and keeps Langfuse only as a link, with no check against a second source.

const realFetch = globalThis.fetch;
let costs: Record<string, unknown> | null = null;
const COSTS = (patch: Record<string, unknown> = {}) => ({
  totalCostUsd: 3.5,
  days: [],
  byModel: [
    { model: "gpt-b", costUsd: 2 },
    { model: "gpt-a", costUsd: 1.5 },
  ],
  unpriced: { calls: 0, models: [] },
  langfuse: null,
  ...patch,
});

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
    if (url.includes("/metrics/costs"))
      return costs ? json({ instance: "i", costs }) : json({ error: "x" }, 500);
    if (url.includes("/metrics/timeseries")) return json({ points: [] });
    if (url.includes("/spend-ceiling/usage"))
      return json({
        instance: {},
        enabled: true,
        periodStart: "2026-09-01T00:00:00.000Z",
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

test("without Langfuse the cost shows, with no link and nothing asking to connect it", async () => {
  costs = COSTS();
  await renderDash();
  await waitFor(() => {
    expect(screen.queryAllByText("$3.50").length).toBeGreaterThan(0);
  });
  expect(screen.queryByText("Open in Langfuse")).toBeNull();
  expect(screen.queryByText(/Connect Langfuse/)).toBeNull();
  expect(screen.queryByText(/checked against/)).toBeNull();
  expect(screen.getByText("Cost by model")).toBeTruthy();
  expect(screen.getByText("gpt-b")).toBeTruthy();
  expect(screen.queryByTestId("cost-divergence-marker")).toBeNull();
  expect(screen.queryByTestId("cost-unpriced")).toBeNull();
});

test("with Langfuse the link points at the project, and the figures are the same", async () => {
  costs = COSTS({
    langfuse: {
      baseUrl: "https://langfuse.example.test",
      projectUrl: "https://langfuse.example.test/project/p1",
    },
  });
  await renderDash();
  const link = await screen.findByText("Open in Langfuse");
  expect(link.closest("a")?.getAttribute("href")).toBe(
    "https://langfuse.example.test/project/p1",
  );
  expect(screen.queryAllByText("$3.50").length).toBeGreaterThan(0);
});

test("requests with no price are counted beside the cost, with their models and the fix", async () => {
  costs = COSTS({ unpriced: { calls: 1234, models: ["mystery", "gpt-b"] } });
  await renderDash();
  const notice = await screen.findByTestId("cost-unpriced");
  expect(notice.textContent).toContain("1,234 requests");
  expect(notice.textContent).toContain("mystery, gpt-b");
  expect(notice.textContent).toContain("Model prices");
  expect(screen.getByText("Open model prices")).toBeTruthy();
});

test("a cost that cannot be read says so in the cost slot", async () => {
  costs = null;
  await renderDash();
  await waitFor(() => {
    expect(screen.getByText("Could not read the cost.")).toBeTruthy();
  });
  expect(screen.queryByText(/Langfuse/)).toBeNull();
});
