import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { AuthContext } from "@/client/contexts/AuthContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import {
  getActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";
import {
  DashboardPage,
  OPTIONS_RETRY_MS,
  useOpenedAt,
} from "@/client/pages/DashboardPage";
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

let costs: Record<string, unknown> | "error" | "slow" = COSTS;
let kpis = KPIS;
let ceilingPollMs = 300_000;
let healthFails = false;
// The status a failing health request answers with, and the field its refusal names.
let healthFailStatus = 500;
let healthFailField: string | undefined;
let costsHang = false;
// The flow log's retention the filter options carry: past it, a flow-log day has no data.
let retentionDays = 30;
// A whole view whose flow-log days are all past retention: no handoffs, no silences and no problems,
// because there is no data, not because there were none.
let logExpired = false;
// The tenant a SUPER_ADMIN selected, deleted while the page loads: every metrics route refuses it.
let tenantGone: string | null = null;
// The KPIs' route fails; every other route answers.
let kpisFail = false;
// The day the fixture's handoffs fall on.
let handoffOn = "2026-10-01";
// Holds the filter options' answer until released, to answer the metrics routes first.
let optionsGate: Promise<void> | null = null;
// The tenant's first record, which an all-time view starts from; null for none.
let firstRecordAt: string | null = null;
let optionsFail = false;
const ONE_INBOX = [{ id: "3", name: "WhatsApp" }];
let inboxOptions: {
  id: string;
  name: string;
  account?: { id: number; name: string | null };
}[] = ONE_INBOX;

// The signal of every metrics request, by path and query, to see which ones a new view aborted.
const signals: { url: URL; signal: AbortSignal | null }[] = [];

const stubFetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(
    String(typeof input === "string" ? input : (input as Request).url),
    "http://localhost",
  );
  const p = url.pathname;
  asked.push(url);
  signals.push({
    url,
    signal:
      init?.signal ??
      (typeof input === "string" ? null : ((input as Request).signal ?? null)),
  });
  if (tenantGone && p.includes("/metrics/") && !p.endsWith("/filter-options"))
    return new Response(JSON.stringify({ error: "x" }), {
      status: 404,
      headers: {
        "content-type": "application/json",
        "X-Tenant-Id-Invalid": tenantGone,
      },
    });
  if (p.endsWith("/metrics/kpis") && kpisFail) return json({ error: "x" }, 500);
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
        series:
          url.searchParams.get("breakdown") === "agent"
            ? [
                {
                  key: "1",
                  label: "Ana",
                  totals: {
                    total: 4,
                    involved: 3,
                    resolvedByBot: 2,
                    handoff: 1,
                  },
                  days: [],
                },
              ]
            : url.searchParams.get("breakdown") === "inbox"
              ? []
              : undefined,
      },
    });
  if (p.endsWith("/metrics/costs") && costsHang)
    return new Promise<Response>(() => {});
  if (p.endsWith("/metrics/costs"))
    return costs === "error"
      ? json({ error: "x" }, 500)
      : costs === "slow"
        ? json({ error: "too slow", field: "since" }, 503)
        : json({ instance: "i", costs });
  // Agent 8's breakdown never answers: what is on screen while it loads is the test.
  if (
    p.endsWith("/metrics/breakdown") &&
    url.searchParams.get("agentId") === "8"
  )
    return new Promise<Response>(() => {});
  if (p.endsWith("/metrics/breakdown"))
    return json({ instance: "i", rows: BREAKDOWN });
  if (p.endsWith("/metrics/handoffs") && logExpired)
    return json({
      instance: "i",
      handoffs: {
        days: [],
        totals: [],
        silences: [],
        silenceDays: [],
        targets: [],
      },
    });
  if (p.endsWith("/metrics/handoffs"))
    return json({
      instance: "i",
      handoffs: {
        days: [{ date: handoffOn, cause: "person", conversations: 2 }],
        totals: [{ cause: "person", conversations: 2 }],
        silences: [{ reason: "needs_human", turns: 3 }],
        // Earlier than the first handoff: under "all time" the silences keep their own range.
        silenceDays: [{ date: "2026-09-25", reason: "needs_human", turns: 3 }],
        targets: [
          { cause: "skip_needs_human", target: "pinned", conversations: 2 },
        ],
      },
    });
  if (p.endsWith("/metrics/labels"))
    return json({ instance: "i", labels: { labels: [], unlabeled: 0 } });
  if (p.endsWith("/metrics/health") && healthFails)
    return json(
      healthFailField ? { error: "x", field: healthFailField } : { error: "x" },
      healthFailStatus,
    );
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
  if (p.endsWith("/metrics/filter-options") && optionsGate) await optionsGate;
  if (p.endsWith("/metrics/filter-options") && optionsFail)
    return json({ error: "x" }, 500);
  if (p.endsWith("/metrics/filter-options"))
    return json({
      agents: [
        { id: "7", name: "Ana" },
        { id: "8", name: "Beto" },
      ],
      inboxes: inboxOptions,
      flowLogRetentionDays: retentionDays,
      firstRecordAt,
    });
  return json({ error: "nope" }, 500);
}) as unknown as typeof globalThis.fetch;

let location = "";
function Where() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  return null;
}

async function renderDash(path = "/", settled = true, clientChannel?: boolean) {
  asked.length = 0;
  signals.length = 0;
  const page = (
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <DashboardPage />
        <Where />
      </MemoryRouter>
    </ThemeProvider>
  );
  render(
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
  if (!settled) return;
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
  healthFailStatus = 500;
  healthFailField = undefined;
  optionsFail = false;
  inboxOptions = ONE_INBOX;
  costsHang = false;
  retentionDays = 30;
  tenantGone = null;
  kpisFail = false;
  handoffOn = "2026-10-01";
  optionsGate = null;
  firstRecordAt = null;
  logExpired = false;
});
afterEach(cleanup);

describe("one filter, in the URL, for every block", () => {
  // The client segment exists only where the install runs the client channel: elsewhere a saved
  // `source=client` link reads as the default segment, so the figures match the control shown.
  test("a client link reads as the real segment with the channel off, and as itself with it on", async () => {
    await renderDash("/?range=7d&source=client");
    await waitFor(() =>
      expect(asks("/metrics/kpis").length).toBeGreaterThan(0),
    );
    expect(asks("/metrics/kpis")[0]?.searchParams.get("source")).toBe("inbox");
    cleanup();
    await renderDash("/?range=7d&source=client", true, true);
    await waitFor(() =>
      expect(asks("/metrics/kpis").length).toBeGreaterThan(0),
    );
    expect(asks("/metrics/kpis")[0]?.searchParams.get("source")).toBe("client");
  });

  test("an audience refines the client segment, and only that segment", async () => {
    await renderDash("/?range=7d&source=client&audience=anonymous", true, true);
    await waitFor(() => {
      expect(asks("/metrics/kpis").length).toBeGreaterThan(0);
    });
    const audienceOf = (path: string) =>
      asks(path)[0]?.searchParams.get("audience") ?? null;
    expect(audienceOf("/metrics/kpis")).toBe("anonymous");
    cleanup();
    await renderDash(
      "/?range=7d&source=playground&audience=anonymous",
      true,
      true,
    );
    await waitFor(() =>
      expect(asks("/metrics/kpis").length).toBeGreaterThan(0),
    );
    expect(audienceOf("/metrics/kpis")).toBeNull();
  });

  test("every block asks with the agent, inbox and segment the link names", async () => {
    await renderDash("/?range=7d&agent=7&inbox=3&source=playground");
    await waitFor(() => {
      expect(asks("/metrics/health").length).toBeGreaterThan(0);
      expect(asks("/metrics/knowledge").length).toBeGreaterThan(0);
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
    // The previous period, the same days a week earlier and cut at the time of day the view was
    // opened, is asked for what the comparisons need: the KPIs, the funnel trend and the costs.
    const [current, prev] = [...asks("/metrics/kpis")].sort((a, b) =>
      String(b.searchParams.get("until")).localeCompare(
        String(a.searchParams.get("until")),
      ),
    );
    const since = new Date(String(current?.searchParams.get("since")));
    const prevSince = new Date(String(prev?.searchParams.get("since")));
    const cut = new Date(String(prev?.searchParams.get("until")));
    expect(prevSince.getTime()).toBe(
      new Date(
        since.getFullYear(),
        since.getMonth(),
        since.getDate() - 7,
      ).getTime(),
    );
    const weekLater = new Date(
      cut.getFullYear(),
      cut.getMonth(),
      cut.getDate() + 7,
      cut.getHours(),
      cut.getMinutes(),
      cut.getSeconds(),
      cut.getMilliseconds(),
    );
    expect(Math.abs(Date.now() - weekLater.getTime())).toBeLessThan(60_000);
    // The view's own period is read up to that same opening instant.
    expect(new Date(String(current?.searchParams.get("until"))).getTime()).toBe(
      weekLater.getTime(),
    );
    const prevUntil = prev?.searchParams.get("until");
    const prevRoutes = asked
      .filter((u) => u.searchParams.get("until") === prevUntil)
      .map((u) => u.pathname.split("/metrics/")[1])
      .sort();
    expect([...new Set(prevRoutes)]).toEqual(["costs", "kpis", "outcomes"]);
  });

  test("one opening of the screen sends each distinct request once", async () => {
    await renderDash("/?range=30d");
    await waitFor(() => {
      expect(asks("/metrics/knowledge").length).toBeGreaterThan(0);
      expect(asks("/metrics/breakdown").length).toBeGreaterThan(0);
    });
    const sent = asked
      .filter((u) => u.pathname.includes("/metrics/"))
      .map((u) => `${u.pathname}?${[...u.searchParams].sort().join("&")}`);
    const twice = sent.filter((k, i) => sent.indexOf(k) !== i);
    expect(twice).toEqual([]);
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
      expect(asks("/metrics/kpis").length).toBeGreaterThan(0);
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

  test("two inboxes of one name are told apart by their account, and the one picked filters the page", async () => {
    inboxOptions = [
      { id: "3", name: "E-mail" },
      { id: "4", name: "SAC WhatsApp", account: { id: 1, name: "Main brand" } },
      { id: "5", name: "SAC WhatsApp", account: { id: 7, name: null } },
    ];
    await renderDash("/");
    const select = screen.getByRole("combobox", {
      name: "Inbox",
    }) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBe(4);
    });
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "All inboxes",
      "E-mail",
      "SAC WhatsApp · Main brand",
      "SAC WhatsApp · Account 7",
    ]);
    fireEvent.change(select, { target: { value: "5" } });
    await waitFor(() => {
      expect(location).toBe("/?inbox=5");
    });
    expect(select.selectedOptions[0]?.textContent).toBe(
      "SAC WhatsApp · Account 7",
    );
  });

  test("a link to one of two same-named inboxes opens with its account in the select", async () => {
    inboxOptions = [
      { id: "4", name: "SAC WhatsApp", account: { id: 1, name: "Main brand" } },
      { id: "5", name: "SAC WhatsApp", account: { id: 7, name: null } },
    ];
    await renderDash("/?inbox=4");
    const select = screen.getByRole("combobox", {
      name: "Inbox",
    }) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.selectedOptions[0]?.textContent).toBe(
        "SAC WhatsApp · Main brand",
      );
    });
    expect(location).toBe("/?inbox=4");
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
    // The figure on the agent's own row of the cache list.
    const shareOf = (name: string) =>
      Array.from(document.querySelectorAll("li"))
        .find(
          (li) => li.firstElementChild?.firstElementChild?.textContent === name,
        )
        ?.querySelector(".tabular-nums")?.textContent ?? null;
    await waitFor(() => {
      expect(shareOf("Ana")).toBe("60%");
    });
    expect(shareOf("Beto")).toBe("\u2014");
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

  test("a cost that cannot be read says so in its slot, with a retry", async () => {
    costs = "error";
    await renderDash("/");
    await waitFor(() => {
      expect(has("Could not read the cost.")).toBe(true);
    });
    expect(has("This period took too long to compute.")).toBe(false);
    // The tiles' retry and the two cost charts' retries.
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(
      3,
    );
  });

  test("a cost refused as too slow says the period took too long, in the tiles too", async () => {
    costs = "slow";
    await renderDash("/");
    await waitFor(() => {
      expect(
        screen.getAllByText(/This period took too long to compute/),
      ).toHaveLength(3);
    });
    expect(has("Could not read the cost.")).toBe(false);
  });
});

describe("a block whose request fails", () => {
  test("says so with a retry, never that nothing happened", async () => {
    healthFails = true;
    await renderDash("/");
    await waitFor(() => {
      expect(has("Warnings and errors")).toBe(true);
      // Both health blocks read the one route that failed; every other block shows its figures.
      expect(
        screen.queryAllByRole("button", { name: "Try again" }).length,
      ).toBe(2);
      expect(has("Steps delivered")).toBe(true);
    });
    expect(has("No warnings or errors in this period.")).toBe(false);
    const health = asks("/metrics/health").length;
    const kpisAsked = asks("/metrics/kpis").length;
    healthFails = false;
    // The problems block's retry: the latency block keeps its own failure until it is retried.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Try again" })[1] as HTMLElement,
    );
    await waitFor(() => {
      expect(asks("/metrics/health").length).toBeGreaterThan(health);
      expect(has("No warnings or errors in this period.")).toBe(true);
    });
    expect(screen.queryAllByRole("button", { name: "Try again" }).length).toBe(
      1,
    );
    // The retry asks the failed block again, and only it.
    expect(asks("/metrics/kpis").length).toBe(kpisAsked);
  });
});

describe("a retry", () => {
  test("belongs to its view: the next view asks a route two blocks share once again", async () => {
    healthFails = true;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(
        screen.queryAllByRole("button", { name: "Try again" }).length,
      ).toBe(2);
    });
    healthFails = false;
    fireEvent.click(
      screen.getAllByRole("button", { name: "Try again" })[1] as HTMLElement,
    );
    await waitFor(() => {
      expect(has("No warnings or errors in this period.")).toBe(true);
    });
    const before = asks("/metrics/health").length;
    fireEvent.click(screen.getByRole("radio", { name: "90d" }));
    await waitFor(() => {
      expect(location).toBe("/?range=90d");
      expect(asks("/metrics/health").length).toBeGreaterThan(before);
    });
    // Latency and problems read one request in the new view, whatever was retried in the old one.
    const fresh = asks("/metrics/health").slice(before);
    expect(new Set(fresh.map((u) => u.search)).size).toBe(fresh.length);
    expect(fresh.length).toBe(1);
  });
});

describe("a view replaced while its requests run", () => {
  test("aborts them, so they stop holding the metrics pool", async () => {
    costsHang = true;
    await renderDash("/?range=7d");
    const pending = signals.filter((s) =>
      s.url.pathname.endsWith("/metrics/costs"),
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((s) => s.signal && !s.signal.aborted)).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "90d" }));
    await waitFor(() => {
      expect(location).toBe("/?range=90d");
      expect(pending.every((s) => s.signal?.aborted)).toBe(true);
    });
  });
});

describe("filter options that answer after the metrics", () => {
  test("hold the flow-log blocks on their skeleton, with no claim and no CSV, until the retention is known", async () => {
    let release = () => {};
    optionsGate = new Promise<void>((r) => {
      release = r;
    });
    retentionDays = 30;
    await renderDash("/?range=7d", false);
    await waitFor(() => {
      expect(asks("/metrics/health").length).toBeGreaterThan(0);
      // A block that does not read the flow log shows at once.
      expect(screen.queryAllByRole("button", { name: "40" }).length).toBe(1);
    });
    expect(has("No warnings or errors in this period.")).toBe(false);
    expect(
      screen.queryAllByRole("button", { name: /Export Warnings and errors/ })
        .length,
    ).toBe(0);
    release();
    await waitFor(() => {
      expect(has("No warnings or errors in this period.")).toBe(true);
    });
  });
});

describe("filter options that cannot be read", () => {
  test("leave the flow-log blocks saying they could not load, never that there was none", async () => {
    const real = [...OPTIONS_RETRY_MS];
    OPTIONS_RETRY_MS.splice(0, 2, 0, 0);
    optionsFail = true;
    retentionDays = 30;
    logExpired = true;
    try {
      await renderDash("/?range=7d");
      await waitFor(() => {
        // Asked three times, then the blocks give up with their retry.
        expect(asks("/metrics/filter-options").length).toBe(3);
        expect(has("Could not load metrics.")).toBe(true);
      });
      expect(has("No handoffs in this period.")).toBe(false);
      expect(has("No warnings or errors in this period.")).toBe(false);
      // Their retry reads the options again, and once they answer the blocks show.
      optionsFail = false;
      fireEvent.click(
        screen.getAllByRole("button", { name: "Try again" })[0] as HTMLElement,
      );
      await waitFor(() => {
        expect(asks("/metrics/filter-options").length).toBe(4);
        expect(has("Handoffs by cause")).toBe(true);
      });
    } finally {
      OPTIONS_RETRY_MS.splice(0, 2, ...real);
    }
  });
});

describe("a block the server refused as too slow", () => {
  test("says the period took too long and keeps the retry, only for the period's 503", async () => {
    healthFails = true;
    healthFailStatus = 503;
    healthFailField = "since";
    await renderDash("/");
    await waitFor(() => {
      expect(has("This period took too long to compute.")).toBe(true);
      expect(
        screen.queryAllByRole("button", { name: "Try again" }).length,
      ).toBe(2);
    });
    expect(has("Could not load metrics.")).toBe(false);
    // Another 503 (the database down, a session that could not be read) and a 500 are not about the
    // period.
    for (const [status, field] of [
      [503, undefined],
      [500, undefined],
    ] as const) {
      cleanup();
      healthFailStatus = status;
      healthFailField = field;
      await renderDash("/");
      await waitFor(() => {
        expect(has("Could not load metrics.")).toBe(true);
      });
      expect(has("This period took too long to compute.")).toBe(false);
    }
  });
});

describe("every funnel tile opens the conversations it counts", () => {
  test("the automation rate is the resolution tile's second line, not a tile of its own", async () => {
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(has(/closed by the agent itself, 30% of every conversation/)).toBe(
        true,
      );
    });
    expect(screen.queryAllByRole("button", { name: "30%" }).length).toBe(0);
  });
});

describe("the funnel's own controls", () => {
  test("a split chosen on the trend survives a change of period", async () => {
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(screen.queryAllByRole("radio", { name: "By agent" }).length).toBe(
        1,
      );
    });
    fireEvent.click(screen.getByRole("radio", { name: "By agent" }));
    await waitFor(() => {
      expect(
        (screen.getByRole("radio", { name: "By agent" }) as HTMLInputElement)
          .checked,
      ).toBe(true);
      // The split is the route's own: the trend asks for the agents' series, and shows them.
      expect(
        asks("/metrics/outcomes").some(
          (u) => u.searchParams.get("breakdown") === "agent",
        ),
      ).toBe(true);
      expect(has("Ana")).toBe(true);
    });
    fireEvent.click(screen.getByRole("radio", { name: "90d" }));
    await waitFor(() => {
      expect(location).toBe("/?range=90d");
      expect(
        (screen.getByRole("radio", { name: "By agent" }) as HTMLInputElement)
          .checked,
      ).toBe(true);
    });
  });
});

describe("the funnel trend", () => {
  test("loads on its own: a failed KPI request leaves the trend and its controls in place", async () => {
    kpisFail = true;
    await renderDash("/?range=7d", false);
    await waitFor(() => {
      expect(has("Funnel over time")).toBe(true);
      expect(asks("/metrics/outcomes").length).toBeGreaterThan(0);
      // The KPIs' failure, with its retry, in their own slot.
      expect(has("Could not load metrics.")).toBe(true);
    });
    expect(screen.queryAllByRole("radio", { name: "By agent" }).length).toBe(1);
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
      expect(asks("/metrics/kpis").length).toBeGreaterThan(0);
    });
    expect(exportDaily().length).toBe(0);
    cleanup();
    costsHang = false;
    await renderDash("/");
    await waitFor(() => {
      expect(exportDaily().length).toBe(1);
    });
  });

  test("holds only itself: its skeleton sits in a status region while every other block shows its figures", async () => {
    // The costs route never answers; every other route does.
    costsHang = true;
    await renderDash("/");
    await waitFor(() => {
      expect(has("Steps delivered")).toBe(true);
      expect(screen.queryAllByRole("button", { name: "40" }).length).toBe(1);
    });
    const loading = screen
      .queryAllByRole("status")
      .filter((r) => r.textContent?.includes("Loading metrics"));
    // The four cost tiles and the cost charts that read the costs route, each in its own region.
    expect(loading.length).toBeGreaterThan(1);
    // Nothing on the page says the figures are partial or still being computed.
    expect(has("partial ·")).toBe(false);
    expect(has("days ready")).toBe(false);
    expect(document.querySelectorAll("[data-provisional]").length).toBe(0);
  });
});

describe("silences and where the transfers went", () => {
  test("silences have their own block with a table per day, and the pinned target shows apart", async () => {
    await renderDash("/");
    await waitFor(() => {
      expect(has("Silences by reason")).toBe(true);
      expect(has("To the pinned agent or team")).toBe(true);
    });
    // The per-day stand-in table names the reason as a column.
    const tables = [
      ...document.querySelectorAll(".sr-only > table caption"),
    ].map((c) => c.textContent);
    expect(tables).toContain("Silences by reason");
  });
});

describe("all time", () => {
  test("starts at the tenant's first record, so flow-log days past retention read as no data", async () => {
    retentionDays = 30;
    logExpired = true;
    firstRecordAt = new Date(Date.now() - 60 * 86_400_000).toISOString();
    await renderDash("/?range=all");
    await waitFor(() => {
      expect(has("no data for")).toBe(true);
      // Both flow-log charts keep the emptied days on their axis, under the band.
      expect(screen.queryAllByText(/no data · \d+ days/).length).toBe(2);
    });
    expect(has("No handoffs in this period.")).toBe(false);
    expect(has("No warnings or errors in this period.")).toBe(false);
  });

  test("silences before the first handoff keep their days", async () => {
    await renderDash("/?range=all");
    const rowsOf = (caption: string) =>
      [...document.querySelectorAll(".sr-only > table")]
        .find((t) => t.querySelector("caption")?.textContent === caption)
        ?.querySelectorAll("tbody tr").length ?? 0;
    await waitFor(() => {
      expect(rowsOf("Silences by reason")).toBeGreaterThan(0);
    });
    // Six more days: Sep 25 to Sep 30 come before the first handoff on Oct 1.
    expect(rowsOf("Silences by reason") - rowsOf("Handoffs by cause")).toBe(6);
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
      expect(has("median; p90 10 min, over 20 answered conversations")).toBe(
        true,
      );
    });
    // The median is the tile's figure.
    expect(has("95 sec")).toBe(true);
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
    const figures = () =>
      Object.fromEntries(
        Array.from(document.querySelectorAll("dl > div")).map((d) => [
          d.querySelector("dt")?.textContent,
          d.querySelector("dd")?.textContent,
        ]),
      );
    await waitFor(() => {
      expect(figures()).toMatchObject({
        "Steps delivered": "5",
        "Conversations reached": "3",
        "Customer wrote back": "2",
        "Closed by the last step": "1",
        Proposed: "4",
        "Waiting for review": "0",
        "Discarded by the reviewer": "1",
        Approved: "2",
        Rejected: "1",
      });
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

// A section is a column of rows. Two cards whose heights grow apart (one row per agent or per model
// beside a fixed card) each take a row of their own, so the short one is not stretched to the tall
// one's height. The answer is which direct child of the section holds each card's title.
describe("cards that grow apart each take their own row", () => {
  function rowOf(sectionId: string, title: string): number {
    const section = document.getElementById(sectionId);
    if (!section) return -1;
    return Array.from(section.children).findIndex((row) =>
      Array.from(row.querySelectorAll("h3")).some(
        // NOTE: The help button's "?" sits inside the heading.
        (h) => h.textContent?.replace(/\?$/, "").trim() === title,
      ),
    );
  }

  test("cached input by agent and the spend ceiling, in the cost section", async () => {
    await renderDash("/");
    await waitFor(() => {
      expect(rowOf("cost", "Spend ceiling")).toBeGreaterThan(-1);
    });
    const cache = rowOf("cost", "Cached input by agent");
    expect(cache).toBeGreaterThan(-1);
    expect(cache === rowOf("cost", "Spend ceiling")).toBe(false);
  });

  test("model call latency and warnings and errors, in the health section", async () => {
    await renderDash("/");
    const latency = rowOf("health", "Model call latency");
    const problems = rowOf("health", "Warnings and errors");
    expect(latency).toBeGreaterThan(-1);
    expect(problems).toBeGreaterThan(-1);
    expect(latency === problems).toBe(false);
  });

  test("follow-ups and knowledge suggestions, four figures each, still share a row", async () => {
    await renderDash("/");
    const followUps = rowOf("automation", "Follow-ups");
    expect(followUps).toBeGreaterThan(-1);
    expect(rowOf("automation", "Knowledge suggestions")).toBe(followUps);
  });
});

describe("a view whose flow-log days are past retention", () => {
  test("handoffs, silences and problems read as no data, never as none in the period", async () => {
    // No retention left: every day before today's has no lines.
    retentionDays = 0;
    logExpired = true;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(screen.queryAllByText(/no data · 6 days/).length).toBe(2);
    });
    expect(has("No handoffs in this period.")).toBe(false);
    expect(has("No silences in this period.")).toBe(false);
    expect(has("No warnings or errors in this period.")).toBe(false);
  });
});

describe("the health blocks", () => {
  test("latency covers the ledger's days, and only the problems say the flow log has none", async () => {
    // Three days of retention: the window's first three days have no lines.
    retentionDays = 3;
    await renderDash("/?range=7d");
    // The coverage chip sits in the block's heading.
    const card = (title: string) =>
      screen.getAllByText(title, { exact: false })[0]?.closest("h3");
    await waitFor(() => {
      expect(card("Warnings and errors")?.textContent).toContain(
        "no data for 3 days",
      );
    });
    expect(card("Model call latency")?.textContent).not.toContain(
      "no data for",
    );
  });
});

describe("a selected tenant deleted while the page loads", () => {
  test("drops the selection, as a refused selector on any other request does", async () => {
    setActiveTenantId("42");
    const w = window as unknown as Record<string, boolean | undefined>;
    // Already reloading: the test checks the selection is dropped, not the reload itself.
    w.__tenantSelectorReloading = true;
    tenantGone = "42";
    try {
      await renderDash("/?range=7d", false);
      await waitFor(() => {
        expect(getActiveTenantId()).toBeNull();
      });
    } finally {
      w.__tenantSelectorReloading = undefined;
      setActiveTenantId(null);
    }
  });
});

describe("days with no data", () => {
  test("are blank in a block's table, never zero", async () => {
    const cells = () =>
      [
        ...(screen
          .getAllByText("Handoffs by cause")
          .find((e) => e.tagName === "CAPTION")
          ?.closest("table")
          ?.querySelectorAll("tbody td") ?? []),
      ].map((td) => td.textContent);
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(cells()).toContain("0");
    });
    const zeros = cells().filter((c) => c === "0").length;
    cleanup();
    // No retention left: the six days before today's have no lines, and read blank.
    retentionDays = 0;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(cells().filter((c) => c === "").length).toBeGreaterThan(0);
    });
    expect(cells().filter((c) => c === "0").length).toBeLessThan(zeros);
  });
});

describe("a day past the cutoff the sweep has not reached yet", () => {
  test("shows its lines, as the totals count them, and only the days with none read as no data", async () => {
    const d = new Date();
    d.setDate(d.getDate() - 3);
    handoffOn = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    retentionDays = 0;
    await renderDash("/?range=7d");
    const rowOf = (day: string) =>
      [
        ...(screen
          .getAllByText("Handoffs by cause")
          .find((e) => e.tagName === "CAPTION")
          ?.closest("table")
          ?.querySelectorAll("tbody tr") ?? []),
      ]
        .map((tr) =>
          [...tr.querySelectorAll("th, td")].map((c) => c.textContent),
        )
        .find((cells) => cells[0]?.includes(day.slice(8)) ?? false);
    await waitFor(() => {
      expect(has("no data · 5 days")).toBe(true);
    });
    expect(rowOf(handoffOn)?.slice(1)).toContain("2");
  });
});

describe("a chart with days past retention", () => {
  test("keeps every day on its axis, marking the days with no data", async () => {
    retentionDays = 0;
    await renderDash("/?range=7d");
    await waitFor(() => {
      // The handoffs' days before today's have no data; the funnel trend's are all there.
      expect(has("no data · 6 days")).toBe(true);
    });
    expect(has("loading ·")).toBe(false);
    const table = screen
      .getAllByRole("table")
      .find(
        (t) => t.querySelector("caption")?.textContent === "Funnel over time",
      );
    expect(table?.querySelectorAll("tbody tr").length).toBe(7);
  });

  describe("switching to the preset a custom range matches", () => {
    test("asks the current period again too, so both periods reach the new opening", async () => {
      const d = (n: number) => {
        const x = new Date();
        x.setDate(x.getDate() + n);
        return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      };
      await renderDash(`/?range=custom&from=${d(-29)}&to=${d(0)}`);
      // The current period's KPIs: the later `since` of the two periods asked.
      const sinceOf = (u: URL) => u.searchParams.get("since") ?? "";
      const current = () => {
        const all = asks("/metrics/kpis");
        const latest = all.map(sinceOf).sort().at(-1);
        return all.filter((u) => sinceOf(u) === latest);
      };
      await waitFor(() => expect(current().length).toBe(1));
      const [first] = current();
      fireEvent.click(screen.getByRole("radio", { name: "30d" }));
      await waitFor(() => expect(current().length).toBe(2));
      const [, second] = current();
      expect(second?.searchParams.get("since")).toBe(
        first?.searchParams.get("since") ?? null,
      );
    });
  });

  describe("the instant a view is opened at", () => {
    afterEach(() => setSystemTime());

    test("holds while the view is the same, and moves with a new view or a new local day", () => {
      setSystemTime(new Date(2026, 9, 6, 23, 59, 0));
      const hook = renderHook(({ view }) => useOpenedAt(view), {
        initialProps: { view: "range=7d" },
      });
      const opened = hook.result.current;
      setSystemTime(new Date(2026, 9, 6, 23, 59, 30));
      hook.rerender({ view: "range=7d" });
      expect(hook.result.current).toBe(opened);
      hook.rerender({ view: "range=30d" });
      expect(hook.result.current.getTime()).toBe(
        new Date(2026, 9, 6, 23, 59, 30).getTime(),
      );
      setSystemTime(new Date(2026, 9, 7, 0, 0, 5));
      hook.rerender({ view: "range=30d" });
      expect(hook.result.current.getTime()).toBe(
        new Date(2026, 9, 7, 0, 0, 5).getTime(),
      );
    });
  });
});
