import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// THE REFUSAL AS THE CALLER RECEIVES IT (#614), through the route rather than the service.
//
// `tests/modules/agents.test.ts` proves the rule; it cannot see the half that made the issue: the
// opt-in travels in the PATCH body, and a controller that parses it and forgets to hand it down
// leaves every replace refused, while one that never asks leaves every partial bag destroying
// configuration. Both halves look identical from inside the service.
//
// Same wrapper as tests/api/v1/agents-audit-actor.test.ts, and for the same reason: the controller
// has no way to inject the test database, so the service is WRAPPED (never stubbed) to hand it one.

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
// A COPY taken before the mock is installed: Bun updates the imported namespace in place, so a
// wrapper that called `service.updateAgent` by name would call itself.
const real = { ...service };
mock.module("@/modules/agents/service", () => ({
  ...real,
  updateAgent: mock(
    async (
      ctx: TenantContext,
      id: bigint,
      patch: Parameters<typeof service.updateAgent>[2],
      _base: unknown,
      opts: Parameters<typeof service.updateAgent>[4],
    ) => real.updateAgent(ctx, id, patch, app, opts),
  ),
}));

const server = (await import("@/app")).default;

// Top-level, outside the describe: an `afterAll` inside a `describe.skipIf` that skips does not run,
// and the wrapper is already global to this worker by then.
afterAll(() => {
  mock.module("@/modules/agents/service", () => real);
});

const ADMIN_ID = 6146n;
let tenantId = 0n;
let agentId = "";
let cookie = "";

const STORED = {
  signature: { enabled: true, text: "Alex", position: "top" },
  debounce: { enabled: true, windowSeconds: 8 },
  followUp: { enabled: true },
  split: { enabled: true },
};

const settingsOf = async (): Promise<Record<string, unknown>> => {
  const row = await su?.agent.findFirstOrThrow({
    where: { id: BigInt(agentId) },
  });
  return (row?.settings ?? {}) as Record<string, unknown>;
};

const patch = (body: Record<string, unknown>) =>
  server.handle(
    new BunRequest(`http://localhost/api/v1/agents/${agentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );

describe.skipIf(!dbUp)("a partial settings bag over the wire", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    const t = await su.tenant.create({
      data: { name: "SETMODE", slug: `setmode-${process.pid}` },
    });
    tenantId = t.id;
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
    const token = await new SignJWT({
      userId: ADMIN_ID.toString(),
      email: "admin@example.com",
      role: "TENANT_ADMIN",
      tenantId: tenantId.toString(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret));
    cookie = `fazerai_auth_token=${token}`;
    const agent = await real.createAgent(
      { tenantId, userId: ADMIN_ID, role: "TENANT_ADMIN" },
      { name: `setmode-${process.pid}`, systemPrompt: "p" },
      app,
    );
    agentId = agent.id;
  });

  afterAll(async () => {
    if (dbUp && su && tenantId) {
      for (const table of ["audit_logs", "agents"]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("is refused with 400, naming every block it would cost", async () => {
    await su?.agent.update({
      where: { id: BigInt(agentId) },
      data: { settings: STORED },
    });
    const res = await patch({ settings: { split: { enabled: false } } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; field?: string };
    // The sentence the caller reads has to carry what it would have cost, or the refusal is a riddle.
    for (const block of ["signature", "debounce", "followUp"]) {
      expect(body.error).toContain(block);
    }
    // And the way out, by the name the body spells it with.
    expect(body.error).toContain("settingsMode");
    expect(body.field).toBe("settings");
    expect(await settingsOf()).toEqual(STORED);
  });

  test("goes through when the body declares the replacement", async () => {
    await su?.agent.update({
      where: { id: BigInt(agentId) },
      data: { settings: STORED },
    });
    const res = await patch({
      settings: { split: { enabled: false } },
      settingsMode: "replace",
    });
    expect(res.status).toBe(200);
    expect(await settingsOf()).toEqual({ split: { enabled: false } });
  });

  test("a bag that drops nothing needs no declaration", async () => {
    await su?.agent.update({
      where: { id: BigInt(agentId) },
      data: { settings: STORED },
    });
    const res = await patch({
      settings: { ...STORED, split: { enabled: false } },
    });
    expect(res.status).toBe(200);
    const after = await settingsOf();
    expect(after.signature).toEqual(STORED.signature);
    expect(after.split).toEqual({ enabled: false });
  });

  // The schema publishes one value, so the typo is answered by the route rather than reaching the
  // service as "not replace" — which would read as the refusing default and destroy nothing, but
  // would also tell the caller their word was accepted.
  test("a settingsMode the schema does not publish is refused by the route", async () => {
    await su?.agent.update({
      where: { id: BigInt(agentId) },
      data: { settings: STORED },
    });
    const res = await patch({
      settings: { split: { enabled: false } },
      settingsMode: "REPLACE",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await settingsOf()).toEqual(STORED);
  });
});
