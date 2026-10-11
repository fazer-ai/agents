/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The automatic limit's explanation says when its figure was read: the figure is refreshed at most
// once a day, so without the date a burst today reads as a card that is wrong.
//
// NOTE: assertions reduce to a boolean or a string BEFORE expect; a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

const { ProactiveBreakerProvider } = await import(
  "@/client/contexts/ProactiveBreakerContext"
);
const { ProactiveBreakerCard } = await import(
  "@/client/pages/resources/ProactiveBreakerCard"
);
const { ToastProvider } = await import("@/client/components/Toast");

const COMPUTED_AT = "2026-10-10T12:00:00.000Z";
let auto: Record<string, unknown> = {};

const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(
    JSON.stringify({
      proactiveBreaker: {
        mode: "auto",
        fixedLimit: null,
        limit: auto.limit,
        auto: { multiplier: 3, floor: 1000, ...auto },
        count: 0,
        windowStart: "2026-10-09T12:00:00.000Z",
        tripped: null,
        resumedAt: null,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )) as unknown as typeof fetch;

afterEach(() => cleanup());
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function cardText(): Promise<string> {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ProactiveBreakerProvider>
          <ProactiveBreakerCard />
        </ProactiveBreakerProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect((document.body.textContent ?? "").includes("Automatic:")).toBe(true),
  );
  return document.body.textContent ?? "";
}

const measured = new Date(COMPUTED_AT).toLocaleString("en", {
  dateStyle: "short",
  timeStyle: "short",
});

test("a limit from the peak says when the peak was measured", async () => {
  auto = {
    limit: 1500,
    peak: 500,
    peakAt: "2026-10-02T12:00:00.000Z",
    basis: "peak",
    computedAt: COMPUTED_AT,
  };
  const text = await cardText();
  expect(text.includes(`Measured ${measured}.`)).toBe(true);
});

test("a limit at the floor says when the volume was measured", async () => {
  auto = {
    limit: 1000,
    peak: 0,
    peakAt: null,
    basis: "floor",
    computedAt: COMPUTED_AT,
  };
  const text = await cardText();
  expect(text.includes("was 0")).toBe(true);
  expect(text.includes(`Measured ${measured}.`)).toBe(true);
});

test("a figure never measured says so instead of quoting a volume of 0", async () => {
  auto = {
    limit: 1000,
    peak: null,
    peakAt: null,
    basis: "floor",
    computedAt: null,
  };
  const text = await cardText();
  expect(text.includes("was 0")).toBe(false);
  expect(text.includes("Not measured yet")).toBe(true);
  expect(Boolean(screen.queryByText(/Measured /))).toBe(false);
});
