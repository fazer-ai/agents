import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import logger from "@/api/lib/logger";
import { noteMetricsRead } from "@/api/lib/metrics-reads";
import { MetricsTooSlowError } from "@/lib/errors";
import { until } from "@/tests/utils/poll";
import {
  type MockUserEntity,
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// ONE LINE PER METRICS REQUEST, so a refused opening can be read back: which route, how long a window,
// which filters, how long it waited for a connection and how long its reads ran. The reads are stubbed
// to report fixed timings, the way `runMetricsScoped` reports its own (tests/modules/analytics-budget-
// timing.test.ts measures those against a real pool).
setupPrismaMock();

const costsModule = await import("@/modules/analytics/costs");
const slowCosts = { refuse: false };
const getDashboardCosts = spyOn(
  costsModule,
  "getDashboardCosts",
).mockImplementation((async () => {
  noteMetricsRead(120, 340);
  if (slowCosts.refuse) throw new MetricsTooSlowError(15_000);
  return {
    totalCostUsd: 0,
    requests: 0,
    tokens: { prompt: 0, completion: 0 },
    conversations: 0,
    resolvedConversations: 0,
    costPerConversation: null,
    costPerResolvedConversation: null,
    days: [],
    daysByModel: [],
    daysByNode: [],
    byModel: [],
    unpriced: { calls: 0, models: [] },
    langfuse: null,
  };
}) as unknown as typeof costsModule.getDashboardCosts);
const breakdownModule = await import("@/modules/analytics/breakdown");
const getBreakdown = spyOn(breakdownModule, "getBreakdown").mockImplementation(
  (async () => {
    noteMetricsRead(5, 7);
    return [];
  }) as unknown as typeof breakdownModule.getBreakdown,
);
const app = (await import("@/app")).default;
const info = spyOn(logger, "info");
afterAll(() => {
  getDashboardCosts.mockRestore();
  getBreakdown.mockRestore();
  info.mockRestore();
});
beforeEach(() => {
  info.mockClear();
  slowCosts.refuse = false;
});

const admin: MockUserEntity = { ...mockUser, role: "TENANT_ADMIN" };

async function adminCookie(): Promise<string> {
  mockFindUnique.mockImplementation(() => Promise.resolve(admin));
  const { token } = (await (
    await new Elysia()
      .use(authPlugin)
      .post("/mint", async ({ setAuthCookie }) => ({
        token: await setAuthCookie(admin, admin.passwordHash),
      }))
      .handle(new Request("http://localhost/mint", { method: "POST" }))
  ).json()) as { token: string };
  return `fazerai_auth_token=${token}`;
}

// The line is written once the response is out (`onAfterResponse`), so a request is answered and
// then given the turn that writes it.
async function get(path: string, cookie?: string): Promise<Response> {
  const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
    .BunRequest;
  const res = await app.handle(
    new BunReq(`http://localhost${path}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
  await res.arrayBuffer();
  await until("the access log line", () =>
    info.mock.calls.some((c) => c[0] === "%s %s [%s]"),
  );
  return new Response(null, { status: res.status });
}

type Line = Record<string, unknown>;

function metricsLines(): Line[] {
  return info.mock.calls
    .filter((c) => c[1] === "metrics request")
    .map((c) => c[0] as Line);
}

// The stubbed read's times, plus the session lookup's on the mocked pool, which is a millisecond at most.
function expectTimes(line: Line, waitMs: number, runMs: number): void {
  expect(line.waitMs as number).toBeGreaterThanOrEqual(waitMs);
  expect(line.waitMs as number).toBeLessThan(waitMs + 50);
  expect(line.runMs as number).toBeGreaterThanOrEqual(runMs);
  expect(line.runMs as number).toBeLessThan(runMs + 50);
}

describe("the metrics request line", () => {
  test("names the route, the window in days, the filters set and the read timings", async () => {
    const res = await get(
      "/api/v1/metrics/costs?since=2026-10-01T03:00:00.000Z&until=2026-10-31T03:00:00.000Z&agentId=7&source=inbox&tz=America%2FSao_Paulo",
      await adminCookie(),
    );
    expect(res.status).toBe(200);
    const lines = metricsLines();
    expect(lines.length).toBe(1);
    const line = lines[0] as Line;
    expect(line).toMatchObject({
      route: "/api/v1/metrics/costs",
      status: 200,
      windowDays: 30,
      agent: true,
      inbox: false,
      source: true,
      audience: false,
      reads: 1,
    });
    expectTimes(line, 120, 340);
    expect(typeof line.totalMs).toBe("number");
    // No instant, no id and no zone in the line: the window is a length.
    const text = JSON.stringify(line);
    for (const leaked of ["2026-10", "Sao_Paulo", '"7"', ":7,"])
      expect(text).not.toContain(leaked);
  });

  test("a request the budget refused still says the window it asked for and how long it waited", async () => {
    slowCosts.refuse = true;
    const res = await get(
      "/api/v1/metrics/costs?since=2026-08-03T03:00:00.000Z&until=2026-11-01T03:00:00.000Z",
      await adminCookie(),
    );
    expect(res.status).toBe(503);
    const [line] = metricsLines();
    expect(line).toMatchObject({
      route: "/api/v1/metrics/costs",
      status: 503,
      windowDays: 90,
    });
    expectTimes(line as Line, 120, 340);
  });

  test("an all-time view, with no start, has no window length", async () => {
    const res = await get(
      "/api/v1/metrics/breakdown?dimension=model",
      await adminCookie(),
    );
    expect(res.status).toBe(200);
    const [line] = metricsLines();
    expect(line).toMatchObject({
      route: "/api/v1/metrics/breakdown",
      status: 200,
      windowDays: null,
      dimension: "model",
      reads: 1,
    });
  });

  test("a shape value outside its vocabulary is not copied into the line", async () => {
    await get(
      "/api/v1/metrics/costs?since=2026-10-01T03:00:00.000Z&dimension=2026-10-01T03%3A00%3A00Z&breakdown=some-id-7",
      await adminCookie(),
    );
    const [line] = metricsLines();
    expect(line?.reads).toBe(1);
    expect(line).not.toHaveProperty("dimension");
    expect(line).not.toHaveProperty("breakdown");
    expect(JSON.stringify(line)).not.toContain("some-id-7");
  });

  test("a window still running is measured up to the arrival of the request", async () => {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await get(
      `/api/v1/metrics/breakdown?dimension=agent&since=${since}`,
      await adminCookie(),
    );
    const [line] = metricsLines();
    expect(line?.windowDays).toBeCloseTo(7, 1);
  });

  test("an unauthenticated request reads nothing and logs no window", async () => {
    const res = await get(
      "/api/v1/metrics/costs?since=2026-10-01T03:00:00.000Z",
    );
    expect(res.status).toBe(401);
    for (const line of metricsLines()) {
      expect(line.reads).toBe(0);
      expect(line.windowDays).toBeUndefined();
    }
  });

  test("a route outside the metrics writes no metrics line", async () => {
    await get("/api/health");
    expect(metricsLines()).toEqual([]);
  });
});
