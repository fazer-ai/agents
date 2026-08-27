import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The agent trail, driven through a real request to the console's own door.
//
// `tests/modules/audit-agent-family.test.ts` proves the SERVICE records. It cannot see the half the
// issue is actually about: whether the REST route reaches that service with a principal at all. The
// console speaks these six routes, `agents.controller.ts` never mentioned `audit`, and the row can
// only name who wrote it if the transport hands the context down.
//
// The service is WRAPPED and the wrapper calls through, for the reason `mock.module` always demands
// here: it is global to the process and outlives this file for every other one in the same worker, so
// a stub that swallowed the real behaviour would turn somebody else's file green for the wrong
// reason. All the wrapper does is record the context it was handed and give the write the test
// database, which the controller has no way to inject.

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
const seen: TenantContext[] = [];
mock.module("@/modules/agents/service", () => ({
  ...real,
  updateAgent: mock(
    async (
      ctx: TenantContext,
      id: bigint,
      patch: Parameters<typeof service.updateAgent>[2],
      _base: unknown,
      opts: Parameters<typeof service.updateAgent>[4],
    ) => {
      seen.push(ctx);
      return real.updateAgent(ctx, id, patch, app, opts);
    },
  ),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe below, and measured rather than assumed: an `afterAll` inside a
// `describe.skipIf(...)` that skips does NOT run, while this one does. `mock.module` already
// installed the wrapper globally for the whole worker by the time `dbUp` was decided, so leaving the
// restore inside would leak it into every later file in the same process — handing their writes an
// `app` that is `undefined` and routing them into the incomplete singleton mock.
afterAll(() => {
  mock.module("@/modules/agents/service", () => real);
});

const ADMIN_ID = 9393n;
let tenantId = 0n;
let agentId = "";
let cookie = "";

const rows = async () =>
  (await su?.auditLog.findMany({
    where: { actorId: ADMIN_ID },
    orderBy: { id: "asc" },
  })) ?? [];

describe.skipIf(!dbUp)("the agents transport names who wrote", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    const t = await su.tenant.create({
      data: { name: "AUDREST", slug: `audrest-${process.pid}` },
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
      { name: `rest-${process.pid}`, systemPrompt: "before" },
      app,
    );
    agentId = agent.id;
    await su.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE actor_id = ${ADMIN_ID}`,
    );
  });

  afterAll(async () => {
    // `dbUp`, not `su`: the probe assigns the client and only then checks the connection, so a
    // configured-but-unreachable database leaves `su` truthy while the suite skips.
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

  test("a PATCH with no session is refused before reaching the service", async () => {
    seen.length = 0;
    const res = await server.handle(
      new BunRequest(`http://localhost/api/v1/agents/${agentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "nope" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  test("a PATCH from a console session leaves a row that names the operator", async () => {
    seen.length = 0;
    const res = await server.handle(
      new BunRequest(`http://localhost/api/v1/agents/${agentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ systemPrompt: "after" }),
      }),
    );
    expect(res.status).toBe(200);
    // The context the route handed down, which is where the row's actor comes from.
    expect(seen.length).toBe(1);
    expect(seen[0]?.userId).toBe(ADMIN_ID);
    expect(seen[0]?.tenantId).toBe(tenantId);

    const got = await rows();
    expect(got.length).toBe(1);
    expect(got[0]?.action).toBe("agent.prompt_set");
    expect(got[0]?.target).toBe(`agent:${agentId}`);
    // A browser session, not the MCP transport: `actorType` is the only field that says which door.
    expect(got[0]?.actorType).toBe("user");
    expect(got[0]?.before).toEqual({ systemPrompt: "before" });
    expect(got[0]?.after).toEqual({ systemPrompt: "after" });
  });
});
