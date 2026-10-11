import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getInstanceMetrics } from "@/modules/analytics/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

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

let tenantA = 0n;
let tenantB = 0n;
let agent1 = 0n;
let instA = 0n;
let inboxA = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("getInstanceMetrics", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "MetA", slug: `met-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "MetB", slug: `met-b-${process.pid}` },
    });
    tenantB = b.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenantA,
        name: "A1",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    agent1 = agent.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      accountId: 1,
      baseUrl: "https://cw.example",
      adminToken: "enc",
    });
    instA = inst.id;
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenantA,
        chatwootInstanceId: instA,
        chatwootInboxId: 1,
        name: "WhatsApp",
      },
    });
    inboxA = inbox.id;
    // LLM usage for A: two inbox calls (same agent + inbox, with cached tokens, one on a second
    // model) + one playground call (must not pollute the real figures) + one for B (isolation).
    await suDb.llmUsage.createMany({
      data: [
        {
          tenantId: tenantA,
          agentId: agent1,
          inboxId: inboxA,
          source: "inbox",
          model: "gpt-4o-mini",
          promptTokens: 100,
          completionTokens: 40,
          cachedReadTokens: 60,
          cacheCreationTokens: 10,
        },
        {
          tenantId: tenantA,
          agentId: agent1,
          inboxId: inboxA,
          source: "inbox",
          model: "gpt-4o",
          promptTokens: 50,
          completionTokens: 10,
          cachedReadTokens: 20,
        },
        {
          tenantId: tenantA,
          agentId: agent1,
          source: "playground",
          model: "gpt-4o-mini",
          promptTokens: 7,
          completionTokens: 3,
        },
        {
          tenantId: tenantB,
          model: "gpt-4o-mini",
          promptTokens: 999,
          completionTokens: 999,
        },
      ],
    });
    // Conversations for A: 2 open, 1 pending.
    for (const [cid, status] of [
      [10, "open"],
      [11, "open"],
      [12, "pending"],
    ] as const) {
      await suDb.conversation.create({
        data: {
          tenantId: tenantA,
          chatwootInstanceId: instA,
          chatwootConversationId: cid,
          status,
          threadId: `${tenantA}:${instA}:${cid}`,
        },
      });
    }
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM llm_usage WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM conversations WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM inboxes WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("aggregates real (inbox) LLM tokens for the tenant only (RLS-fenced)", async () => {
    const m = await getInstanceMetrics(
      ctx(tenantA),
      { source: "inbox" },
      appDb,
    );
    expect(m.llm.calls).toBe(2);
    expect(m.llm.promptTokens).toBe(150);
    expect(m.llm.completionTokens).toBe(50);
    // Cached read is a subset of promptTokens (sum across the two real rows).
    expect(m.llm.cachedReadTokens).toBe(80);
    expect(m.llm.cacheCreationTokens).toBe(10);
    // B's usage must not leak in.
    expect(m.llm.byAgent).toHaveLength(1);
    expect(m.llm.byAgent[0]?.agentId).toBe(String(agent1));
    expect(m.llm.byAgent[0]?.calls).toBe(2);
  });

  test("segments by inbox, model, and source (playground excluded from inbox view)", async () => {
    const inboxView = await getInstanceMetrics(
      ctx(tenantA),
      { source: "inbox" },
      appDb,
    );
    // byInbox resolves the inbox name and sums only its rows.
    expect(inboxView.llm.byInbox).toHaveLength(1);
    expect(inboxView.llm.byInbox[0]?.inboxId).toBe(String(inboxA));
    expect(inboxView.llm.byInbox[0]?.name).toBe("WhatsApp");
    expect(inboxView.llm.byInbox[0]?.calls).toBe(2);
    // byModel splits the two real models.
    const models = inboxView.llm.byModel.map((m) => m.model).sort();
    expect(models).toEqual(["gpt-4o", "gpt-4o-mini"]);

    // The playground segment is isolated.
    const pg = await getInstanceMetrics(
      ctx(tenantA),
      { source: "playground" },
      appDb,
    );
    expect(pg.llm.calls).toBe(1);
    expect(pg.llm.promptTokens).toBe(7);
    // Playground rows carry no inbox attribution.
    expect(pg.llm.byInbox).toHaveLength(0);

    // bySource is always the full split, regardless of the filter.
    const sources = Object.fromEntries(
      inboxView.llm.bySource.map((s) => [s.source, s.calls]),
    );
    expect(sources.inbox).toBe(2);
    expect(sources.playground).toBe(1);
  });

  test("aggregates conversation counts by status", async () => {
    const m = await getInstanceMetrics(ctx(tenantA), {}, appDb);
    expect(m.conversations.total).toBe(3);
    const open = m.conversations.byStatus.find((s) => s.status === "open");
    const pending = m.conversations.byStatus.find(
      (s) => s.status === "pending",
    );
    expect(open?.count).toBe(2);
    expect(pending?.count).toBe(1);
  });

  test("the `since` filter excludes older usage", async () => {
    const future = new Date(Date.now() + 60_000);
    const m = await getInstanceMetrics(ctx(tenantA), { since: future }, appDb);
    expect(m.llm.calls).toBe(0);
  });
});
