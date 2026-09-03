import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { buildCostTrend, DashboardPage } from "@/client/pages/DashboardPage";
import { withI18n } from "@/tests/utils/i18n";

// THE CEILING ON THE PAGE WHERE SPEND IS WATCHED (issue #427). The figures existed behind a
// settings tab, so the number an operator opens the console to see had nothing to be measured
// against. What is asserted here is what the operator reads: the half of the ceiling that matches
// the segment they picked, and the period the bar actually covers.

const realFetch = globalThis.fetch;

let usage: Record<string, unknown> = {};
const asked: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const KPIS = {
  totalConversations: 40,
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

const stubFetch = (async (input: unknown) => {
  const url = String(
    typeof input === "string" ? input : ((input as Request).url ?? input),
  );
  asked.push(url);
  if (url.includes("/metrics/kpis")) return json({ instance: "i", kpis: KPIS });
  if (url.includes("/agents")) return json({ agents: [] });
  if (url.includes("/metrics/costs"))
    return json({ costs: { status: "error" } });
  if (url.includes("/metrics/timeseries")) return json({ points: [] });
  if (url.includes("/spend-ceiling/usage"))
    return json({ instance: {}, ...usage });
  if (url.includes("/metrics"))
    return json({ instance: "i", metrics: METRICS });
  return json({ error: "nope" }, 500);
}) as unknown as typeof globalThis.fetch;

const entry = (patch: Record<string, unknown> & { source: string }) => ({
  carriedUsd: 0,
  usedUsd: 0,
  ceilingUsd: null,
  state: "allowed",
  polledAt: "2026-09-03T11:58:00.000Z",
  pollError: null,
  pollFailedAt: null,
  stale: false,
  tracedCalls: 0,
  costedCalls: 0,
  ledgerCalls: 0,
  unpricedModels: [],
  ...patch,
});

const baseUsage = () => ({
  periodStart: "2026-09-01T00:00:00.000Z",
  langfuseConfigured: true,
  legacyTokens: null,
  pollIntervalMs: 300_000,
  entries: [
    entry({ source: "inbox", usedUsd: 22.5, ceilingUsd: 30, state: "warning" }),
    entry({
      source: "playground",
      usedUsd: 4.25,
      ceilingUsd: 5,
      state: "over",
    }),
  ],
});

async function renderDash(u: Record<string, unknown> = baseUsage()) {
  usage = u;
  asked.length = 0;
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

const has = (text: string | RegExp) =>
  screen.queryAllByText(text, { exact: false }).length > 0;

// THE CHART'S RATIO IS REAL-ONLY TOO (review round 1). The aggregate card was gated and the daily
// line was not: its divisor is our own conversation count, and a playground turn has no
// conversation, so dividing combined or playground-only cost by it draws a cost per conversation
// those dollars never had.
describe("the daily cost-per-conversation line", () => {
  // The day key is DERIVED, not written down: `buildCostTrend` builds its window from `Date.now()`,
  // so a hard-coded date falls out of a 7-day window the moment the calendar passes it and the test
  // starts failing on every run for a reason that has nothing to do with the code (review round 2).
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const points = [{ bucket: key, calls: 4, conversations: 2 }] as Parameters<
    typeof buildCostTrend
  >[0];
  const costDays = [{ date: key, costUsd: 10 }];

  test("is drawn in the real segment", () => {
    const out = buildCostTrend(points, costDays, "7d", "inbox");
    expect(out.some((d) => d.costPerConv === 5)).toBe(true);
  });

  test("is absent outside it, where the divisor is not the same traffic", () => {
    for (const source of ["playground", "all"] as const) {
      const out = buildCostTrend(points, costDays, "7d", source);
      expect(out.every((d) => d.costPerConv === null)).toBe(true);
      // The cost itself still travels: only the ratio is withheld.
      expect(out.some((d) => d.cost === 10)).toBe(true);
    }
  });
});

describe("the spend ceiling on the dashboard", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(cleanup);

  // The bar follows the SEGMENT the operator picked, because the ceiling is enforced per half and a
  // single figure would answer neither question.
  test("the selected segment's half of the ceiling is what the bar shows", async () => {
    await renderDash();
    await waitFor(() => {
      expect(has("$22.50 of $30.00")).toBe(true);
    });
    expect(has("$4.25 of $5.00")).toBe(false);
  });

  // THE PERIOD IS THE CALENDAR MONTH, AND THE PAGE'S SELECTOR SAYS 7d / 30d / 90d / all. A bar that
  // silently ignored that selector would read as a bug on the one page where everything else obeys
  // it, so the card names its own period. The month comes from `periodStart`, formatted in UTC: the
  // instant is the month's UTC midnight, and a browser west of it would print the month before.
  test("the card names the calendar month, not the selected period", async () => {
    // Pinned WEST of UTC on purpose. `periodStart` is the month's UTC midnight, so an operator in
    // Los Angeles reading a locally-formatted label would be told the ceiling covers August while
    // the gate is enforcing September. The test runner itself resolves to UTC, where the two agree
    // and the bug is invisible, so the zone is set here rather than inherited.
    const tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      await renderDash();
      await waitFor(() => {
        expect(has("September 2026")).toBe(true);
      });
      expect(has("August 2026")).toBe(false);
      expect(has("the calendar month")).toBe(true);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  test("switching to the playground shows the playground's half", async () => {
    await renderDash();
    await waitFor(() => {
      expect(has("$22.50 of $30.00")).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Playground" }));
    await waitFor(() => {
      expect(has("$4.25 of $5.00")).toBe(true);
    });
  });

  // AND THE COST BESIDE IT IS ASKED FOR THE SAME SEGMENT (issue #427). The two figures sit in one
  // row, so a cost fetched for everything next to a ceiling fetched for one half would be two
  // different questions rendered as one answer.
  test("the cost is asked for the segment the ceiling is showing", async () => {
    await renderDash();
    await waitFor(() => {
      expect(has("$22.50 of $30.00")).toBe(true);
    });
    const costCalls = () => asked.filter((u) => u.includes("/metrics/costs"));
    await waitFor(() => {
      expect(costCalls().some((u) => u.includes("source=inbox"))).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Playground" }));
    await waitFor(() => {
      expect(costCalls().some((u) => u.includes("source=playground"))).toBe(
        true,
      );
    });
    // "All" is our two environments, and the query says so by leaving the segment off.
    const segments = screen.getByRole("group", { name: "Usage segment" });
    fireEvent.click(within(segments).getByRole("button", { name: "All" }));
    await waitFor(() => {
      expect(costCalls().some((u) => !u.includes("source="))).toBe(true);
    });
  });

  // COST PER CONVERSATION IS A REAL-TRAFFIC NUMBER (issue #427). Its divisor is the funnel's
  // conversation count, which is real traffic and is not re-read per segment, so showing it beside
  // the playground's cost would divide one half's money by the other half's conversations.
  test("cost per conversation does not follow the cost into the playground", async () => {
    const withCost = (async (input: unknown) => {
      const url = String(
        typeof input === "string" ? input : ((input as Request).url ?? input),
      );
      asked.push(url);
      if (url.includes("/metrics/costs"))
        return json({
          costs: {
            status: "ok",
            totalCostUsd: 8,
            days: [{ date: "2026-09-01", costUsd: 8 }],
            byModel: [],
            baseUrl: "https://lf.example",
          },
        });
      return stubFetch(input as RequestInfo);
    }) as unknown as typeof globalThis.fetch;
    globalThis.fetch = withCost;
    try {
      await renderDash();
      await waitFor(() => {
        expect(has("Cost / conversation")).toBe(true);
      });
      const segments = screen.getByRole("group", { name: "Usage segment" });
      fireEvent.click(
        within(segments).getByRole("button", { name: "Playground" }),
      );
      await waitFor(() => {
        expect(has("$4.25 of $5.00")).toBe(true);
      });
      expect(has("Cost / conversation")).toBe(false);
    } finally {
      globalThis.fetch = stubFetch;
    }
  });

  // A FIGURE HIGHER THAN THE PROJECT'S OWN TOTAL EXPLAINS ITSELF (issue #427). The cost card and the
  // ceiling now sit on one screen, and a row that carried spend from a Langfuse project the tenant
  // left reads higher than the cost beside it. Measured on the live pass: $10.02 of $5.00 next to a
  // cost card reading $5.01, with nothing on the page saying why.
  test("spend carried from a project the tenant left is named", async () => {
    const u = baseUsage();
    u.entries = [
      entry({
        source: "inbox",
        usedUsd: 10.02,
        ceilingUsd: 5,
        state: "over",
        carriedUsd: 5.01,
      }),
      entry({ source: "playground" }),
    ];
    await renderDash(u);
    await waitFor(() => {
      expect(has("$10.02 of $5.00")).toBe(true);
    });
    expect(has("$5.01")).toBe(true);
    expect(has("no longer points at")).toBe(true);
  });

  // THE PAGE ASKS AGAIN WHILE IT STAYS OPEN (review round 1). The poll writes a new figure every
  // period and the health beside the bar is computed per read, so a dashboard left on a wall screen
  // would keep showing the first read's figure and its "refreshed" line for as long as it is up.
  test("a dashboard left open re-reads the ceiling on the poll's period", async () => {
    const u = baseUsage();
    u.pollIntervalMs = 40;
    await renderDash(u);
    await waitFor(() => {
      expect(has("$22.50 of $30.00")).toBe(true);
    });
    const reads = () =>
      asked.filter((x) => x.includes("/spend-ceiling/usage")).length;
    const first = reads();
    await waitFor(() => {
      expect(reads()).toBeGreaterThan(first);
    });
  });

  // AND IT REFRESHES QUIETLY (review round 2): the timer reads the ceiling alone, so the usage
  // section is not put back into its skeleton every period, and does not sit blank for as long as a
  // slow Langfuse cost request takes.
  test("the periodic re-read does not reload the rest of the section", async () => {
    const u = baseUsage();
    u.pollIntervalMs = 40;
    await renderDash(u);
    await waitFor(() => {
      expect(has("$22.50 of $30.00")).toBe(true);
    });
    const metricsBefore = asked.filter(
      (x) => x.includes("/metrics") && !x.includes("/spend-ceiling"),
    ).length;
    const ceilingBefore = asked.filter((x) =>
      x.includes("/spend-ceiling/usage"),
    ).length;
    await waitFor(() => {
      expect(
        asked.filter((x) => x.includes("/spend-ceiling/usage")).length,
      ).toBeGreaterThan(ceilingBefore);
    });
    expect(
      asked.filter(
        (x) => x.includes("/metrics") && !x.includes("/spend-ceiling"),
      ).length,
    ).toBe(metricsBefore);
    // And the figures stayed on screen: no skeleton took their place.
    expect(has("$22.50 of $30.00")).toBe(true);
  });

  // AND THE QUIET REFRESH CANNOT LAND OVER A SEGMENT SWITCH (review round 2). The timer and the
  // segment loader both write the ceiling, so a refresh that went out before the switch and answers
  // after it would put the previous read back under the newly selected segment.
  test("a refresh in flight when the segment changes is dropped", async () => {
    let releaseRefresh: (() => void) | null = null;
    let usageCalls = 0;
    const held = (async (input: unknown) => {
      const url = String(
        typeof input === "string" ? input : ((input as Request).url ?? input),
      );
      asked.push(url);
      if (url.includes("/spend-ceiling/usage")) {
        usageCalls += 1;
        if (usageCalls === 2) {
          await new Promise<void>((r) => {
            releaseRefresh = r;
          });
          const stale = baseUsage();
          stale.entries = [
            entry({ source: "inbox", usedUsd: 99, ceilingUsd: 100 }),
            entry({ source: "playground", usedUsd: 99, ceilingUsd: 100 }),
          ];
          return json({ instance: {}, ...stale });
        }
        return json({ instance: {}, ...usage });
      }
      return stubFetch(input as RequestInfo);
    }) as unknown as typeof globalThis.fetch;
    globalThis.fetch = held;
    try {
      const u = baseUsage();
      u.pollIntervalMs = 40;
      usage = u;
      asked.length = 0;
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
        expect(releaseRefresh).not.toBeNull();
      });
      const segments = await screen.findByRole("group", {
        name: "Usage segment",
      });
      fireEvent.click(
        within(segments).getByRole("button", { name: "Playground" }),
      );
      await waitFor(() => {
        expect(has("$4.25 of $5.00")).toBe(true);
      });
      await act(async () => {
        (releaseRefresh as (() => void) | null)?.();
        for (let i = 0; i < 5; i += 1) {
          await new Promise((r) => setTimeout(r, 0));
        }
      });
      expect(has("$99.00 of $100.00")).toBe(false);
      expect(has("$4.25 of $5.00")).toBe(true);
    } finally {
      globalThis.fetch = stubFetch;
    }
  });

  // AND AN OLDER SEGMENT'S ANSWER NEVER LANDS OVER A NEWER ONE (review round 1). Switching segments
  // starts a second load while the first is still out; the older answer landing last would put the
  // inbox cost card beside the playground ceiling, one row showing two different questions.
  test("an older segment's load does not land over the newer one", async () => {
    let releaseFirst: (() => void) | null = null;
    let costCalls = 0;
    const slowInbox = (async (input: unknown) => {
      const url = String(
        typeof input === "string" ? input : ((input as Request).url ?? input),
      );
      asked.push(url);
      if (url.includes("/metrics/costs")) {
        costCalls += 1;
        if (costCalls === 1) {
          await new Promise<void>((r) => {
            releaseFirst = r;
          });
          return json({
            costs: {
              status: "ok",
              totalCostUsd: 111,
              days: [],
              byModel: [],
              baseUrl: "https://lf.example",
            },
          });
        }
        return json({
          costs: {
            status: "ok",
            totalCostUsd: 22,
            days: [],
            byModel: [],
            baseUrl: "https://lf.example",
          },
        });
      }
      return stubFetch(input as RequestInfo);
    }) as unknown as typeof globalThis.fetch;
    globalThis.fetch = slowInbox;
    try {
      usage = baseUsage();
      asked.length = 0;
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
        expect(releaseFirst).not.toBeNull();
      });
      const segments = await screen.findByRole("group", {
        name: "Usage segment",
      });
      fireEvent.click(
        within(segments).getByRole("button", { name: "Playground" }),
      );
      await waitFor(() => {
        expect(has("$22.00")).toBe(true);
      });
      await act(async () => {
        (releaseFirst as (() => void) | null)?.();
        for (let i = 0; i < 5; i += 1) {
          await new Promise((r) => setTimeout(r, 0));
        }
      });
      // The inbox answer arrived last and was dropped: the playground's figures still stand.
      expect(has("$111.00")).toBe(false);
      expect(has("$22.00")).toBe(true);
      expect(has("$4.25 of $5.00")).toBe(true);
    } finally {
      globalThis.fetch = stubFetch;
    }
  });

  // THE FLAG AND THE ROWS ARE TWO THINGS (review round 2, and rounds 9-10 of #426). The flag is the
  // credential's present; each row is its own last reading, and the gate acts on the row. A
  // credential removed after a good poll leaves the gate refusing on that figure until the next
  // poll writes the sentinel, so the notice appears ABOVE the bars and does not replace them.
  test("without Langfuse the notice appears, and the bars still do", async () => {
    const u = baseUsage();
    u.langfuseConfigured = false;
    await renderDash(u);
    await waitFor(() => {
      expect(has("cost cannot be read")).toBe(true);
    });
    expect(has("$22.50 of $30.00")).toBe(true);
  });

  // The usage read follows the same window the rest of the section does: it is asked once per
  // segment, not once per page load, and the card is not there to make a second Langfuse call.
  test("the ceiling is read from our own snapshot, not from Langfuse", async () => {
    await renderDash();
    await waitFor(() => {
      expect(has("$22.50 of $30.00")).toBe(true);
    });
    expect(
      asked.filter((u) => u.includes("/spend-ceiling/usage")).length,
    ).toBeGreaterThan(0);
  });
});
