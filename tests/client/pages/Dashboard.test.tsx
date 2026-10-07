import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { DashboardPage } from "@/client/pages/DashboardPage";
import { withI18n } from "@/tests/utils/i18n";

// THE DASHBOARD AS THE OPERATOR READS IT. Every block asks the API with the page's one filter, which
// lives in the URL; a link to an agent this account does not have opens on every agent; the table's
// rows filter the page; the ceiling shows the half the segment asked for, its month and where the
// month is headed; the cost is the ledger's, with Langfuse only as a link; and first response reads as
// a median and a 90th percentile, or as no data.
//
// Assertions reduce to strings or numbers before `expect`: a failing expectation that still holds a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const asked: URL[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const KPIS = {
  totalConversations: 40,
  involved: 30,
  resolvedByBot: 12,
  handoff: 6,
  resolvedBeforeTracking: 0,
  involvementRate: 0.75,
  resolutionRate: 0.4,
  automationRate: 0.3,
  handoffRate: 0.15,
  firstResponseSeconds: 95,
  firstResponseP90Seconds: 600,
  firstResponseSampled: 20,
};

const COSTS = {
  totalCostUsd: 3.5,
  requests: 120,
  tokens: { prompt: 1000, completion: 100 },
  conversations: 10,
  resolvedConversations: 4,
  costPerConversation: 0.35,
  costPerResolvedConversation: 0.875,
  days: [],
  daysByModel: [],
  daysByNode: [],
  byModel: [],
  unpriced: { calls: 0, models: [] },
  langfuse: null as null | { baseUrl: string; projectUrl?: string },
};

const BREAKDOWN = [
  {
    key: "7",
    label: "Ana",
    conversations: 8,
    requests: 50,
    costUsd: 1,
    unpricedRequests: 0,
    costPerConversation: 0.125,
    resolvedConversations: 4,
    resolutionRate: 0.5,
    promptTokens: 1000,
    cachedReadTokens: 600,
    cacheShare: 0.6,
  },
  {
    key: "8",
    label: "Beto",
    conversations: 2,
    requests: 70,
    costUsd: 2.5,
    unpricedRequests: 0,
    costPerConversation: 1.25,
    resolvedConversations: 0,
    resolutionRate: 0,
    promptTokens: 0,
    cachedReadTokens: 0,
    cacheShare: null,
  },
];

const entry = (patch: Record<string, unknown> & { source: string }) => ({
  usedUsd: 0,
  ceilingUsd: null,
  state: "allowed",
  polledAt: "2026-09-03T11:58:00.000Z",
  pollError: null,
  pollFailedAt: null,
  stale: false,
  unpricedCalls: 0,
  unpricedModels: [],
  projectedUsd: 0,
  ...patch,
});

let costs: Record<string, unknown> | "error" = COSTS;
let kpis = KPIS;
let ceilingPollMs = 300_000;
let healthFails = false;
let costsHang = false;
let optionsFail = false;

const stubFetch = (async (input: unknown) => {
  const url = new URL(
    String(typeof input === "string" ? input : (input as Request).url),
    "http://localhost",
  );
  asked.push(url);
  const p = url.pathname;
  if (p.endsWith("/metrics/kpis")) return json({ instance: "i", kpis });
  if (p.endsWith("/metrics/outcomes"))
    return json({
      instance: "i",
      trend: {
        totals: {
          total: 0,
          involved: 0,
          resolvedByBot: 0,
          handoff: 0,
          resolvedBeforeTracking: 0,
        },
        days: [],
      },
    });
  if (p.endsWith("/metrics/costs") && costsHang)
    return new Promise<Response>(() => {});
  if (p.endsWith("/metrics/costs"))
    return costs === "error"
      ? json({ error: "x" }, 500)
      : json({ instance: "i", costs });
  // Agent 8's breakdown never answers: what is on screen while it loads is the test.
  if (
    p.endsWith("/metrics/breakdown") &&
    url.searchParams.get("agentId") === "8"
  )
    return new Promise<Response>(() => {});
  if (p.endsWith("/metrics/breakdown"))
    return json({ instance: "i", rows: BREAKDOWN });
  if (p.endsWith("/metrics/handoffs"))
    return json({
      instance: "i",
      handoffs: {
        days: [{ date: "2026-10-01", cause: "person", conversations: 2 }],
        totals: [{ cause: "person", conversations: 2 }],
        silences: [{ reason: "needs_human", turns: 3 }],
      },
    });
  if (p.endsWith("/metrics/labels"))
    return json({ instance: "i", labels: { labels: [], unlabeled: 0 } });
  if (p.endsWith("/metrics/health") && healthFails)
    return json({ error: "x" }, 500);
  if (p.endsWith("/metrics/health"))
    return json({ instance: "i", health: { latency: [], problems: [] } });
  if (p.endsWith("/metrics/follow-ups"))
    return json({
      instance: "i",
      followUps: {
        stepsSent: 5,
        conversations: 3,
        cameBack: 2,
        closedByLastStep: 1,
      },
    });
  if (p.endsWith("/metrics/knowledge"))
    return json({
      instance: "i",
      knowledge: {
        proposed: 4,
        waiting: 0,
        discarded: 1,
        approved: 2,
        rejected: 1,
      },
    });
  if (p.endsWith("/spend-ceiling/usage"))
    return json({
      instance: {},
      enabled: true,
      periodStart: "2026-09-01T00:00:00.000Z",
      legacyTokens: null,
      pollIntervalMs: ceilingPollMs,
      entries: [
        entry({
          source: "inbox",
          usedUsd: 22.5,
          ceilingUsd: 30,
          state: "warning",
          projectedUsd: 45,
        }),
        entry({
          source: "playground",
          usedUsd: 4.25,
          ceilingUsd: 5,
          state: "over",
          projectedUsd: 9,
        }),
      ],
    });
  if (p.endsWith("/metrics/filter-options") && optionsFail)
    return json({ error: "x" }, 500);
  if (p.endsWith("/metrics/filter-options"))
    return json({
      agents: [
        { id: "7", name: "Ana" },
        { id: "8", name: "Beto" },
      ],
      inboxes: [{ id: "3", name: "WhatsApp" }],
    });
  return json({ error: "nope" }, 500);
}) as unknown as typeof globalThis.fetch;

let location = "";
function Where() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  return null;
}

async function renderDash(path = "/") {
  asked.length = 0;
  render(
    withI18n(
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <DashboardPage />
          <Where />
        </MemoryRouter>
      </ThemeProvider>,
    ),
  );
  await waitFor(() => {
    expect(has("Automation funnel")).toBe(true);
  });
}

const has = (text: string | RegExp) =>
  screen.queryAllByText(text, { exact: false }).length > 0;
const asks = (path: string) => asked.filter((u) => u.pathname.endsWith(path));

beforeAll(() => {
  globalThis.fetch = stubFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  costs = COSTS;
  kpis = KPIS;
  ceilingPollMs = 300_000;
  healthFails = false;
  optionsFail = false;
  costsHang = false;
});
afterEach(cleanup);

describe("one filter, in the URL, for every block", () => {
  test("every block asks with the agent, inbox and segment the link names", async () => {
    await renderDash("/?range=7d&agent=7&inbox=3&source=playground");
    await waitFor(() => {
      expect(asks("/metrics/health").length).toBeGreaterThan(0);
    });
    for (const path of [
      "/metrics/kpis",
      "/metrics/outcomes",
      "/metrics/costs",
      "/metrics/breakdown",
      "/metrics/handoffs",
      "/metrics/labels",
      "/metrics/health",
      "/metrics/follow-ups",
      "/metrics/knowledge",
    ]) {
      const u = asks(path)[0];
      expect([path, u?.searchParams.get("agentId")]).toEqual([path, "7"]);
      expect([path, u?.searchParams.get("inboxId")]).toEqual([path, "3"]);
      expect([path, u?.searchParams.get("source")]).toEqual([
        path,
        "playground",
      ]);
      expect([path, Boolean(u?.searchParams.get("until"))]).toEqual([
        path,
        true,
      ]);
    }
    // The previous period is asked too, as long as this one and ending where it starts.
    const kpiAsks = asks("/metrics/kpis").map((u) => ({
      since: u.searchParams.get("since"),
      until: u.searchParams.get("until"),
    }));
    const current = kpiAsks.find(
      (k) => k.until && new Date(k.until) > new Date(),
    );
    const prev = kpiAsks.find((k) => k.until === current?.since);
    expect(Boolean(prev)).toBe(true);
  });

  test("a link to an agent this account does not have opens on every agent", async () => {
    await renderDash("/?agent=999999");
    await waitFor(() => {
      expect(location.includes("agent=")).toBe(false);
    });
  });

  test("an unreadable list of agents and inboxes keeps the link's ids", async () => {
    optionsFail = true;
    await renderDash("/?agent=7&inbox=3");
    await waitFor(() => {
      expect(asks("/metrics/filter-options").length).toBe(1);
      expect(asks("/metrics/health").length).toBeGreaterThan(0);
    });
    expect(location).toBe("/?agent=7&inbox=3");
  });

  test("a new filter takes the previous view's figures off the screen while it loads", async () => {
    await renderDash("/");
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "Beto" }).length).toBe(1);
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Agent" }), {
      target: { value: "8" },
    });
    await waitFor(() => {
      expect(location).toBe("/?agent=8");
      expect(screen.queryAllByRole("button", { name: "Beto" }).length).toBe(0);
    });
  });

  test("choosing an agent puts it in the URL, and every agent takes it out", async () => {
    await renderDash("/");
    const select = screen.getByRole("combobox", {
      name: "Agent",
    }) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBe(3);
    });
    fireEvent.change(select, { target: { value: "8" } });
    await waitFor(() => {
      expect(location).toBe("/?agent=8");
    });
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => {
      expect(location).toBe("/");
    });
  });
});

describe("the dimension table", () => {
  test("sorts by the column clicked, and back", async () => {
    await renderDash("/");
    await waitFor(() => {
      expect(has("Where the usage goes")).toBe(true);
      expect(screen.queryAllByRole("button", { name: "Beto" }).length).toBe(1);
    });
    const order = () =>
      screen
        .getAllByRole("button", { name: /^(Ana|Beto)$/ })
        .map((b) => b.textContent);
    // Cost, largest first, by default.
    expect(order()).toEqual(["Beto", "Ana"]);
    fireEvent.click(screen.getByRole("button", { name: "Resolution" }));
    expect(order()).toEqual(["Ana", "Beto"]);
    fireEvent.click(screen.getByRole("button", { name: "Resolution" }));
    expect(order()).toEqual(["Beto", "Ana"]);
  });

  test("clicking an agent's row filters the page by it", async () => {
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "Ana" }).length).toBe(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Ana" }));
    await waitFor(() => {
      expect(location).toBe("/?range=7d&agent=7");
    });
  });

  test("an agent with no input shows no cache share, not 0%", async () => {
    await renderDash("/");
    await waitFor(() => {
      expect(has("Cached input by agent")).toBe(true);
      expect(has("60%")).toBe(true);
    });
    expect(has("NaN")).toBe(false);
    expect(has("Infinity")).toBe(false);
  });
});

describe("the month against the ceiling", () => {
  test("shows the segment's half, its month in UTC and where the month is headed", async () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      await renderDash("/");
      await waitFor(() => {
        expect(has("$22.50 of $30.00")).toBe(true);
      });
      expect(has("$4.25 of $5.00")).toBe(false);
      expect(has("September 2026")).toBe(true);
      expect(has("at this pace the month ends near $45.00")).toBe(true);
    } finally {
      process.env.TZ = tz;
    }
  });

  test("the playground segment shows the playground's half", async () => {
    await renderDash("/?source=playground");
    await waitFor(() => {
      expect(has("$4.25 of $5.00")).toBe(true);
    });
    expect(has("$22.50 of $30.00")).toBe(false);
  });

  test("a page left open re-reads the ceiling on the poll's period, and nothing else", async () => {
    ceilingPollMs = 40;
    await renderDash("/");
    await waitFor(() => {
      expect(has("$22.50 of $30.00")).toBe(true);
    });
    const ceilingBefore = asks("/spend-ceiling/usage").length;
    const costsBefore = asks("/metrics/costs").length;
    await waitFor(() => {
      expect(asks("/spend-ceiling/usage").length).toBeGreaterThan(
        ceilingBefore,
      );
    });
    expect(asks("/metrics/costs").length).toBe(costsBefore);
  });
});

describe("the cost is the ledger's", () => {
  test("it shows with no Langfuse, and with Langfuse there is only a link", async () => {
    await renderDash("/");
    await waitFor(() => {
      expect(has("$3.50")).toBe(true);
    });
    expect(has("Open in Langfuse")).toBe(false);
    cleanup();
    costs = {
      ...COSTS,
      langfuse: {
        baseUrl: "https://lf.example",
        projectUrl: "https://lf.example/project/p1",
      },
    };
    await renderDash("/");
    await waitFor(() => {
      expect(has("Open in Langfuse")).toBe(true);
    });
    const link = screen.getByRole("link", { name: /Open in Langfuse/ });
    expect(link.getAttribute("href")).toBe("https://lf.example/project/p1");
    expect(has("$3.50")).toBe(true);
  });

  test("requests with no price are counted beside the cost, with their models", async () => {
    costs = { ...COSTS, unpriced: { calls: 54, models: ["llama-local-70b"] } };
    await renderDash("/");
    await waitFor(() => {
      expect(has("54 requests in this period have no price")).toBe(true);
    });
    expect(has("llama-local-70b")).toBe(true);
  });

  test("a cost that cannot be read says so in its slot", async () => {
    costs = "error";
    await renderDash("/");
    await waitFor(() => {
      expect(has("Could not read the cost.")).toBe(true);
    });
  });
});

describe("a block whose request fails", () => {
  test("says so with a retry, never that nothing happened", async () => {
    healthFails = true;
    await renderDash("/");
    await waitFor(() => {
      expect(has("Warnings and errors")).toBe(true);
      expect(
        screen.queryAllByRole("button", { name: "Try again" }).length,
      ).toBe(2);
    });
    expect(has("No warnings or errors in this period.")).toBe(false);
    const before = asks("/metrics/health").length;
    healthFails = false;
    fireEvent.click(
      screen.getAllByRole("button", { name: "Try again" })[0] as HTMLElement,
    );
    await waitFor(() => {
      expect(asks("/metrics/health").length).toBe(before + 1);
      expect(has("No warnings or errors in this period.")).toBe(true);
    });
  });
});

describe("every funnel tile opens the conversations it counts", () => {
  test("automation opens the conversations the agent resolved", async () => {
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "30%" }).length).toBe(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    await waitFor(() => {
      expect(location.startsWith("/conversations?")).toBe(true);
    });
    expect(new URL(location, "http://x").searchParams.get("outcome")).toBe(
      "resolved_by_agent",
    );
  });
});

describe("a block still loading", () => {
  test("offers no CSV until its figures arrive", async () => {
    const exportDaily = () =>
      screen.queryAllByRole("button", { name: "Export Daily cost as CSV" });
    costsHang = true;
    await renderDash("/");
    await waitFor(() => {
      expect(has("Daily cost")).toBe(true);
      expect(asks("/metrics/costs").length).toBeGreaterThan(0);
    });
    expect(exportDaily().length).toBe(0);
    cleanup();
    costsHang = false;
    await renderDash("/");
    await waitFor(() => {
      expect(exportDaily().length).toBe(1);
    });
  });
});

describe("figures beside a chart", () => {
  test("the handoff block's period totals and silences stay readable by a screen reader", async () => {
    await renderDash("/");
    await waitFor(() => {
      expect(has("Needs a person")).toBe(true);
    });
    const silence = screen.getAllByText("Needs a person")[0] as HTMLElement;
    expect(silence.closest("[aria-hidden='true']")).toBeNull();
  });
});

describe("first response", () => {
  test("reads as a median and a 90th percentile", async () => {
    await renderDash("/");
    await waitFor(() => {
      expect(
        has("median and 90th percentile over 20 answered conversations"),
      ).toBe(true);
    });
    const tile = screen
      .getAllByText(/p90/)
      .map((n) => n.textContent ?? "")
      .join(" ");
    expect(/1 min/.test(tile) || /95/.test(tile)).toBe(true);
    expect(/10 min/.test(tile)).toBe(true);
  });

  test("no sample is no data, never an instant answer", async () => {
    kpis = {
      ...KPIS,
      firstResponseSeconds: null as unknown as number,
      firstResponseP90Seconds: null as unknown as number,
      firstResponseSampled: 0,
    };
    await renderDash("/");
    await waitFor(() => {
      expect(has("no data for this period yet")).toBe(true);
    });
  });
});

describe("what the agent does on its own", () => {
  test("follow-ups and knowledge suggestions show their figures", async () => {
    await renderDash("/");
    await waitFor(() => {
      expect(has("Steps delivered")).toBe(true);
      expect(has("Discarded by the reviewer")).toBe(true);
    });
  });
});

describe("a screen reader gets a table for each chart", () => {
  test("the funnel trend has its table, with a row per day", async () => {
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("table")
          .some(
            (t) =>
              t.querySelector("caption")?.textContent === "Funnel over time",
          ),
      ).toBe(true);
    });
    const table = screen
      .getAllByRole("table")
      .find(
        (t) => t.querySelector("caption")?.textContent === "Funnel over time",
      );
    expect(table?.querySelectorAll("tbody tr").length).toBe(7);
  });
});
