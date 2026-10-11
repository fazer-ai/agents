import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The REST read of an agent answers the execution limits the runtime enforces, next to the stored
// bag rather than in it: `settings` is what a PATCH sends back, so defaults written into it would
// be frozen into the agent. The service is WRAPPED, not stubbed, because `mock.module` is global to
// the worker; the wrapper hands the read the test database.

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
  } catch {
    dbUp = false;
  }
}

setupPrismaMock();

const service = await import("@/modules/agents/service");
const real = { ...service };
mock.module("@/modules/agents/service", () => ({
  ...real,
  getAgent: mock((ctx: Parameters<typeof service.getAgent>[0], id: bigint) =>
    real.getAgent(ctx, id, app),
  ),
}));

const server = (await import("@/app")).default;

afterAll(() => {
  mock.module("@/modules/agents/service", () => real);
});

const ADMIN_ID = 9468n;
let tenantId = 0n;
let bareId = "";
let savedId = "";
let cookie = "";

async function read(id: string) {
  const res = await server.handle(
    new BunRequest(`http://localhost/api/v1/agents/${id}`, {
      headers: { cookie },
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      agent: { settings: Record<string, unknown> };
      effective?: { limits: Record<string, unknown> };
    },
  };
}

describe.skipIf(!dbUp)("GET /v1/agents/:id effective limits", () => {
  beforeAll(async () => {
    if (!su) return;
    tenantId = (
      await su.tenant.create({
        data: { name: "EFFLIM", slug: `efflim-${process.pid}` },
      })
    ).id;
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: ADMIN_ID,
        tenantId,
        email: "admin@example.com",
        passwordHash: null,
        googleId: null,
        name: null,
        role: "TENANT_ADMIN" as const,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    cookie = `fazerai_auth_token=${await new SignJWT({
      userId: ADMIN_ID.toString(),
      email: "admin@example.com",
      role: "TENANT_ADMIN",
      tenantId: tenantId.toString(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret))}`;
    const modelConfig = { provider: "openai", model: "gpt-4o-mini" };
    bareId = String(
      (
        await su.agent.create({
          data: { tenantId, name: "bare", systemPrompt: "x", modelConfig },
          select: { id: true },
        })
      ).id,
    );
    savedId = String(
      (
        await su.agent.create({
          data: {
            tenantId,
            name: "saved",
            systemPrompt: "x",
            modelConfig,
            settings: {
              limits: {
                maxToolCalls: 5,
                maxTurnsPerHour: 0,
                maxProactivePerDay: null,
              },
            },
          },
          select: { id: true },
        })
      ).id,
    );
  });

  afterAll(async () => {
    if (dbUp && su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("an agent that never saved its limits reads the defaults, and settings stays as stored", async () => {
    const { status, body } = await read(bareId);
    expect(status).toBe(200);
    expect(body.agent.settings).toEqual({});
    expect(body.effective?.limits).toEqual({
      maxToolCalls: 10,
      maxHistoryTokens: null,
      retrySilence: true,
      maxTurnsPerHour: 60,
      maxProactivePerDay: 10,
    });
  });

  test("a stored 0 stays off and a stored null reads as the default", async () => {
    const { status, body } = await read(savedId);
    expect(status).toBe(200);
    expect(body.agent.settings).toEqual({
      limits: { maxToolCalls: 5, maxTurnsPerHour: 0, maxProactivePerDay: null },
    });
    expect(body.effective?.limits).toEqual({
      maxToolCalls: 5,
      maxHistoryTokens: null,
      retrySilence: true,
      maxTurnsPerHour: 0,
      maxProactivePerDay: 10,
    });
  });
});
