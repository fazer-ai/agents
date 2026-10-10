/// <reference lib="dom" />

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

// While the account's proactive breaker is tripped the shell shows one banner, on every page, with the
// sentence the operator acts on and the two ways out; a resume from it clears it without a reload.
// The card shares the same state.
//
// NOTE: assertions reduce to a boolean or a string BEFORE expect; a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

let role = "TENANT_ADMIN";
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, role } }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ProactiveBreakerBanner } = await import(
  "@/client/components/ProactiveBreakerBanner"
);
const { ProactiveBreakerProvider } = await import(
  "@/client/contexts/ProactiveBreakerContext"
);
const { ProactiveBreakerCard } = await import(
  "@/client/pages/resources/ProactiveBreakerCard"
);
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
const status = (tripped: boolean) => ({
  mode: "fixed",
  fixedLimit: 2,
  limit: 2,
  auto: {
    limit: 1500,
    peak: 500,
    peakAt: "2026-10-02T12:00:00.000Z",
    basis: "peak",
    multiplier: 3,
    floor: 1000,
    computedAt: "2026-10-10T12:00:00.000Z",
  },
  count: tripped ? 2 : 0,
  windowStart: "2026-10-09T12:00:00.000Z",
  tripped: tripped
    ? { at: "2026-10-10T10:00:00.000Z", count: 2, limit: 2 }
    : null,
  resumedAt: null,
});

let tripped = true;
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push(`${method} ${url.pathname}`);
  if (url.pathname.endsWith("/proactive-breaker/resume")) tripped = false;
  return new Response(JSON.stringify({ proactiveBreaker: status(tripped) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

afterEach(() => {
  cleanup();
  tripped = true;
  role = "TENANT_ADMIN";
  calls.length = 0;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const shell = (children: ReactNode) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ProactiveBreakerProvider>{children}</ProactiveBreakerProvider>
      </ToastProvider>
    </MemoryRouter>,
  );

test("a tripped breaker shows the banner with the count, the limit and both actions, and Resume clears it", async () => {
  shell(<ProactiveBreakerBanner />);
  await waitFor(() => expect(Boolean(screen.queryByRole("alert"))).toBe(true));
  const text = screen.getByRole("alert").textContent ?? "";
  expect(text.includes("Proactive messages paused since")).toBe(true);
  expect(text.includes("2 sent in 24h, limit 2")).toBe(true);
  expect(Boolean(screen.queryByRole("button", { name: "Change limit" }))).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(Boolean(screen.queryByRole("alert"))).toBe(false));
  expect(
    calls.includes("POST /api/v1/tenant-settings/proactive-breaker/resume"),
  ).toBe(true);
});

test("an open breaker shows no banner", async () => {
  tripped = false;
  shell(<ProactiveBreakerBanner />);
  await waitFor(() => expect(calls.length > 0).toBe(true));
  expect(Boolean(screen.queryByRole("alert"))).toBe(false);
});

test("a member who is not an admin sees the banner without the actions", async () => {
  role = "AGENT";
  shell(<ProactiveBreakerBanner />);
  await waitFor(() => expect(Boolean(screen.queryByRole("alert"))).toBe(true));
  expect(Boolean(screen.queryByRole("button", { name: "Resume" }))).toBe(false);
  expect(
    (screen.getByRole("alert").textContent ?? "").includes(
      "An admin of this account can resume them.",
    ),
  ).toBe(true);
});

test("the card shows the trip with its Resume and where the automatic limit came from", async () => {
  shell(<ProactiveBreakerCard />);
  await waitFor(() =>
    expect(Boolean(screen.queryByText(/Paused since/))).toBe(true),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Automatic" }));
  const auto = screen.queryByText(/3x the peak of/)?.textContent ?? "";
  expect(auto.includes("1,500")).toBe(true);
  expect(auto.includes("500 proactive messages in 24 hours")).toBe(true);
});

test("an edit in progress survives the shell's periodic re-read", async () => {
  tripped = false;
  shell(<ProactiveBreakerCard />);
  await waitFor(() =>
    expect(Boolean(screen.queryByRole("spinbutton"))).toBe(true),
  );
  const input = screen.getByRole("spinbutton") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "500" } });
  const before = calls.length;
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(calls.length > before).toBe(true));
  await waitFor(() =>
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(
      "500",
    ),
  );
});
