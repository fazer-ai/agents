import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
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

const analytics = await import("@/modules/analytics/service");
const getKpis = spyOn(analytics, "getKpis").mockImplementation(
  (async () => kpis) as unknown as typeof analytics.getKpis,
);
// The kept days answer an aligned window with the same type; the live reader is the stubbed one.
const answer = await import("@/modules/analytics/rollup/answer");
const fromKeptDays = spyOn(answer, "fromKeptDays").mockImplementation(((
  ..._args: unknown[]
) =>
  (
    _args[4] as () => Promise<unknown>
  )()) as unknown as typeof answer.fromKeptDays);
const app = (await import("@/app")).default;
afterAll(() => {
  getKpis.mockRestore();
  fromKeptDays.mockRestore();
});

const admin: MockUserEntity = { ...mockUser, role: "TENANT_ADMIN" };

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

  // A route answers once, after every part is in: a client that goes away stops the computation,
  // which the kept days only see through the request's own signal.
  test("the route hands the kept days the request's signal, aborted when the client goes away", async () => {
    mockFindUnique.mockImplementation(() => Promise.resolve(admin));
    const { token } = (await (
      await new Elysia()
        .use(authPlugin)
        .post("/mint", async ({ setAuthCookie }) => ({
          token: await setAuthCookie(admin, admin.passwordHash),
        }))
        .handle(new Request("http://localhost/mint", { method: "POST" }))
    ).json()) as { token: string };
    const native = globalThis as unknown as {
      BunRequest: typeof Request;
      BunAbortController: typeof AbortController;
      BunAbortSignal: typeof AbortSignal;
    };
    const BunReq = native.BunRequest;
    fromKeptDays.mockClear();
    const client = new native.BunAbortController();
    const res = await app.handle(
      new BunReq("http://localhost/api/v1/metrics/kpis", {
        headers: { cookie: `fazerai_auth_token=${token}` },
        signal: client.signal,
      }),
    );
    expect(res.status).toBe(200);
    const signal = fromKeptDays.mock.calls[0]?.[6];
    expect(signal).toBeInstanceOf(native.BunAbortSignal);
    expect(signal?.aborted).toBe(false);
    client.abort();
    expect(signal?.aborted).toBe(true);
  });
});
