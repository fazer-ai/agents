/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DashboardPage } from "@/client/pages/DashboardPage";
import { withI18n } from "@/tests/utils/i18n";

// On an inbox served by humans every KPI on this page derives from LlmUsage and reads zero. The
// number that answers there is Chatwoot's own first-response SLA, so this asserts the rendered
// figure, not the heading: a right label over a stale zero would pass a label-only test.
//
// Every assertion reduces to a string or a number BEFORE expect: a failing expectation still
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

// This file asserts on rendered LABELS, so what `t` answers is part of the fixture. `withI18n`
// hands this tree its own i18next by context; replacing `react-i18next` in the module registry
// would reach every other file in the process too.
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
    withI18n(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    ),
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

  // NOTE: no sample is NOT the same claim as a zero-second response. The caption is asserted for
  // what it does NOT claim: an empty sample proves only that no mirrored pair is available (a
  // conversation closed before the mirror existed keeps both columns NULL although a person
  // answered), so "nobody has answered yet" would be false.
  test("no sample reads as no data, never as an instant answer", async () => {
    await renderWith({ firstResponseSeconds: null, firstResponseSampled: 0 });
    expect(cardValue()).toBe("—");
    expect(cardValue()).not.toContain("0");
    const caption =
      screen.getByText(/no data for this period/i).textContent ?? "";
    expect(caption.length > 0).toBe(true);
    expect(/answered|respond/i.test(caption)).toBe(false);
  });

  // NOTE: the funnel above is all zeros in every case here (involved = 0, the inbox the agent never
  // touched), and that must not silence this section.
  test("answers even while every automation KPI is zero", async () => {
    await renderWith({ firstResponseSeconds: 240, firstResponseSampled: 40 });
    expect(cardValue()).toMatch(/^4\D+min/);
    expect(screen.queryAllByText("Team response").length).toBe(1);
  });
});
