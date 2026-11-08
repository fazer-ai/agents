import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import config from "@/config";
import type { DashboardKpis } from "@/modules/analytics/service";
import {
  type MockUserEntity,
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// Elysia's `normalize` strips response fields that a declared 200 schema does not mention, which is
// how a field that exists only in the TypeScript type reaches the client as nothing at all. The
// dashboard's Resolution note is driven by `resolvedBeforeTracking`, a field added on the service
// side alone, so this drives the REAL route with the service stubbed rather than trusting the type.
setupPrismaMock();

const kpis: DashboardKpis = {
  totalConversations: 10,
  involved: 8,
  resolvedByBot: 1,
  handoff: 1,
  resolvedBeforeTracking: 3,
  involvementRate: 0.8,
  resolutionRate: 0.125,
  automationRate: 0.1,
  handoffRate: 0.1,
  firstResponseSeconds: 42.5,
  firstResponseP90Seconds: 120,
  firstResponseSampled: 6,
};

const options = await import("@/modules/analytics/options");
const getFilterOptions = spyOn(options, "getFilterOptions").mockImplementation(
  (async () => ({
    agents: [],
    inboxes: [],
  })) as unknown as typeof options.getFilterOptions,
);
const analytics = await import("@/modules/analytics/service");
const getKpis = spyOn(analytics, "getKpis").mockImplementation(
  (async () => kpis) as unknown as typeof analytics.getKpis,
);
const app = (await import("@/app")).default;
afterAll(() => {
  getKpis.mockRestore();
  getFilterOptions.mockRestore();
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

describe("GET /v1/metrics/filter-options response contract", () => {
  // The console marks a flow-log day past retention as no data from this number: dropped by the
  // response schema, every such day would read as zero.
  test("carries the flow log's retention in days", async () => {
    const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
      .BunRequest;
    const res = await app.handle(
      new BunReq("http://localhost/api/v1/metrics/filter-options", {
        headers: { cookie: await adminCookie() },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flowLogRetentionDays: unknown };
    expect(body.flowLogRetentionDays).toBe(config.flowlog.retentionDays);
  });
});

describe("GET /v1/metrics/kpis response contract", () => {
  test("every KPI the service computes reaches the client", async () => {
    mockFindUnique.mockImplementation(() => Promise.resolve(admin));
    const { token } = (await (
      await new Elysia()
        .use(authPlugin)
        .post("/mint", async ({ setAuthCookie }) => ({
          token: await setAuthCookie(admin, admin.passwordHash),
        }))
        .handle(new Request("http://localhost/mint", { method: "POST" }))
    ).json()) as { token: string };
    const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
      .BunRequest;

    const res = await app.handle(
      new BunReq("http://localhost/api/v1/metrics/kpis", {
        headers: { cookie: `fazerai_auth_token=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kpis: unknown };
    expect(body.kpis).toEqual(kpis);
  });
});
