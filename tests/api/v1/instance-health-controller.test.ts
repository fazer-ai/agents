import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { dbProbeFailed } from "@/tests/db-gate";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The instance health routes at the request boundary: a tenant's API key is refused on every one of
// them, a fleet key reads. Services are WRAPPED to the test database and call through, since
// `mock.module` is worker-global.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

setupPrismaMock();

const verify = await import("@/modules/api-keys/verify");
const realVerify = { ...verify };
mock.module("@/modules/api-keys/verify", () => ({
  ...realVerify,
  verifyApiKey: (token: string) => realVerify.verifyApiKey(token, app),
}));

const read = await import("@/modules/instance-health/read");
const realRead = { ...read };
mock.module("@/modules/instance-health/read", () => ({
  ...realRead,
  readInstanceHealth: (sampling: boolean) =>
    realRead.readInstanceHealth(sampling, app),
}));

const channels = await import("@/modules/instance-health/channels");
const realChannels = { ...channels };
mock.module("@/modules/instance-health/channels", () => ({
  ...realChannels,
  listInstanceAlertChannels: () => realChannels.listInstanceAlertChannels(app),
  listInstanceThresholds: () => realChannels.listInstanceThresholds(app),
}));

const keys = await import("@/modules/api-keys/service");
const server = (await import("@/app")).default;

afterAll(() => {
  mock.module("@/modules/api-keys/verify", () => realVerify);
  mock.module("@/modules/instance-health/read", () => realRead);
  mock.module("@/modules/instance-health/channels", () => realChannels);
});

const send = (
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> =>
  server.handle(
    new BunRequest(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "accept-language": "en",
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const SUPER_ID = 9531n;
let tenantId = 0n;
let tenantToken = "";
let fleetToken = "";

describe.skipIf(!dbUp)("instance health routes", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    tenantId = (
      await su.tenant.create({
        data: { name: "IH-REST", slug: `ih-rest-${process.pid}` },
      })
    ).id;
    const ctx: TenantContext = {
      tenantId,
      userId: SUPER_ID,
      role: "TENANT_ADMIN",
    };
    tenantToken = (
      await keys.createApiKey(ctx, { displayName: "tenant key" }, app)
    ).token;
    fleetToken = (
      await keys.createFleetApiKey(
        { tenantId: null, userId: SUPER_ID, role: "SUPER_ADMIN" },
        { displayName: "fleet key" },
        app,
      )
    ).token;
  });

  afterAll(async () => {
    if (!su) return;
    await su.apiKey.deleteMany({ where: { createdByUserId: SUPER_ID } });
    if (tenantId) await su.tenant.delete({ where: { id: tenantId } });
  });

  test("a tenant's key is refused on every route (catches a tenant admin reading or wiring the fleet's alerts)", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/v1/instance-health"],
      ["GET", "/api/v1/instance-health/channels"],
      [
        "POST",
        "/api/v1/instance-health/channels",
        { name: "x", type: "discord", url: "https://203.0.113.10/x" },
      ],
      ["PATCH", "/api/v1/instance-health/channels/1", { enabled: false }],
      ["DELETE", "/api/v1/instance-health/channels/1"],
      ["POST", "/api/v1/instance-health/channels/1/test"],
      ["GET", "/api/v1/instance-health/thresholds"],
      [
        "PUT",
        "/api/v1/instance-health/thresholds/event_loop_p99_ms",
        { threshold: 1, durationSeconds: 0 },
      ],
      ["DELETE", "/api/v1/instance-health/thresholds/event_loop_p99_ms"],
    ];
    for (const [method, path, body] of calls) {
      const res = await send(method, path, tenantToken, body);
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  test("a fleet key reads every signal with its threshold", async () => {
    const res = await send("GET", "/api/v1/instance-health", fleetToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      health: { signals: { signal: string; threshold: number }[] };
    };
    const keys = body.health.signals.map((s) => s.signal);
    expect(keys).toContain("event_loop_p99_ms");
    expect(keys).toContain("scheduler_queue_age_ms:debounce");
    expect(
      body.health.signals.find((s) => s.signal === "event_loop_p99_ms")
        ?.threshold,
    ).toBeGreaterThan(0);
  });

  test("the public /health keeps its shape and carries no signal (catches load numbers published unauthenticated)", async () => {
    const res = await server.handle(
      new BunRequest("http://localhost/api/health", { method: "GET" }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["db", "name", "status", "version"].sort(),
    );
  });
});
