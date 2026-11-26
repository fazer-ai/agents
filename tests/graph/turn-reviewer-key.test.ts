import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// The turn reviewer runs on the guardrails chat model's key under the screening gate's rule: with no
// key resolved there is no model, whatever endpoint is saved, and the review writes
// `credential_not_found`.

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
let keyId = 0n;
const CONV_ID = 15791;

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

const agentWith = async (name: string, guardrails: object) =>
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
        settings: {
          guardrails: {
            enabled: true,
            turnReview: { enabled: true },
            ...guardrails,
          },
        },
      },
    })
  ).id;

describe.skipIf(!dbUp)("the turn reviewer's key at turn prep", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Revisor", slug: `revisor-chave-${process.pid}` },
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
    keyId = (
      await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (dbUp && tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
    await app?.$disconnect();
    await su?.$disconnect();
  });

  // The bug it catches: an OpenAI-compatible chat model with an endpoint and no key read as a
  // reviewer that runs, unlike the screening gate on the same model.
  test("a compatible endpoint with no key is no reviewer, and a resolved key is one", async () => {
    const keyless = await agentWith("Sem chave", {
      provider: "openai-compatible",
      model: "modelo-local",
      baseURL: "http://modelo.local/v1",
    });
    const keyed = await agentWith("Com chave", {
      provider: "openai",
      model: "gpt-4o-mini",
      credentialRef: `vault:${keyId}`,
    });
    expect((await load(keyless))?.turnReviewer).toMatchObject({
      runnable: false,
      reason: "credential_not_found",
    });
    expect((await load(keyed))?.turnReviewer).toMatchObject({
      runnable: true,
      apiKey: "sk-test",
    });
  });
});
