/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DashboardPage } from "@/client/pages/DashboardPage";

// Issue #283: on an inbox served by humans every KPI on this page is derived from LlmUsage, so the
// panel reads zero, which reads as failure rather than as "the agent was not here". The number
// that answers there is Chatwoot's own first-response SLA, and it is only worth mirroring if the
// operator can SEE it. So this asserts the rendered figure, not the heading above it: a card whose
// label is right and whose value is a stale zero would pass a label-only test and fail the issue.
//
// NOTE: every assertion reduces to a string or a number BEFORE expect. A failing expectation still
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

// `mock.module` is process-global in Bun and leaks across files in the same worker, and one of them
// (tests/client/components/TenantDeepLink.test.tsx) installs a `t` that returns the default string
// WITHOUT interpolating, so `{{sampled}}` reaches the DOM literally and an assertion about the
// sample size fails on a translation detail rather than on the figure. Declared here rather than
// inherited, and interpolating, so this file states the surface it needs instead of depending on
// which file ran first. Measured: passes alone, failed inside `bun check`, until this existed.
mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) => {
      const text = typeof fallback === "string" ? fallback : key;
      if (!vars) return text;
      return text.replace(/\{\{(\w+)\}\}/g, (m, name) =>
        name in vars ? String(vars[name]) : m,
      );
    },
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const realFetch = globalThis.fetch;

let kpis: Record<string, unknown> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Only the page-level load matters here. The usage section fetches on its own and is answered with
// a 500 on purpose: it renders its own error boundary and cannot reach the section under test.
const stubFetch = (async (input: unknown) => {
  const url = String(
    typeof input === "string" ? input : ((input as Request).url ?? input),
  );
  if (url.includes("/metrics/kpis")) return json({ instance: "i", kpis });
  if (url.includes("/agents")) return json({ agents: [] });
  if (url.includes("/metrics/costs"))
    return json({ costs: { status: "error" } });
  return json({ error: "nope" }, 500);
}) as unknown as typeof globalThis.fetch;

const BASE = {
  totalConversations: 40,
  involved: 0,
  resolvedByBot: 0,
  handoff: 0,
  resolvedBeforeTracking: 0,
  involvementRate: 0,
  resolutionRate: 0,
  automationRate: 0,
};

async function renderWith(k: Record<string, unknown>): Promise<void> {
  kpis = { ...BASE, ...k };
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(screen.queryAllByText("First response").length).toBeGreaterThan(0);
  });
}

// Asserted as number + unit rather than as the exact string ICU produced: `Intl` decides the
// spacing and the abbreviation ("95 sec" today), and pinning that makes the test about the runtime's
// locale data instead of about the figure the page rendered.
function cardValue(): string {
  // The card's own figure: the <p> that follows the label inside the same Card.
  const label = screen.getByText("First response");
  const card = label.closest("div")?.parentElement;
  return card?.querySelectorAll("p")[0]?.textContent ?? "";
}

describe("dashboard: the team's first response", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(cleanup);

  test("renders the median the API sent, in a unit a person reads", async () => {
    await renderWith({ firstResponseSeconds: 95, firstResponseSampled: 12 });
    expect(cardValue()).toMatch(/^95\D+sec/);
    expect(
      screen.queryAllByText("median over 12 answered conversations").length,
    ).toBe(1);
  });

  test("a median in the minutes is not printed in seconds", async () => {
    await renderWith({ firstResponseSeconds: 1080, firstResponseSampled: 4 });
    expect(cardValue()).toMatch(/^18\D+min/);
  });

  // The reason the whole issue exists, asserted where the operator meets it: no sample is NOT the
  // same claim as a zero-second response, and the card has to be able to say so.
  //
  // The caption is asserted for what it does NOT claim, which is the second half of the same point.
  // An empty sample proves only that no mirrored pair is available: right after this ships, and
  // indefinitely for a conversation closed before it that receives no further event, both columns
  // stay NULL although a person did answer. A caption reading "nobody has answered yet" would be a
  // false statement about the world, made by the very card built to stop reading absence as zero.
  test("no sample reads as no data, never as an instant answer", async () => {
    await renderWith({ firstResponseSeconds: null, firstResponseSampled: 0 });
    expect(cardValue()).toBe("—");
    expect(cardValue()).not.toContain("0");
    const caption =
      screen.getByText(/no data for this period/i).textContent ?? "";
    expect(caption.length > 0).toBe(true);
    expect(/answered|respond/i.test(caption)).toBe(false);
  });

  // The funnel above is all zeros in every case here (involved = 0, the inbox the agent never
  // touched). That is the state the issue describes, and it must not silence this section.
  test("answers even while every automation KPI is zero", async () => {
    await renderWith({ firstResponseSeconds: 240, firstResponseSampled: 40 });
    expect(cardValue()).toMatch(/^4\D+min/);
    expect(screen.queryAllByText("Team response").length).toBe(1);
  });
});
