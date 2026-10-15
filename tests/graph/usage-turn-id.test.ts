import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { defaultUsagePersist, type UsageRow } from "@/graph/usage";
import { dbProbeFailed } from "@/tests/db-gate";

// A subscriber that bills per turn joins each `llm.usage` event to the turn that paid for it by the
// turn id the ledger row and the execution log already carry, instead of by timestamp.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantId = 0n;

const row = (turnId: string | null, node: string): UsageRow => ({
  tenantId,
  agentId: null,
  conversationId: null,
  inboxId: null,
  threadId: null,
  turnId,
  model: "gpt-5.4-mini",
  node,
  source: "inbox",
  promptTokens: 10,
  completionTokens: 5,
  cachedReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  durationMs: null,
  costUsd: 0.001,
  priceTable: "litellm@test",
});

const usageEvents = async () =>
  (
    await suDb.outboundWebhookDelivery.findMany({
      where: { tenantId, event: "llm.usage" },
      orderBy: { id: "asc" },
      select: { payload: true },
    })
  ).map((d) => (d.payload as { data: Record<string, unknown> }).data);

describe.skipIf(!dbUp)("the llm.usage event names its turn", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "UT-1422", slug: `ut-1422-${process.pid}` },
      })
    ).id;
    await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: "https://example.com/hook",
        events: ["llm.usage"],
      },
    });
  });

  beforeEach(async () => {
    await suDb.outboundWebhookDelivery.deleteMany({ where: { tenantId } });
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    if (!su) return;
    await suDb.outboundWebhookDelivery.deleteMany({ where: { tenantId } });
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
    await suDb.webhookSubscription.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await su.$disconnect();
    await app?.$disconnect();
  });

  test("every call of a turn carries the ledger's turn id, the speech rewrite included", async () => {
    const persist = defaultUsagePersist(appDb);
    await persist(row("turn-1422-a", "agent"));
    await persist(row("turn-1422-a", "tts_normalize"));
    await persist(row("turn-1422-b", "agent"));

    const events = await usageEvents();
    expect(events.map((e) => [e.node, e.turn_id])).toEqual([
      ["agent", "turn-1422-a"],
      ["tts_normalize", "turn-1422-a"],
      ["agent", "turn-1422-b"],
    ]);
    const ledger = await suDb.llmUsage.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
      select: { turnId: true },
    });
    expect(events.map((e) => e.turn_id)).toEqual(ledger.map((l) => l.turnId));
  });

  test("a call outside any turn says so with null rather than leaving the key out", async () => {
    await defaultUsagePersist(appDb)(row(null, "memory_compact"));
    const [event] = await usageEvents();
    expect(event).toHaveProperty("turn_id", null);
  });
});
