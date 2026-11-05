/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const { DatabasePage } = await import(
  "@/client/pages/admin/database/DatabasePage"
);
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const { ToastProvider } = await import("@/client/components/Toast");

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

const row = (query: string, calls: number, totalMs: number) => ({
  queryid: query,
  userid: "10",
  query,
  calls,
  rows: calls,
  totalMs,
  meanMs: totalMs / calls,
  spark: [1, null, 2, 3],
});

const MANY_CHEAP = row("SELECT cheap FROM a WHERE x = $1", 2000, 2000);
const FEW_SLOW = row("SELECT slow FROM b WHERE y = $1", 5, 1000);

const BASE = {
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

function renderPage(refreshMs?: number) {
  render(
    <MemoryRouter initialEntries={["/admin/database"]}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <Routes>
              <Route
                path="/admin/database"
                element={<DatabasePage refreshMs={refreshMs} />}
              />
              <Route path="/admin/users" element={<p>users page</p>} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
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
  expect(screen.queryAllByTestId("table-row").length).toBe(1);
  expect(screen.getByTestId("unused-indexes").textContent ?? "").toContain(
    "conv_unused_idx",
  );
  expect(screen.queryByTestId("no-timeouts") !== null).toBe(true);
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
  expect(screen.queryAllByTestId("table-row").length).toBe(1);
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
