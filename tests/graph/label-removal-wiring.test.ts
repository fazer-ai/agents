import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// The removal setting is read from the agent's stored settings at turn prep, not only handed to the
// tool by a test: an agent saved with `setLabels.removal: "allowed"` loads with the fence on.

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;
const agents: Record<string, bigint> = {};
const CONV_ID = 15790;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

const load = (agentId: bigint) =>
  runScopedOn(appDb, ctx(tenantId), (db) =>
    loadAgentConfig(db, {
      tenantId,
      instanceId,
      conversationId: CONV_ID,
      agentId,
      threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
    }),
  );

describe.skipIf(!dbUp)("the removal setting at turn prep", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Remocao", slug: `remocao-1579-${process.pid}` },
      })
    ).id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 1,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      })
    ).id;
    const keyId = (
      await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      })
    ).id;
    const make = async (name: string, settings: object) =>
      (
        await suDb.agent.create({
          data: {
            tenantId,
            name,
            systemPrompt: "Você é um assistente.",
            modelConfig: {
              provider: "openai",
              model: "gpt-4o-mini",
              credentialRef: `vault:${keyId}`,
            },
            settings,
          },
        })
      ).id;
    agents.limited = await make("Limitado", {
      setLabels: { allowed: ["cancelamento"], removal: "allowed" },
    });
    agents.plain = await make("Livre", {
      setLabels: { allowed: ["cancelamento"] },
    });
  });

  afterAll(async () => {
    if (dbUp && tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("an agent saved with removal allowed loads with it, one without loads any", async () => {
    expect((await load(agents.limited as bigint))?.labelRemoval).toBe(
      "allowed",
    );
    expect((await load(agents.plain as bigint))?.labelRemoval).toBe("any");
  });
});
