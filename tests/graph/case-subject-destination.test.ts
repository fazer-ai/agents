import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { seedChatwootInstance } from "../utils/chatwoot";

// A subject template only fits an email destination: one the config still holds after the destination
// changed to another channel is dropped at turn prep, so the model is not asked for a summary.

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;
const agents = new Map<number, bigint>();
const TEMPLATE = "Caso de {{nome_contato}}: {{resumo}}";

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

const templateFor = async (targetInboxId: number) => {
  const cfg = await runScopedOn(appDb, ctx(tenantId), (db) =>
    loadAgentConfig(db, {
      tenantId,
      instanceId,
      conversationId: 8830,
      agentId: agents.get(targetInboxId) as bigint,
      threadId: `${tenantId}:${instanceId}:8830`,
    }),
  );
  return cfg?.crossInboxCaseConfig.subjectTemplate;
};

describe.skipIf(!dbUp)(
  "the case subject template and the destination's channel",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "CS", slug: `cs-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 1,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const keyId = (
        await suDb.vaultEntry.create({
          data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
          select: { id: true },
        })
      ).id;
      for (const [chatwootInboxId, channelType] of [
        [40, "Channel::Email"],
        [41, "Channel::Api"],
      ] as const) {
        await suDb.inbox.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootInboxId,
            name: `Inbox ${chatwootInboxId}`,
            channelType,
          },
        });
      }
      for (const target of [40, 41, 42]) {
        const a = await suDb.agent.create({
          data: {
            tenantId,
            name: `Agente ${target}`,
            systemPrompt: "Você é um assistente.",
            modelConfig: {
              provider: "openai",
              model: "gpt-4o-mini",
              credentialRef: `vault:${keyId}`,
            },
            settings: {
              crossInboxCase: {
                targetInboxId: target,
                targetInstanceId: Number(instanceId),
                subjectTemplate: TEMPLATE,
              },
            },
          },
        });
        agents.set(target, a.id);
      }
    });

    afterAll(async () => {
      if (dbUp && tenantId)
        await suDb.tenant.delete({ where: { id: tenantId } });
      await suDb?.$disconnect();
      await appDb?.$disconnect();
    });

    test("an email destination keeps the template", async () => {
      expect(await templateFor(40)).toBe(TEMPLATE);
    });

    test("a destination that is not email drops it", async () => {
      expect(await templateFor(41)).toBeNull();
    });

    test("an inbox the mirror does not know keeps it", async () => {
      expect(await templateFor(42)).toBe(TEMPLATE);
    });
  },
);
