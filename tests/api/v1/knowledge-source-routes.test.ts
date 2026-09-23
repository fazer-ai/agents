import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { generateApiKey } from "@/modules/api-keys/verify";
import type { SourceInput } from "@/modules/rag/source";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The three REST routes of a knowledge base source (issue #794), measured at the door: who may call
// them, what a malformed body gets back, and what a missing base or a base without a source answers.
// The source module runs for real against the test database; the only seams are the database handle
// (the app's singleton is mocked by the harness) and the SSRF check's DNS lookup, which a portal on a
// documentation name would fail for the environment's reasons instead of the route's.

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

const source = await import("@/modules/rag/source");
const realSource = { ...source };
const allowAll = async () => undefined;
mock.module("@/modules/rag/source", () => ({
  ...realSource,
  getSource: (ctx: TenantContext, id: bigint) =>
    realSource.getSource(ctx, id, app),
  setSource: (ctx: TenantContext, id: bigint, input: SourceInput) =>
    realSource.setSource(ctx, id, input, app, allowAll),
  deleteSource: (ctx: TenantContext, id: bigint) =>
    realSource.deleteSource(ctx, id, app),
  requestSync: (ctx: TenantContext, id: bigint) =>
    realSource.requestSync(ctx, id, app),
}));

const server = (await import("@/app")).default;

afterAll(() => {
  mock.module("@/modules/api-keys/verify", () => realVerify);
  mock.module("@/modules/rag/source", () => realSource);
});

const USER_ID = 9794n;
let tenantId = 0n;
let otherTenantId = 0n;
let kb = 0n;
let foreignKb = 0n;
let agentKey = "";
let adminKey = "";

const GOOD = {
  kind: "chatwoot_portal",
  baseUrl: "https://ajuda.loja-exemplo.com.br",
  slug: "ajuda",
  locale: "pt-BR",
};

function call(
  method: "PUT" | "DELETE" | "POST",
  path: string,
  key: string,
  body?: unknown,
): Promise<Response> {
  return server.handle(
    new BunRequest(`http://localhost/api/v1/knowledge${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

async function mintKey(role: "TENANT_ADMIN" | "AGENT"): Promise<string> {
  const { token, hash, prefix } = generateApiKey();
  // Inserted directly: `createApiKey` fixes the role at TENANT_ADMIN, so an AGENT key cannot be
  // minted through the service (the same reason as reengage-role-gate.test.ts).
  await su?.apiKey.create({
    data: {
      tenantId,
      displayName: role,
      keyHash: hash,
      keyPrefix: prefix,
      role,
      createdByUserId: USER_ID,
      stepUpAt: new Date(),
    },
  });
  return token;
}

describe.skipIf(!dbUp)("knowledge base source routes (issue #794)", () => {
  beforeAll(async () => {
    if (!su) return;
    tenantId = (
      await su.tenant.create({
        data: { name: "KSR794", slug: `ksr-794-${process.pid}` },
      })
    ).id;
    otherTenantId = (
      await su.tenant.create({
        data: { name: "KSR794O", slug: `ksr-794-o-${process.pid}` },
      })
    ).id;
    kb = (await su.knowledgeBase.create({ data: { tenantId, name: "ajuda" } }))
      .id;
    foreignKb = (
      await su.knowledgeBase.create({
        data: { tenantId: otherTenantId, name: "alheia" },
      })
    ).id;
    agentKey = await mintKey("AGENT");
    adminKey = await mintKey("TENANT_ADMIN");
  });

  afterAll(async () => {
    if (su) {
      for (const tid of [tenantId, otherTenantId]) {
        if (!tid) continue;
        for (const table of ["audit_logs", "api_keys", "scheduler_jobs"]) {
          await su.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
          );
        }
        await su.tenant.delete({ where: { id: tid } });
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("an AGENT is refused on all three routes and nothing is written", async () => {
    const answers = [
      await call("PUT", `/bases/${kb}/source`, agentKey, GOOD),
      await call("POST", `/bases/${kb}/source/sync`, agentKey),
      await call("DELETE", `/bases/${kb}/source`, agentKey),
    ];
    expect(answers.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(
      await su?.knowledgeSource.findUnique({ where: { knowledgeBaseId: kb } }),
    ).toBeNull();
  });

  test("asking for a sync or a removal on a base with no source is refused, not a 500", async () => {
    const sync = await call("POST", `/bases/${kb}/source/sync`, adminKey);
    const remove = await call("DELETE", `/bases/${kb}/source`, adminKey);
    expect(sync.status).toBe(409);
    expect(remove.status).toBe(404);
  });

  test("a malformed body is refused with the field, and nothing is saved", async () => {
    const cases: [unknown, number][] = [
      [{ ...GOOD, slug: "a/b" }, 400],
      [{ ...GOOD, kind: "url_crawl" }, 400],
      [{ ...GOOD, intervalMinutes: 1 }, 400],
      [{ ...GOOD, excludeIds: ["x"] }, 400],
      [{ ...GOOD, baseUrl: 42 }, 422],
    ];
    for (const [body, status] of cases) {
      const res = await call("PUT", `/bases/${kb}/source`, adminKey, body);
      expect([JSON.stringify(body), res.status]).toEqual([
        JSON.stringify(body),
        status,
      ]);
    }
    expect(
      await su?.knowledgeSource.findUnique({ where: { knowledgeBaseId: kb } }),
    ).toBeNull();
  });

  test("another tenant's base and a base that does not exist answer 404", async () => {
    for (const id of [foreignKb, 999_999_999n]) {
      const set = await call("PUT", `/bases/${id}/source`, adminKey, GOOD);
      const sync = await call("POST", `/bases/${id}/source/sync`, adminKey);
      expect([set.status, sync.status]).toEqual([404, 404]);
    }
    expect(
      await su?.knowledgeSource.findUnique({
        where: { knowledgeBaseId: foreignKb },
      }),
    ).toBeNull();
  });

  test("an admin sets, syncs and removes the source, and each step is audited", async () => {
    const set = await call("PUT", `/bases/${kb}/source`, adminKey, {
      ...GOOD,
      excludeIds: [9, 4],
      intervalMinutes: 30,
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { source: unknown }).source).toMatchObject({
      kind: "chatwoot_portal",
      baseUrl: GOOD.baseUrl,
      excludeIds: [4, 9],
      intervalMinutes: 30,
    });
    expect(
      (await call("POST", `/bases/${kb}/source/sync`, adminKey)).status,
    ).toBe(200);
    expect((await call("DELETE", `/bases/${kb}/source`, adminKey)).status).toBe(
      200,
    );
    expect(
      await su?.knowledgeSource.findUnique({ where: { knowledgeBaseId: kb } }),
    ).toBeNull();
    const actions = await su?.auditLog.findMany({
      where: { tenantId, action: { startsWith: "knowledge_source." } },
      orderBy: { id: "asc" },
      select: { action: true },
    });
    expect(actions?.map((a) => a.action)).toEqual([
      "knowledge_source.set",
      "knowledge_source.sync",
      "knowledge_source.delete",
    ]);
  });
});
