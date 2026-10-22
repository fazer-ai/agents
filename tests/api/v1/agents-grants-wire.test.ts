import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { dbProbeFailed } from "@/tests/db-gate";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// `grants` on the agent's PATCH, through the route (tests/modules/agent-update-with-grants.test.ts
// proves the transaction): a controller that dropped it would write the fields and leave the set, and
// the service could not tell. The service is WRAPPED as in tests/api/v1/agents-audit-actor.test.ts
// to get the test DB.

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

const service = await import("@/modules/agents/service");
// A COPY taken before the mock is installed: Bun updates the imported namespace in place, so a
// wrapper that called `service.updateAgentAndGrants` by name would call itself.
const real = { ...service };
mock.module("@/modules/agents/service", () => ({
  ...real,
  updateAgentAndGrants: mock(
    async (
      ctx: TenantContext,
      id: bigint,
      patch: Parameters<typeof service.updateAgentAndGrants>[2],
      grants: Parameters<typeof service.updateAgentAndGrants>[3],
      _base: unknown,
      opts: Parameters<typeof service.updateAgentAndGrants>[5],
    ) => real.updateAgentAndGrants(ctx, id, patch, grants, app, opts),
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

const enabledTools = async (): Promise<string[]> =>
  (
    (await su?.agentToolSelection.findMany({
      where: { agentId: BigInt(agentId) },
    })) ?? []
  ).flatMap((g) => g.enabledTools);

const patch = (body: Record<string, unknown>) =>
  server.handle(
    new BunRequest(`http://localhost/api/v1/agents/${agentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );

describe.skipIf(!dbUp)("the grants over the wire", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    const t = await su.tenant.create({
      data: { name: "GRANTWIRE", slug: `grantwire-${process.pid}` },
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
      { name: `grantwire-${process.pid}`, systemPrompt: "p" },
      app,
    );
    agentId = agent.id;
  });

  afterAll(async () => {
    if (dbUp && su && tenantId) {
      for (const table of ["audit_logs", "agent_tool_selections", "agents"]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("writes the fields and the set, and answers the set as written", async () => {
    const res = await patch({
      name: "Renamed with grants",
      grants: [{ source: "NATIVE", enabledTools: ["private_note"] }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: { name: string; updatedAt: string };
      toolSelection?: {
        grants: { enabledTools: string[] }[];
        agentUpdatedAt: string;
      };
    };
    expect(body.agent.name).toBe("Renamed with grants");
    expect(body.toolSelection?.grants.flatMap((g) => g.enabledTools)).toEqual([
      "private_note",
    ]);
    expect(body.toolSelection?.agentUpdatedAt).toBe(body.agent.updatedAt);
    expect(await enabledTools()).toEqual(["private_note"]);
  });

  test("a grant the server refuses leaves the fields as they were", async () => {
    const before = await su?.agent.findFirstOrThrow({
      where: { id: BigInt(agentId) },
    });
    const res = await patch({
      name: "Not this",
      grants: [{ source: "HTTP", toolDefinitionId: "999999999" }],
    });
    expect(res.status).toBe(404);
    const after = await su?.agent.findFirstOrThrow({
      where: { id: BigInt(agentId) },
    });
    expect(after?.name).toBe(before?.name);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });

  test("without grants the answer carries no selection and the set is untouched", async () => {
    const tools = await enabledTools();
    const res = await patch({ name: "Fields only" });
    expect(res.status).toBe(200);
    expect("toolSelection" in ((await res.json()) as object)).toBe(false);
    expect(await enabledTools()).toEqual(tools);
  });
});
