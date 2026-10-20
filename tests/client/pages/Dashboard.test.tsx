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
import { AuthContext } from "@/client/contexts/AuthContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import {
  getActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";
import { DashboardPage } from "@/client/pages/DashboardPage";
import { streamGrace } from "@/client/pages/dashboard/useStream";
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
// The status a failing health request answers with, and the field its refusal names.
let healthFailStatus = 500;
let healthFailField: string | undefined;
let costsHang = false;
let partialFlag = false;
let refuseFlag = false;
// The previous period's stream refused after its first days, while the view's own completes.
let prevRefused = false;
// A stream that closes after a partial snapshot, with no last snapshot and no refusal.
let endsEarly = false;
// The view's own stream still filling while the previous period's is complete.
let currentPartial = false;
// The tenant a SUPER_ADMIN selected, deleted while the view fills.
let tenantGone: string | null = null;
// A filling view whose server goes on to say every day is in while the next snapshot merges.
let computedAhead = false;
// A filling view whose last snapshot, complete, arrives this long after its first.
let completesAfterMs: number | null = null;
// The flow-log days of a filling view that have no figures yet.
let logGaps: [string, string][] = [];
// Of those, the days with no figures for good (retention).
let logNone: [string, string][] = [];
// The conversation days of a filling view that have no figures yet.
let convGaps: [string, string][] = [];
// The ledger stopped on a day past the time budget; every other family is in.
let ledgerRefused = false;
// A whole view whose flow-log days are all past retention and were never kept: no handoffs, no
// silences and no problems, because there is no data, not because there were none.
let logExpired = false;
let optionsFail = false;
const ONE_INBOX = [{ id: "3", name: "WhatsApp" }];
let inboxOptions: {
  id: string;
  name: string;
  account?: { id: number; name: string | null };
}[] = ONE_INBOX;

// What the per-block routes would answer, as the page's stream carries it: one snapshot with every
// requested block, `done`, or a refusal after the blocks that did arrive.
async function streamOf(url: URL): Promise<Response> {
  if (url.searchParams.get("agentId") === "8")
    return new Response(new ReadableStream({ start() {} }), {
      headers: { "content-type": "text/event-stream" },
    });
  const blocks = (url.searchParams.get("blocks") ?? "").split(",");
  const isPrev = url.searchParams.get("blocks") === "kpis,outcomes,costs";
  const partial =
    partialFlag || (isPrev && prevRefused) || (!isPrev && currentPartial);
  const refuseMidway = refuseFlag || (isPrev && prevRefused);
  const body = async (path: string, key: string) => {
    const u = new URL(url);
    u.pathname = path;
    const res = await stubFetch(u.toString());
    if (!res.ok) return undefined;
    return ((await res.json()) as Record<string, unknown>)[key];
  };
  const figures: Record<string, unknown> = {};
  if (blocks.includes("kpis"))
    figures.kpis = await body("/api/v1/metrics/kpis", "kpis");
  if (blocks.includes("outcomes")) {
    figures.trend = await body("/api/v1/metrics/outcomes", "trend");
    figures.series = {
      agent: [
        {
          key: "1",
          label: "Ana",
          totals: { total: 4, involved: 3, resolvedByBot: 2, handoff: 1 },
          days: [],
        },
      ],
      inbox: [],
    };
  }
  if (blocks.includes("costs") && !costsHang)
    figures.costs = await body("/api/v1/metrics/costs", "costs");
  if (blocks.includes("breakdown"))
    figures.breakdown = {
      agent: await body("/api/v1/metrics/breakdown", "rows"),
      inbox: await body("/api/v1/metrics/breakdown", "rows"),
      model: await body("/api/v1/metrics/breakdown", "rows"),
      node: await body("/api/v1/metrics/breakdown", "rows"),
    };
  if (blocks.includes("handoffs"))
    figures.handoffs = await body("/api/v1/metrics/handoffs", "handoffs");
  if (blocks.includes("labels"))
    figures.labels = await body("/api/v1/metrics/labels", "labels");
  if (blocks.includes("health") && !healthFails)
    figures.health = await body("/api/v1/metrics/health", "health");
  if (blocks.includes("followUps"))
    figures.followUps = await body("/api/v1/metrics/follow-ups", "followUps");
  if (blocks.includes("knowledge"))
    figures.knowledge = await body("/api/v1/metrics/knowledge", "knowledge");
  const c = { total: 7, ready: 7, noData: 0, gaps: [] };
  const progress = partial
    ? {
        total: 7,
        ready: 3,
        computing: ["2026-10-01", "2026-10-04"],
        pending: [["2026-10-01", "2026-10-04"]],
        families: {
          conv: { total: 7, ready: 3, noData: 0, gaps: convGaps },
          ledger: c,
          log: { total: 7, ready: 5, noData: 2, gaps: logGaps, none: logNone },
          know: c,
        },
      }
    : {
        total: 7,
        ready: ledgerRefused ? 3 : 7,
        computing: null,
        pending: [],
        families: {
          conv: c,
          ledger: ledgerRefused
            ? {
                total: 7,
                ready: 3,
                noData: 0,
                gaps: [["2000-01-01", "2100-12-31"]],
                refused: { status: 503, field: "since" },
              }
            : c,
          log: logExpired
            ? {
                total: 7,
                ready: 0,
                noData: 7,
                gaps: [["2000-01-01", "2100-12-31"]],
                none: [["2000-01-01", "2100-12-31"]],
              }
            : c,
          know: c,
        },
      };
  const done = !healthFails && !costsHang && !partial;
  const events = [
    // What the server says while the queue settles, before the window's days are known.
    `event: waiting\ndata: ${JSON.stringify({ kind: "waiting" })}\n\n`,
    `event: snapshot\ndata: ${JSON.stringify({ kind: "snapshot", progress, figures, done })}\n\n`,
    ...(computedAhead
      ? [
          `event: computing\ndata: ${JSON.stringify({ kind: "computing", progress: { total: 7, ready: 7, computing: null, pending: [], families: { conv: c, ledger: c, log: c, know: c } } })}\n\n`,
        ]
      : []),
    ...(tenantGone
      ? [
          `event: refused\ndata: ${JSON.stringify({ status: 404, error: "x", rejectedTenantId: tenantGone })}\n\n`,
        ]
      : (healthFails && blocks.includes("health")) || refuseMidway
        ? [
            `event: refused\ndata: ${JSON.stringify({ status: healthFailStatus, error: "x", ...(healthFailField ? { field: healthFailField } : {}) })}\n\n`,
          ]
        : []),
  ];
  const text = new TextEncoder().encode(events.join(""));
  const whole = {
    total: 7,
    ready: 7,
    computing: null,
    pending: [],
    families: { conv: c, ledger: c, log: c, know: c },
  };
  // A block still loading: the snapshot without it, on a stream that stays open.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(text);
      if (completesAfterMs !== null) {
        setTimeout(() => {
          controller.enqueue(
            new TextEncoder().encode(
              `event: snapshot\ndata: ${JSON.stringify({ kind: "snapshot", progress: whole, figures, done: true })}\n\n`,
            ),
          );
          controller.close();
        }, completesAfterMs);
        return;
      }
      // A view still filling keeps its stream open, unless it was refused or the test cuts it.
      if (!costsHang && (!partial || refuseMidway || endsEarly))
        controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

const stubFetch = (async (input: unknown) => {
  const url = new URL(
    String(typeof input === "string" ? input : (input as Request).url),
    "http://localhost",
  );
  const p = url.pathname;
  if (p.endsWith("/metrics/stream")) {
    asked.push(url);
    return streamOf(url);
  }
  if (!p.includes("/metrics/") || p.endsWith("/metrics/filter-options"))
    asked.push(url);
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
        days: [{ date: "2026-10-01", cause: "person", conversations: 2 }],
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
  if (p.endsWith("/metrics/filter-options") && optionsFail)
    return json({ error: "x" }, 500);
  if (p.endsWith("/metrics/filter-options"))
    return json({
      agents: [
        { id: "7", name: "Ana" },
        { id: "8", name: "Beto" },
      ],
      inboxes: inboxOptions,
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
  // Most cases read a partial view at once; the grace has its own cases.
  streamGrace.ms = 0;
  completesAfterMs = null;
  costs = COSTS;
  kpis = KPIS;
  ceilingPollMs = 300_000;
  healthFails = false;
  healthFailStatus = 500;
  healthFailField = undefined;
  optionsFail = false;
  inboxOptions = ONE_INBOX;
  costsHang = false;
  partialFlag = false;
  refuseFlag = false;
  prevRefused = false;
  endsEarly = false;
  currentPartial = false;
  tenantGone = null;
  logGaps = [];
  logNone = [];
  convGaps = [];
  ledgerRefused = false;
  logExpired = false;
  computedAhead = false;
});
afterEach(cleanup);

describe("one filter, in the URL, for every block", () => {
  // The client segment exists only where the install runs the client channel: elsewhere a saved
  // `source=client` link reads as the default segment, so the figures match the control shown.
  test("a client link reads as the real segment with the channel off, and as itself with it on", async () => {
    await renderDash("/?range=7d&source=client");
    await waitFor(() =>
      expect(asks("/metrics/stream").length).toBeGreaterThan(0),
    );
    expect(asks("/metrics/stream")[0]?.searchParams.get("source")).toBe(
      "inbox",
    );
    cleanup();
    await renderDash("/?range=7d&source=client", true, true);
    await waitFor(() =>
      expect(asks("/metrics/stream").length).toBeGreaterThan(0),
    );
    expect(asks("/metrics/stream")[0]?.searchParams.get("source")).toBe(
      "client",
    );
  });

  test("an audience refines the client segment, and only that segment", async () => {
    await renderDash("/?range=7d&source=client&audience=anonymous", true, true);
    await waitFor(() => {
      expect(asks("/metrics/stream").length).toBeGreaterThan(0);
    });
    const audienceOf = (path: string) =>
      asks(path)[0]?.searchParams.get("audience") ?? null;
    expect(audienceOf("/metrics/stream")).toBe("anonymous");
    cleanup();
    await renderDash(
      "/?range=7d&source=playground&audience=anonymous",
      true,
      true,
    );
    await waitFor(() =>
      expect(asks("/metrics/stream").length).toBeGreaterThan(0),
    );
    expect(audienceOf("/metrics/stream")).toBeNull();
  });

  test("every block asks with the agent, inbox and segment the link names", async () => {
    await renderDash("/?range=7d&agent=7&inbox=3&source=playground");
    await waitFor(() => {
      expect(asks("/metrics/stream").length).toBe(2);
    });
    for (const u of asks("/metrics/stream")) {
      expect(u.searchParams.get("agentId")).toBe("7");
      expect(u.searchParams.get("inboxId")).toBe("3");
      expect(u.searchParams.get("source")).toBe("playground");
      expect(Boolean(u.searchParams.get("until"))).toBe(true);
    }
    // One stream carries every block of the view; the previous period's, as long as this one and
    // ending where it starts, carries what the comparisons need.
    const [current, prev] = [...asks("/metrics/stream")].sort((a, b) =>
      String(b.searchParams.get("until")).localeCompare(
        String(a.searchParams.get("until")),
      ),
    );
    expect(current?.searchParams.get("blocks")?.split(",").sort()).toEqual([
      "breakdown",
      "costs",
      "followUps",
      "handoffs",
      "health",
      "knowledge",
      "kpis",
      "labels",
      "outcomes",
    ]);
    expect(prev?.searchParams.get("until")).toBe(
      current?.searchParams.get("since"),
    );
    expect(prev?.searchParams.get("blocks")).toBe("kpis,outcomes,costs");
  });

  test("one opening of the screen sends each distinct request once", async () => {
    await renderDash("/?range=30d");
    await waitFor(() => {
      expect(asks("/metrics/stream").length).toBe(2);
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
      expect(asks("/metrics/stream").length).toBeGreaterThan(0);
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
      // Both health blocks, and the page's line: the stream stopped before it was done.
      expect(
        screen.queryAllByRole("button", { name: "Try again" }).length,
      ).toBe(3);
    });
    expect(has("No warnings or errors in this period.")).toBe(false);
    const before = asks("/metrics/stream").length;
    healthFails = false;
    fireEvent.click(
      screen.getAllByRole("button", { name: "Try again" })[0] as HTMLElement,
    );
    await waitFor(() => {
      expect(asks("/metrics/stream").length).toBeGreaterThan(before);
      expect(has("No warnings or errors in this period.")).toBe(true);
    });
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
      ).toBe(3);
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

describe("a block still loading", () => {
  test("offers no CSV until its figures arrive", async () => {
    const exportDaily = () =>
      screen.queryAllByRole("button", { name: "Export Daily cost as CSV" });
    costsHang = true;
    await renderDash("/");
    await waitFor(() => {
      expect(has("Daily cost")).toBe(true);
      expect(asks("/metrics/stream").length).toBeGreaterThan(0);
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

describe("a view still filling", () => {
  test("each block says how many of its days are in, and flow-log days nothing can fill read as no data", async () => {
    partialFlag = true;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(has("partial · 3 of 7 days")).toBe(true);
      expect(has("3 of 7 days ready · computing")).toBe(true);
      expect(has("no data for 2 days")).toBe(true);
    });
    cleanup();
    partialFlag = false;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "40" }).length).toBe(1);
    });
    // A whole block shows nothing in the place of the partial badge.
    expect(screen.queryAllByText("complete", { exact: true })).toEqual([]);
    expect(has("partial ·")).toBe(false);
    expect(has("days ready")).toBe(false);
  });
});

describe("a whole view whose flow-log days are past retention and were never kept", () => {
  test("handoffs, silences and problems read as no data, never as none in the period", async () => {
    logExpired = true;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(screen.queryAllByText(/no data · 7 days/).length).toBe(2);
    });
    expect(has("No handoffs in this period.")).toBe(false);
    expect(has("No silences in this period.")).toBe(false);
    expect(has("No warnings or errors in this period.")).toBe(false);
  });
});

describe("the funnel split by agent while the view fills", () => {
  test("reads each agent's figure in the period as provisional, as the funnel does", async () => {
    partialFlag = true;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(screen.queryAllByRole("radio", { name: "By agent" }).length).toBe(
        1,
      );
    });
    fireEvent.click(screen.getByRole("radio", { name: "By agent" }));
    const card = await waitFor(() => {
      const heading = screen
        .getAllByRole("heading", { level: 3 })
        .find((h) => /in the period/.test(h.textContent ?? ""));
      // The card: the nearest box around the heading that holds the agents' rows.
      let box: HTMLElement | null = heading ?? null;
      while (box && !box.textContent?.includes("Ana")) box = box.parentElement;
      if (!box) throw new Error("no per-agent card yet");
      return box;
    });
    expect(card.querySelector("[data-provisional]")).not.toBeNull();
    expect(card.textContent).toContain("partial · 3 of 7 days");
  });
});

describe("a previous period that did not fill", () => {
  test("compares nothing against the families whose days were not all in", async () => {
    const compared = () =>
      screen.queryAllByText("previous:", { exact: false }).length;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(has("Steps delivered")).toBe(true);
      expect(compared()).toBeGreaterThan(0);
    });
    const whole = compared();
    cleanup();
    // The previous period's conversations stopped at 3 of 7 days; its ledger was all in.
    prevRefused = true;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(has("Steps delivered")).toBe(true);
      expect(compared()).toBeGreaterThan(0);
    });
    expect(compared()).toBeLessThan(whole);
  });
});

describe("a view still filling beside a complete previous period", () => {
  test("compares nothing while the view's own days are not all in", async () => {
    const compared = () =>
      screen.queryAllByText("previous:", { exact: false }).length;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(has("Steps delivered")).toBe(true);
      expect(compared()).toBeGreaterThan(0);
    });
    const whole = compared();
    cleanup();
    // The view's conversations are at 3 of 7 days; its ledger is all in.
    currentPartial = true;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(has("partial · 3 of 7 days")).toBe(true);
      expect(compared()).toBeGreaterThan(0);
    });
    expect(compared()).toBeLessThan(whole);
  });
});

describe("the health blocks", () => {
  test("latency covers the ledger's days, and only the problems say the flow log has none", async () => {
    partialFlag = true;
    await renderDash("/?range=7d");
    // The coverage chip sits in the block's heading.
    const card = (title: string) =>
      screen.getAllByText(title, { exact: false })[0]?.closest("h3");
    await waitFor(() => {
      expect(card("Warnings and errors")?.textContent).toContain(
        "no data for 2 days",
      );
    });
    expect(card("Model call latency")?.textContent).not.toContain(
      "no data for",
    );
  });
});

describe("a selected tenant deleted while the view fills", () => {
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

describe("a family stopped on a day past the time budget", () => {
  test("refuses its own blocks, and the others show their figures", async () => {
    ledgerRefused = true;
    await renderDash("/?range=7d", false);
    await waitFor(() => {
      expect(has("This period took too long to compute")).toBe(true);
      expect(has("Steps delivered")).toBe(true);
    });
  });
});

describe("a period's tiles while it fills", () => {
  test("open no list until every day of the period is in", async () => {
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "40" }).length).toBe(1);
    });
    cleanup();
    partialFlag = true;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(has("partial · 3 of 7 days")).toBe(true);
    });
    // The count is of three days; the list would be of seven.
    expect(screen.queryAllByRole("button", { name: "40" }).length).toBe(0);
  });

  test("a block reads the coverage its figures were merged at, not the days computed since", async () => {
    partialFlag = true;
    computedAhead = true;
    await renderDash("/?range=7d");
    // The line under the filter follows the server; the blocks wait for the figures.
    await waitFor(() => {
      expect(has("7 of 7 days ready")).toBe(true);
    });
    expect(has("partial · 3 of 7 days")).toBe(true);
    expect(screen.queryAllByRole("button", { name: "40" }).length).toBe(0);
  });
});

describe("days with no figures yet", () => {
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
    cleanup();
    partialFlag = true;
    logGaps = [["2000-01-01", "2100-12-31"]];
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(cells().length).toBeGreaterThan(0);
    });
    expect(cells()).not.toContain("0");
  });
});

describe("a figure that does not cover its window yet", () => {
  test("a chart keeps every day on its axis, marking the days loading apart from those with no data", async () => {
    partialFlag = true;
    convGaps = [["2000-01-01", "2100-12-31"]];
    logGaps = [["2000-01-01", "2100-12-31"]];
    logNone = [["2000-01-01", "2100-12-31"]];
    await renderDash("/?range=7d");
    await waitFor(() => {
      // The funnel trend's days are all still loading; the handoffs' are no data for good.
      expect(has("loading · 7 days")).toBe(true);
      expect(has("no data · 7 days")).toBe(true);
    });
    const table = screen
      .getAllByRole("table")
      .find(
        (t) => t.querySelector("caption")?.textContent === "Funnel over time",
      );
    expect(table?.querySelectorAll("tbody tr").length).toBe(7);
  });

  test("reads as provisional in its own card, with the badge and a bar of the days in, until it is whole", async () => {
    const provisional = (state: string) =>
      document.querySelectorAll(`[data-provisional="${state}"]`).length;
    const bars = () =>
      [...document.querySelectorAll('[role="progressbar"]')].filter(
        (b) =>
          b.getAttribute("aria-valuenow") === "3" &&
          b.getAttribute("aria-valuemax") === "7",
      ).length;
    partialFlag = true;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(has("partial · 3 of 7 days")).toBe(true);
      // Five KPI tiles, each pulsing with its own badge and bar.
      expect(provisional("arriving")).toBeGreaterThanOrEqual(5);
      expect(bars()).toBeGreaterThanOrEqual(5);
    });
    expect(
      screen.getAllByText("partial · 3 of 7 days").length,
    ).toBeGreaterThanOrEqual(6);
    cleanup();
    partialFlag = false;
    await renderDash("/?range=7d");
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "40" }).length).toBe(1);
    });
    expect(provisional("arriving")).toBe(0);
    expect(provisional("stopped")).toBe(0);
    expect(bars()).toBe(0);
  });

  test("stops pulsing when its stream fails, since nothing is loading any more", async () => {
    partialFlag = true;
    endsEarly = true;
    await renderDash("/?range=7d", false);
    // A stream that ends short of its figures shows its retry: nothing it left reads as loading.
    await waitFor(() => {
      expect(
        screen.queryAllByRole("button", { name: "Try again" }).length,
      ).toBeGreaterThan(0);
    });
    expect(
      document.querySelectorAll('[data-provisional="arriving"]').length,
    ).toBe(0);
  });
});

describe("a view that completes within the stream's grace", () => {
  // Anything that would read as partial, seen at any moment of the opening.
  const watchPartial = () => {
    const seen: string[] = [];
    const look = () => {
      const text = document.body.textContent ?? "";
      if (/partial ·|days ready/.test(text)) seen.push("badge or line");
      if (document.querySelector("[data-provisional]"))
        seen.push("provisional");
      if (document.querySelector('[role="progressbar"][aria-valuemax="7"]'))
        seen.push("bar");
    };
    const observer = new MutationObserver(look);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    return { seen, stop: () => observer.disconnect() };
  };

  test("shows its figures as final, with no partial badge, pulse or bar at any moment", async () => {
    streamGrace.ms = 1500;
    partialFlag = true;
    completesAfterMs = 500;
    const watch = watchPartial();
    await renderDash("/?range=7d", false);
    await waitFor(
      () => {
        expect(screen.queryAllByRole("button", { name: "40" }).length).toBe(1);
      },
      { timeout: 3000 },
    );
    watch.stop();
    expect(watch.seen).toEqual([]);
  });

  test("still filling once the grace has passed, it shows the partial badge, pulse and bar", async () => {
    streamGrace.ms = 1500;
    partialFlag = true;
    const watch = watchPartial();
    await renderDash("/?range=7d", false);
    await waitFor(
      () => {
        expect(has("partial · 3 of 7 days")).toBe(true);
        expect(
          document.querySelectorAll('[data-provisional="arriving"]').length,
        ).toBeGreaterThan(0);
      },
      { timeout: 4000 },
    );
    watch.stop();
  });
});

describe("a stream cut before its last snapshot", () => {
  test("reads as failed, with a retry, not as still computing", async () => {
    partialFlag = true;
    endsEarly = true;
    await renderDash("/?range=7d", false);
    await waitFor(() => {
      expect(
        screen.queryAllByRole("button", { name: "Try again" }).length,
      ).toBeGreaterThan(0);
    });
    expect(has("days ready · computing")).toBe(false);
  });
});

describe("a view refused while it fills", () => {
  test("says so with a retry, and no block passes its first days off as the period", async () => {
    partialFlag = true;
    refuseFlag = true;
    healthFailStatus = 503;
    healthFailField = "since";
    await renderDash("/?range=7d", false);
    await waitFor(() => {
      expect(has("This period took too long to compute")).toBe(true);
    });
    expect(has("days ready")).toBe(false);
    // The funnel's days were partial when the stream stopped: the refusal, never 3 days as the period.
    expect(has("partial ·")).toBe(false);
    expect(has("Automation funnel")).toBe(false);
    // Blocks whose families were all in keep their figures.
    expect(has("Steps delivered")).toBe(true);
    expect(
      screen.queryAllByRole("button", { name: "Try again" }).length,
    ).toBeGreaterThan(1);
  });
});
