/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

const { DatabasePage } = await import(
  "@/client/pages/admin/database/DatabasePage"
);
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const { ToastProvider } = await import("@/client/components/Toast");
const { default: i18n } = await import("@/client/lib/i18n");

// The Database screen as a super admin uses it: the window and the sort change what is listed, a
// database without pg_stat_statements says how to enable it, and a tenant admin never sees it.
//
// Assertions reduce to strings or booleans before `expect`: a failing expectation that holds a DOM
// node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const row = (
  query: string,
  calls: number,
  totalMs: number,
  budgetMs = 1000,
) => ({
  queryid: query,
  userid: "10",
  query,
  calls,
  rows: calls,
  totalMs,
  meanMs: totalMs / calls,
  budgetMs,
  meanBudgetPct: (totalMs / calls / budgetMs) * 100,
  spark: [1, null, 2, 3],
});

const MANY_CHEAP = row("SELECT cheap FROM a WHERE x = $1", 2000, 2000);
const FEW_SLOW = row("SELECT slow FROM b WHERE y = $1", 5, 1000);

const signal = (name: string, unit: string, value: number, state = "ok") => ({
  signal: name,
  unit,
  value,
  at: null,
  threshold: unit === "percent" ? 50 : 0,
  durationSeconds: 0,
  enabled: true,
  firing: state === "firing",
  stale: false,
  detail: null,
  state,
});

const BASE = {
  sampling: true,
  signals: [
    signal("statement_timeouts_per_min", "per_minute", 0),
    signal("statement_mean_budget_pct", "percent", 20),
  ],
  timeoutOccurrences: 0,
  size: { totalBytes: 2 * 1024 * 1024, growthBytes: 1024 },
  timeouts: [],
  tables: [
    {
      table: "conversations",
      totalBytes: 2 * 1024 * 1024,
      growthBytes: 1024,
      liveTuples: 10,
      deadTuples: 3,
      lastAutovacuum: null,
      lastAutoanalyze: null,
      seqScans: 4,
      indexScans: 1,
      deadRatio: 3 / 13,
      vacuumOverdue: false,
    },
  ],
  unusedIndexes: [
    { table: "conversations", index: "conv_unused_idx", bytes: 8192 },
  ],
  seqScanHeavy: [],
};

function stubApi(
  role: string,
  database: (window: string) => unknown,
  seen: string[] = [],
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    let body: unknown;
    if (key === "GET /api/auth/me") {
      body = { user: { id: "1", email: "a@b.c", role } };
    } else if (key === "GET /api/v1/instance-health/database") {
      const w = url.searchParams.get("window") ?? "1h";
      seen.push(w);
      body = { database: database(w) };
    }
    return new Response(JSON.stringify(body ?? { error: "not found" }), {
      status: body === undefined ? 404 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

// Prints where the router is, so a test reads the URL the screen wrote.
function Where() {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>;
}

function renderPage(refreshMs?: number, at = "/admin/database") {
  render(
    <MemoryRouter initialEntries={[at]}>
      <TooltipProvider>
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <Routes>
                <Route
                  path="/admin/database"
                  element={
                    <>
                      <DatabasePage refreshMs={refreshMs} />
                      <Where />
                    </>
                  }
                />
                <Route path="/admin/users" element={<p>users page</p>} />
              </Routes>
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const queries = () =>
  screen
    .queryAllByTestId("statement-row")
    .map((r) => r.querySelector("code")?.textContent ?? "");

test("sorting by total and by mean reorders the statements, each with its own series", async () => {
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    statements: {
      available: true,
      snapshots: 12,
      lastSnapshotAt: null,
      budgetMs: 1000,
      metricsBudgetMs: 15000,
      byTotal: [MANY_CHEAP, FEW_SLOW],
      byMean: [FEW_SLOW, MANY_CHEAP],
    },
  }));
  renderPage();
  await waitFor(() => expect(queries().length).toBe(2));
  expect(queries()[0]).toBe(MANY_CHEAP.query);
  expect(screen.queryAllByTestId("mean-spark").length).toBe(2);
  fireEvent.click(screen.getByRole("radio", { name: "Mean time" }));
  await waitFor(() => expect(queries()[0]).toBe(FEW_SLOW.query));
});

test("changing the window asks the server for that window", async () => {
  const seen: string[] = [];
  stubApi(
    "SUPER_ADMIN",
    (w) => ({
      ...BASE,
      window: w,
      statements: {
        available: true,
        snapshots: 1,
        lastSnapshotAt: null,
        budgetMs: 1000,
        metricsBudgetMs: 15000,
        byTotal: [],
        byMean: [],
      },
    }),
    seen,
  );
  renderPage();
  await waitFor(() => expect(seen).toContain("1h"));
  fireEvent.click(screen.getByRole("radio", { name: "7d" }));
  await waitFor(() => expect(seen).toContain("7d"));
});

test("without the extension the screen shows how to enable it and still lists the tables", async () => {
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    statements: {
      available: false,
      reason: "not_loaded",
      enable: [
        "shared_preload_libraries = 'pg_stat_statements'",
        "pg_stat_statements.track = top",
        "pg_stat_statements.track_utility = off",
      ],
    },
  }));
  renderPage();
  await waitFor(() =>
    expect(screen.queryByTestId("enable-statements") !== null).toBe(true),
  );
  const text = screen.getByTestId("enable-statements").textContent ?? "";
  expect(text).toContain("shared_preload_libraries = 'pg_stat_statements'");
  expect(text).toContain("pg_stat_statements.track_utility = off");
  fireEvent.click(screen.getByRole("tab", { name: "Tables and indexes" }));
  await waitFor(() =>
    expect(screen.queryAllByTestId("table-row").length).toBe(1),
  );
  expect(screen.getByTestId("unused-indexes").textContent ?? "").toContain(
    "conv_unused_idx",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Timeouts" }));
  await waitFor(() =>
    expect(screen.queryByTestId("no-timeouts") !== null).toBe(true),
  );
  // Preloaded but not created would add the statement; not preloaded is the settings alone.
  expect(screen.queryByTestId("create-extension") !== null).toBe(false);
});

test("an extension that does not exist in this database adds the statement that creates it", async () => {
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    statements: {
      available: false,
      reason: "not_created",
      enable: ["shared_preload_libraries = 'pg_stat_statements'"],
      create: "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;",
    },
  }));
  renderPage();
  await waitFor(() =>
    expect(screen.queryByTestId("create-extension") !== null).toBe(true),
  );
  expect(screen.getByTestId("create-extension").textContent).toBe(
    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;",
  );
});

test("an installed extension that could not be read says so, without the setup instructions", async () => {
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    statements: { available: false, reason: "unreadable", enable: [] },
  }));
  renderPage();
  await waitFor(() =>
    expect(screen.queryByTestId("statements-unreadable") !== null).toBe(true),
  );
  expect(screen.queryByTestId("enable-statements") !== null).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Tables and indexes" }));
  await waitFor(() =>
    expect(screen.queryAllByTestId("table-row").length).toBe(1),
  );
});

test("a refresh that overtakes a slow first read still ends the loading state", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const refreshSent = new Promise<void>((r) => {
    release = r;
  });
  const realStub = (role: string) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/auth/me") {
        return new Response(
          JSON.stringify({ user: { id: "1", email: "a@b.c", role } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      calls++;
      // The first read answers only after the refresh has been sent: slower than the interval.
      if (calls === 1) await refreshSent;
      else release();
      const body = {
        database: {
          ...BASE,
          window: "1h",
          statements: {
            available: true,
            snapshots: 1,
            lastSnapshotAt: null,
            budgetMs: 1000,
            byTotal: [MANY_CHEAP],
            byMean: [MANY_CHEAP],
          },
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  };
  realStub("SUPER_ADMIN");
  renderPage(30);
  await waitFor(() => expect(queries().length).toBe(1), { timeout: 2000 });
});

test("a refresh that fails after figures were shown keeps them and says they may be out of date", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/me") {
      return new Response(
        JSON.stringify({
          user: { id: "1", email: "a@b.c", role: "SUPER_ADMIN" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    calls++;
    if (calls > 1) {
      return new Response(JSON.stringify({ error: "down" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        database: {
          ...BASE,
          window: "1h",
          statements: {
            available: true,
            snapshots: 1,
            lastSnapshotAt: null,
            budgetMs: 1000,
            byTotal: [MANY_CHEAP],
            byMean: [MANY_CHEAP],
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  renderPage(40);
  await waitFor(
    () => expect(screen.queryByTestId("refresh-stale") !== null).toBe(true),
    { timeout: 2000 },
  );
  expect(queries().length).toBe(1);
});

test("a tenant admin is sent away and the screen's API is never asked", async () => {
  const seen: string[] = [];
  stubApi("TENANT_ADMIN", () => ({}), seen);
  renderPage();
  await waitFor(() =>
    expect(screen.queryByText("users page") !== null).toBe(true),
  );
  expect(seen).toEqual([]);
});

const available = (rows = [MANY_CHEAP, FEW_SLOW]) => ({
  available: true,
  snapshots: 3,
  lastSnapshotAt: null,
  budgetMs: 1000,
  metricsBudgetMs: 15000,
  byTotal: rows,
  byMean: [...rows].reverse(),
});

test("the section and the window come from the URL, and changing either writes it back", async () => {
  const seen: string[] = [];
  stubApi(
    "SUPER_ADMIN",
    (w) => ({ ...BASE, window: w, statements: available() }),
    seen,
  );
  renderPage(undefined, "/admin/database?section=tables&window=24h");
  await waitFor(() =>
    expect(screen.queryAllByTestId("table-row").length).toBe(1),
  );
  expect(seen).toEqual(["24h"]);
  expect(screen.queryByTestId("statements-table") !== null).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Timeouts" }));
  await waitFor(() =>
    expect(screen.getByTestId("where").textContent).toBe(
      "/admin/database?section=timeouts&window=24h",
    ),
  );
  expect(screen.queryByTestId("no-timeouts") !== null).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "7d" }));
  await waitFor(() => expect(seen).toContain("7d"));
  expect(screen.getByTestId("where").textContent).toBe(
    "/admin/database?section=timeouts&window=7d",
  );
});

test("a section or a window the URL names wrongly falls back to the defaults, and no bad window is asked", async () => {
  const seen: string[] = [];
  stubApi(
    "SUPER_ADMIN",
    (w) => ({ ...BASE, window: w, statements: available() }),
    seen,
  );
  renderPage(undefined, "/admin/database?section=nope&window=90d");
  await waitFor(() => expect(queries().length).toBe(2));
  expect(seen).toEqual(["1h"]);
  expect(
    screen.getByRole("tab", { name: "Queries" }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("the text filter narrows the statements, says when nothing matches, and clears back to the full list", async () => {
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    statements: available(),
  }));
  renderPage();
  await waitFor(() => expect(queries().length).toBe(2));
  const box = screen.getByTestId("statements-filter");
  fireEvent.change(box, { target: { value: "SLOW from" } });
  await waitFor(() => expect(queries()).toEqual([FEW_SLOW.query]));
  fireEvent.change(box, { target: { value: "zzz_none" } });
  await waitFor(() => expect(queries().length).toBe(0));
  fireEvent.click(screen.getByRole("button", { name: "Clear the filter" }));
  await waitFor(() =>
    expect(queries()).toEqual([MANY_CHEAP.query, FEW_SLOW.query]),
  );
});

test("the summary shows each signal in the state the server gave it, not one worked out from value and threshold", async () => {
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    signals: [
      // Below its threshold, yet the server says firing: the screen follows the server.
      signal("statement_timeouts_per_min", "per_minute", 0, "firing"),
      signal("statement_mean_budget_pct", "percent", 90, "ok"),
    ],
    statements: available(),
  }));
  renderPage();
  await waitFor(() =>
    expect(
      screen.queryByTestId("summary-signal-statement_timeouts_per_min") !==
        null,
    ).toBe(true),
  );
  const tone = (id: string) =>
    screen.getByTestId(`summary-signal-${id}`).getAttribute("data-tone");
  expect(tone("statement_timeouts_per_min")).toBe("error");
  expect(tone("statement_mean_budget_pct")).toBe("success");
  expect(screen.getByTestId("summary-size").textContent ?? "").toContain(
    "2.0 MB",
  );
});

test("each statement's share of the budget is the server's figure, and past 100 it is shown whole and in the error tone", async () => {
  const over = { ...FEW_SLOW, meanBudgetPct: 340 };
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    statements: available([over, MANY_CHEAP]),
  }));
  renderPage();
  await waitFor(() => expect(queries().length).toBe(2));
  const pct = screen.queryAllByTestId("budget-pct").map((e) => e.textContent);
  expect(pct[0]).toBe("340% of 1.0 s");
  const meters = [...document.querySelectorAll("[data-tone][data-pct]")].map(
    (m) => `${m.getAttribute("data-tone")}:${m.getAttribute("data-pct")}`,
  );
  expect(meters[0]).toBe("error:340");
});

test("a console read's bar is drawn against the metrics budget it ran under, and the note names both budgets", async () => {
  const dashboard = row(
    "SELECT day FROM llm_usage WHERE t = $1",
    2,
    8600,
    15000,
  );
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    statements: available([dashboard, FEW_SLOW]),
  }));
  renderPage();
  await waitFor(() => expect(queries().length).toBe(2));
  const pct = screen.queryAllByTestId("budget-pct").map((e) => e.textContent);
  expect(pct).toContain("29% of 15.0 s");
  const meters = [...document.querySelectorAll("[data-tone][data-pct]")].map(
    (m) => m.getAttribute("data-pct"),
  );
  expect(meters.map(Number).some((p) => Math.round(p) === 29)).toBe(true);
  expect(
    Boolean(
      screen.queryByText(/15\.0 s for console reads, 1\.0 s for the rest/),
    ),
  ).toBe(true);
});

test("a timeout's plan opens on demand, with the sequential scans and the tenant predicate marked", async () => {
  const plan = [
    "Limit  (cost=0.00..1.00 rows=1 width=8)",
    "  ->  Seq Scan on agents  (cost=0.00..1.00 rows=1 width=8)",
    "        Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::bigint)",
  ].join("\n");
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    timeoutOccurrences: 3,
    timeouts: [
      {
        fingerprint: "f1",
        statement: "SELECT id FROM agents WHERE tenant_id = $1",
        occurrences: 3,
        lastAt: new Date().toISOString(),
        label: "GET /api/v1/agents/",
        tenantId: "1",
        fleet: false,
        budgetMs: 1000,
        plan,
        planError: null,
        plannedAs: "application role, tenant 1",
        plannedAt: new Date().toISOString(),
      },
    ],
    statements: available(),
  }));
  renderPage(undefined, "/admin/database?section=timeouts");
  await waitFor(() =>
    expect(screen.queryAllByTestId("timeout-item").length).toBe(1),
  );
  expect(screen.queryByTestId("timeout-plan") !== null).toBe(false);
  fireEvent.click(screen.getByTestId("timeout-plan-toggle"));
  await waitFor(() =>
    expect(screen.queryByTestId("timeout-plan") !== null).toBe(true),
  );
  const marks = [
    ...screen.getByTestId("timeout-plan").querySelectorAll("[data-plan-line]"),
  ].map((l) => l.getAttribute("data-plan-line"));
  expect(marks).toEqual(["seq", "rls"]);
});

test("a table past autovacuum's trigger shows its dead-row share in the warning tone, from the server's verdict", async () => {
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    tables: [
      {
        ...BASE.tables[0],
        // A large table: a modest share is already past autovacuum's trigger
        // (threshold + scale factor x live rows), so only the server can say so.
        table: "bloated",
        deadRatio: 0.3,
        vacuumOverdue: true,
      },
      {
        ...BASE.tables[0],
        // A tiny one: most rows dead, still under the trigger's fixed threshold.
        table: "fine",
        deadRatio: 0.9,
        vacuumOverdue: false,
      },
    ],
    statements: available(),
  }));
  renderPage(undefined, "/admin/database?section=tables");
  await waitFor(() =>
    expect(screen.queryAllByTestId("table-row").length).toBe(2),
  );
  const rows = screen
    .queryAllByTestId("table-row")
    .map(
      (r) =>
        `${r.querySelector("code")?.textContent}:${r.getAttribute("data-vacuum-overdue")}:${r.querySelector("[data-testid=dead-ratio]")?.textContent}`,
    );
  expect(rows).toEqual(["bloated:true:30%", "fine:false:90%"]);
  expect(
    screen.getByTestId("vacuum-overdue-count").textContent ?? "",
  ).toContain("1");
});

test("in Portuguese, the signal lines, the budget and a failed plan are written by the screen, not sent ready in English", async () => {
  const startingLanguage = i18n.language;
  await i18n.changeLanguage("pt-BR");
  try {
    const raw =
      "\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nRaw query failed. Code: `42501`. Message: `permission denied for table business_hours`";
    const timeout = (fingerprint: string, extra: Record<string, unknown>) => ({
      fingerprint,
      statement: "SELECT * FROM business_hours WHERE tenant_id = $1",
      occurrences: 2,
      lastAt: new Date().toISOString(),
      label: "job:FOLLOWUP_SWEEP",
      tenantId: "1",
      fleet: false,
      budgetMs: 1500,
      plan: null,
      planError: null,
      planFailure: null,
      plannedAs: null,
      plannedScope: null,
      plannedAt: null,
      ...extra,
    });
    stubApi("SUPER_ADMIN", (w) => ({
      ...BASE,
      window: w,
      signals: [
        {
          ...signal("statement_timeouts_per_min", "per_minute", 3, "firing"),
          detail:
            "Last timeout: job FOLLOWUP_SWEEP, tenant 1, 1.5 s budget, on business_hours. Statement: SELECT * FROM business_hours WHERE tenant_id = $1",
          facts: {
            kind: "timeout",
            work: { kind: "job", name: "FOLLOWUP_SWEEP" },
            tenantId: "1",
            fleet: false,
            budgetMs: 1500,
            table: "business_hours",
            statement: "SELECT * FROM business_hours WHERE tenant_id = $1",
          },
        },
        {
          ...signal("statement_mean_budget_pct", "percent", 61.4, "firing"),
          detail:
            "Closest to its budget over the last hour: 1.3 s mean, 2.0 s budget, on business_hours. Statement: SELECT * FROM business_hours WHERE tenant_id = $1",
          facts: {
            kind: "drift",
            meanMs: 1300,
            budgetMs: 2000,
            table: "business_hours",
            statement: "SELECT * FROM business_hours WHERE tenant_id = $1",
          },
        },
      ],
      timeoutOccurrences: 4,
      timeouts: [
        timeout("denied", {
          planError: raw,
          planFailure: {
            kind: "permission",
            code: "42501",
            objectType: "table",
            object: "business_hours",
          },
        }),
        timeout("planned", {
          plan: "Seq Scan on business_hours  (cost=0.00..1.00 rows=1 width=8)",
          plannedAs: "application role, tenant 1",
          plannedScope: { fleet: false, tenantId: "1" },
          plannedAt: new Date().toISOString(),
        }),
      ],
      statements: available(),
    }));
    renderPage(undefined, "/admin/database?section=timeouts");
    await waitFor(() =>
      expect(screen.queryAllByTestId("timeout-item").length).toBe(2),
    );
    const text = (id: string) => screen.getByTestId(id).textContent ?? "";
    const drift = text("summary-signal-statement_mean_budget_pct");
    expect(drift).toContain(
      "Mais perto do orçamento na última hora: média de 1,3 s, orçamento 2,0 s, em business_hours",
    );
    expect(drift).not.toContain("Slowest");
    const last = text("summary-signal-statement_timeouts_per_min");
    expect(last).toContain(
      "Último timeout: tarefa FOLLOWUP_SWEEP, no tenant 1, orçamento 1,5 s, em business_hours",
    );
    expect(last).not.toContain("Last timeout");
    // The budget badge goes through the locale's formatter, like every figure on the page.
    const items = screen
      .queryAllByTestId("timeout-item")
      .map((i) => i.textContent ?? "");
    expect(items.every((i) => i.includes("orçamento 1,5 s"))).toBe(true);
    // A refused plan says which grant is missing; the raw error is only behind an expander.
    const failure = text("timeout-plan-error");
    expect(failure).toContain("SELECT");
    expect(failure).toContain("business_hours");
    expect(failure).not.toContain("prisma");
    const rawBox = screen.getByTestId("timeout-plan-error-raw");
    expect(rawBox.tagName).toBe("DETAILS");
    expect(rawBox.hasAttribute("open")).toBe(false);
    expect((rawBox.textContent ?? "").includes("permission denied")).toBe(true);
    // The scope a plan was taken under is written in Portuguese too.
    const toggle = text("timeout-plan-toggle");
    expect(toggle).not.toContain("application role");
    expect(toggle).toContain("tenant 1");
  } finally {
    await i18n.changeLanguage(startingLanguage);
  }
});

test("on a narrow table box the secondary columns give way, and a table's name breaks only after its separators", async () => {
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    tables: [{ ...BASE.tables[0], table: "langgraph.checkpoint_blobs" }],
    statements: available(),
  }));
  renderPage(undefined, "/admin/database?section=statements");
  await waitFor(() =>
    expect(screen.queryAllByTestId("statement-row").length).toBe(2),
  );
  // Each table sizes against its own box, not a fixed minimum width, and the columns that are not
  // needed to answer "what is slow" hide on a narrow box (Tailwind container queries).
  const hiddenOn = (testId: string) => {
    const table = screen.getByTestId(testId);
    const box = table.parentElement;
    const heads = [...table.querySelectorAll("thead th")].map(
      (th) => th.className,
    );
    return {
      container: box?.className.includes("@container") ?? false,
      minWidth: /min-w-\[/.test(table.className),
      hidden: heads.filter((c) => /(^| )hidden( |$)/.test(c)).length,
      bounded: heads
        .filter((c) => /(^| )hidden( |$)/.test(c))
        .every((c) => /@(lg|xl|3xl):table-cell/.test(c)),
    };
  };
  expect(hiddenOn("statements-table")).toEqual({
    container: true,
    minWidth: false,
    hidden: 3,
    bounded: true,
  });
  fireEvent.click(screen.getByRole("tab", { name: "Tables and indexes" }));
  await waitFor(() =>
    expect(screen.queryAllByTestId("table-row").length).toBe(1),
  );
  const tables = hiddenOn("tables-table");
  expect(tables.container).toBe(true);
  expect(tables.minWidth).toBe(false);
  expect(tables.hidden).toBeGreaterThanOrEqual(3);
  expect(tables.bounded).toBe(true);
  // The name offers a break after each `_` and `.` and nowhere else.
  const name = screen.getByTestId("table-row").querySelector("code");
  const pieces = [...(name?.childNodes ?? [])].map((n) => n.textContent);
  expect(pieces).toEqual(["langgraph.", "checkpoint_", "blobs"]);
  expect(name?.querySelectorAll("wbr").length).toBe(2);
  expect(name?.textContent).toBe("langgraph.checkpoint_blobs");
});

test("the drift card says which queries it did not count for too few calls, and lists them with their calls", async () => {
  const lookup =
    "SELECT id, dedupe_key FROM scheduler_jobs WHERE dedupe_key LIKE $1";
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    statements: available(),
    driftFloor: {
      minCalls: 3,
      leftOutCount: 1,
      leftOut: [
        {
          queryid: "31",
          query: lookup,
          calls: 1,
          meanMs: 2900,
          budgetMs: 5000,
          meanBudgetPct: 58,
        },
      ],
    },
  }));
  renderPage();
  await waitFor(() =>
    expect(screen.queryByTestId("drift-left-out") !== null).toBe(true),
  );
  const card = screen.getByTestId("summary-signal-statement_mean_budget_pct");
  const box = screen.getByTestId("drift-left-out");
  expect(card.contains(box)).toBe(true);
  expect(box.querySelector("summary")?.textContent ?? "").toBe(
    "1 query not counted: fewer than 3 calls in the last hour",
  );
  const rows = screen.getAllByTestId("drift-left-out-row");
  expect(rows.map((r) => r.querySelector("code")?.textContent ?? "")).toEqual([
    lookup,
  ]);
  expect(rows[0]?.textContent ?? "").toContain("1 call, 2.9 s mean, 58%");
});

test("with nothing left out the drift card says nothing about a floor", async () => {
  stubApi("SUPER_ADMIN", (w) => ({
    ...BASE,
    window: w,
    statements: available(),
    driftFloor: { minCalls: 3, leftOutCount: 0, leftOut: [] },
  }));
  renderPage();
  await waitFor(() =>
    expect(
      screen.queryByTestId("summary-signal-statement_mean_budget_pct") !== null,
    ).toBe(true),
  );
  expect(screen.queryByTestId("drift-left-out") === null).toBe(true);
});
