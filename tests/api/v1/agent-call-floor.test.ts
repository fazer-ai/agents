import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { dbProbeFailed } from "@/tests/db-gate";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The call-floor estimate over the console's door: who may ask, and which agent ids answer
// (tests/modules/call-floor.test.ts proves the numbers). The service is WRAPPED, not stubbed, because
// `mock.module` is global to the worker; the wrapper records the context and hands the read the test
// database.

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

const playground = await import("@/modules/playground/service");
const real = { ...playground };
const seen: TenantContext[] = [];
mock.module("@/modules/playground/service", () => ({
  ...real,
  estimateCallFloor: mock(
    async (params: Parameters<typeof playground.estimateCallFloor>[0]) => {
      seen.push(params.ctx);
      return real.estimateCallFloor({ ...params, base: app });
    },
  ),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does NOT
// run, and `mock.module` has already installed the wrapper for the whole worker by then.
afterAll(() => {
  mock.module("@/modules/playground/service", () => real);
});

const USER_ID = 9468n;
let tenantId = 0n;
let otherTenantId = 0n;
let agentId = "";
let otherAgentId = "";

async function cookieAs(role: "TENANT_ADMIN" | "AGENT") {
  mockFindUnique.mockImplementation(() =>
    Promise.resolve({
      id: USER_ID,
      tenantId,
      email: "user@example.com",
      passwordHash: null,
      googleId: null,
      name: null,
      role,
      lastLoginAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
  return `fazerai_auth_token=${await new SignJWT({
    userId: USER_ID.toString(),
    email: "user@example.com",
    role,
    tenantId: tenantId.toString(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(config.jwtSecret))}`;
}

const get = (id: string, cookie?: string) =>
  server.handle(
    new BunRequest(`http://localhost/api/v1/agents/${id}/call-floor`, {
      headers: cookie ? { cookie } : {},
    }),
  );

const post = (id: string, grants: unknown, cookie?: string) =>
  server.handle(
    new BunRequest(`http://localhost/api/v1/agents/${id}/call-floor`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ grants }),
    }),
  );

describe.skipIf(!dbUp)("GET /v1/agents/:id/call-floor", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    tenantId = (
      await su.tenant.create({
        data: { name: "CFREST", slug: `cfrest-${process.pid}` },
      })
    ).id;
    otherTenantId = (
      await su.tenant.create({
        data: { name: "CFREST B", slug: `cfrest-b-${process.pid}` },
      })
    ).id;
    for (const [t, set] of [
      [tenantId, (id: string) => (agentId = id)],
      [otherTenantId, (id: string) => (otherAgentId = id)],
    ] as const) {
      const a = await su.agent.create({
        data: {
          tenantId: t,
          name: "Floor",
          systemPrompt: "Você atende a loja.",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
        select: { id: true },
      });
      set(String(a.id));
    }
  });

  afterAll(async () => {
    if (dbUp && su) {
      for (const id of [tenantId, otherTenantId]) {
        if (!id) continue;
        await su.$executeRawUnsafe(
          `DELETE FROM agents WHERE tenant_id = ${id}`,
        );
        await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("no session is refused before the estimate runs", async () => {
    seen.length = 0;
    expect((await get(agentId)).status).toBe(401);
    expect(seen).toEqual([]);
  });

  test("an AGENT-role session is refused: it sizes a prompt it cannot edit", async () => {
    seen.length = 0;
    expect((await get(agentId, await cookieAs("AGENT"))).status).toBe(403);
    expect(seen).toEqual([]);
  });

  test("an admin gets the floor, asked as its own tenant", async () => {
    seen.length = 0;
    const res = await get(agentId, await cookieAs("TENANT_ADMIN"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      floor: { engine: string; instructions: number; total: number };
    };
    expect(seen[0]?.tenantId).toBe(tenantId);
    expect(body.floor.engine).toBe("llm");
    expect(body.floor.instructions).toBeGreaterThan(0);
    expect(body.floor.total).toBeGreaterThanOrEqual(body.floor.instructions);
  });

  test("another tenant's agent and a missing one are both 404; a malformed id is 400", async () => {
    const cookie = await cookieAs("TENANT_ADMIN");
    expect((await get(otherAgentId, cookie)).status).toBe(404);
    expect((await get("999999999", cookie)).status).toBe(404);
    expect((await get("abc", cookie)).status).toBe(400);
  });

  // The editor's unsaved set: the same doors, and the grants reach the estimate as sent.
  test("POST measures the grants it is sent, behind the same doors", async () => {
    const grants = [{ source: "NATIVE", enabledTools: ["calculator"] }];
    seen.length = 0;
    expect((await post(agentId, grants)).status).toBe(401);
    expect((await post(agentId, grants, await cookieAs("AGENT"))).status).toBe(
      403,
    );
    expect(seen).toEqual([]);
    const cookie = await cookieAs("TENANT_ADMIN");
    const res = await post(agentId, grants, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      floor: { tools: { name: string }[] };
    };
    expect(body.floor.tools.map((t) => t.name)).toEqual(["calculator"]);
    expect(
      (
        await post(
          agentId,
          [{ source: "NATIVE", enabledTools: ["nope"] }],
          cookie,
        )
      ).status,
    ).toBe(400);
    expect((await post(otherAgentId, grants, cookie)).status).toBe(404);
  });
});
