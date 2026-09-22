import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { generateApiKey } from "@/modules/api-keys/verify";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// WHO CAN SEE WHAT THE AGENT FILTER OFFERS (issue #607, review round 1).
//
// The Conversations screen is not admin-gated, and the filter first read its options from
// `/v1/agents`, which is TENANT_ADMIN: an AGENT-role user got no control at all, and a shared link
// carrying `agentId` narrowed their list with nothing on screen to see or clear. The options now come
// from the conversations' own read, behind the same gate as the list.
//
// The control is part of the measurement, as in reengage-role-gate.test.ts: the same AGENT key is
// refused by `/v1/agents`, so the 200 below is the new route's gate and not a key that could read
// everything.

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

const verify = await import("@/modules/api-keys/verify");
const realVerify = { ...verify };
mock.module("@/modules/api-keys/verify", () => ({
  ...realVerify,
  verifyApiKey: (token: string) => realVerify.verifyApiKey(token, app),
}));

// The real read, pointed at this file's database: the shared prisma stub carries users and tenants
// only. A copy taken before the mock, since Bun updates the namespace in place.
const conversations = await import("@/modules/conversations/service");
const realConversations = { ...conversations };
mock.module("@/modules/conversations/service", () => ({
  ...realConversations,
  listConversationAgentOptions: (ctx: TenantContext) =>
    realConversations.listConversationAgentOptions(ctx, app),
}));

const server = (await import("@/app")).default;

afterAll(() => {
  mock.module("@/modules/api-keys/verify", () => realVerify);
  mock.module("@/modules/conversations/service", () => realConversations);
});

const USER_ID = 9607n;
let tenantId = 0n;
let otherTenantId = 0n;
let agentKey = "";

function get(path: string, bearer?: string): Promise<Response> {
  return server.handle(
    new BunRequest(`http://localhost/api/v1${path}`, {
      method: "GET",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
  );
}

describe.skipIf(!dbUp)("the agent filter's options", () => {
  beforeAll(async () => {
    if (!su) return;
    tenantId = (
      await su.tenant.create({
        data: { name: "OPT607", slug: `opt-607-${process.pid}` },
      })
    ).id;
    otherTenantId = (
      await su.tenant.create({
        data: { name: "OPT607B", slug: `opt-607-b-${process.pid}` },
      })
    ).id;
    for (const name of ["Vendas", "Atendimento"]) {
      await su.agent.create({ data: { tenantId, name, systemPrompt: "x" } });
    }
    await su.agent.create({
      data: { tenantId: otherTenantId, name: "Alheio", systemPrompt: "x" },
    });
    const { token, hash, prefix } = generateApiKey();
    // Inserted directly: `createApiKey` fixes the role at TENANT_ADMIN, so the rank this is about
    // cannot be minted through the service (same note in reengage-role-gate.test.ts).
    await su.apiKey.create({
      data: {
        tenantId,
        displayName: "agent-607",
        keyHash: hash,
        keyPrefix: prefix,
        role: "AGENT",
        createdByUserId: USER_ID,
        stepUpAt: new Date(),
      },
    });
    agentKey = token;
  });

  afterAll(async () => {
    for (const tid of [tenantId, otherTenantId]) {
      if (!tid) continue;
      for (const tbl of ["api_keys", "agents"]) {
        await su?.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tid}`,
        );
      }
      await su?.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("an AGENT-role key reads its own tenant's agents, id and name only", async () => {
    const res = await get("/conversations/agents", agentKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Record<string, unknown>[];
    };
    expect(body.agents.map((a) => a.name)).toEqual(["Atendimento", "Vendas"]);
    for (const a of body.agents)
      expect(Object.keys(a).sort()).toEqual(["id", "name"]);
  });

  test("the control: the same key is refused by the admin agent list", async () => {
    const res = await get("/agents", agentKey);
    expect(res.status).toBe(403);
  });

  test("without credentials it is refused", async () => {
    const res = await get("/conversations/agents");
    expect(res.status).toBe(401);
  });
});
