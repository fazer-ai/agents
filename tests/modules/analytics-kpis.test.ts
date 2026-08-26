import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getKpis } from "@/modules/analytics/service";
import { recordResolutionOrigin } from "@/modules/conversations/record-resolution";
import type { ResolutionOrigin } from "@/modules/conversations/resolution-origin";
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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Every conversation below is one the bot ran on (it has inbox LlmUsage), which is what "involved"
// means. They differ ONLY in how they were closed, so each assertion is about that and nothing else.
async function seedClosedConversation(p: {
  convId: number;
  status: string;
  assigneeType?: string | null;
  origin?: ResolutionOrigin;
}): Promise<void> {
  const conv = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: p.convId,
      // Created OPEN even for the resolved cases, then closed below. The recorder refuses to stamp a
      // row that already reads resolved (a resolve on a resolved conversation is a no-op in Chatwoot
      // and does not change who closed it), so seeding straight to resolved would exercise an
      // ordering production never produces.
      status: "open",
      assigneeType: p.assigneeType ?? null,
      threadId: `${tenantId}:${instanceId}:${p.convId}`,
      lastEventAt: new Date(),
    },
  });
  await suDb.llmUsage.create({
    data: {
      tenantId,
      inboxId: inboxDbId,
      conversationId: conv.id,
      source: "inbox",
      model: "gpt-4o-mini",
      promptTokens: 10,
      completionTokens: 5,
    },
  });
  if (p.origin) {
    // The real writer, not a literal: a stamp the pipeline could never produce would make the
    // assertions below agree with themselves and with nothing else.
    await recordResolutionOrigin({
      tenantId,
      conversation: { id: conv.id },
      origin: p.origin,
      observed: { status: "open", statusAt: null },
      base: appDb,
    });
  }
  if (p.status !== "open") {
    await suDb.conversation.update({
      where: { id: conv.id },
      data: { status: p.status },
    });
  }
}

// A conversation a human owned start to finish, on which the customer sent an image. Vision runs on
// the incoming attachment BEFORE the bot-ownership gate, so the tenant was billed and the row exists
// — but the agent never took the turn. Seeded with the node the real writer sets.
async function seedVisionOnlyConversation(convId: number): Promise<void> {
  const conv = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      status: "open",
      assigneeType: "User",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
  await suDb.llmUsage.create({
    data: {
      tenantId,
      inboxId: inboxDbId,
      conversationId: conv.id,
      source: "inbox",
      model: "gpt-4o-mini",
      node: "vision",
      promptTokens: 273,
      completionTokens: 1,
    },
  });
}

describe.skipIf(!dbUp)("getKpis: what counts as a resolution", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "KPI", slug: `kpi-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 3,
      baseUrl: "https://cw.example",
      adminToken: "enc",
    });
    instanceId = inst.id;
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 4,
        name: "Suporte",
      },
    });
    inboxDbId = inbox.id;

    await seedClosedConversation({
      convId: 1,
      status: "resolved",
      origin: "agent",
    });
    await seedClosedConversation({
      convId: 2,
      status: "resolved",
      origin: "followup_abandonment",
    });
    await seedClosedConversation({
      convId: 3,
      status: "resolved",
      origin: "redirect_closing",
    });
    await seedClosedConversation({
      convId: 4,
      status: "resolved",
      origin: "console",
    });
    // Nothing recorded: Chatwoot's own auto_resolve_after, an automation rule, or an operator
    // resolving in the Chatwoot UI. None of them reach our code.
    await seedClosedConversation({ convId: 5, status: "resolved" });
    await seedClosedConversation({
      convId: 6,
      status: "resolved",
      origin: "legacy_unknown",
    });
    await seedClosedConversation({
      convId: 7,
      status: "resolved",
      assigneeType: "User",
    });
    await seedClosedConversation({ convId: 8, status: "open" });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "llm_usage",
        "conversations",
        "inboxes",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // Issue #188: six of the eight conversations above are resolved with no human assignee, which is
  // the predicate the funnel used to read as "the AI resolved it". Only one of them is.
  test("only the agent's own close counts as a resolution", async () => {
    const kpis = await getKpis(ctx(), {}, appDb);
    expect(kpis.involved).toBe(8);
    expect(kpis.resolvedByBot).toBe(1);
  });

  test("a lead the follow-up ladder closed does not raise the funnel", async () => {
    const before = await getKpis(ctx(), {}, appDb);
    await seedClosedConversation({
      convId: 20,
      status: "resolved",
      origin: "followup_abandonment",
    });
    const after = await getKpis(ctx(), {}, appDb);
    // The whole defect in one assertion: one more conversation the agent failed to engage, and the
    // resolution count must not move. It used to.
    expect(after.resolvedByBot).toBe(before.resolvedByBot);
    expect(after.involved).toBe(before.involved + 1);
    expect(after.resolutionRate).toBeLessThan(before.resolutionRate);
  });

  test("rows resolved before the origin was recorded are reported, not counted", async () => {
    const kpis = await getKpis(ctx(), {}, appDb);
    expect(kpis.resolvedBeforeTracking).toBe(1);
    expect(kpis.resolvedByBot).toBe(1);
  });

  test("a human takeover is still a handoff", async () => {
    const kpis = await getKpis(ctx(), {}, appDb);
    expect(kpis.handoff).toBe(1);
  });

  // Issue #316 completed the ledger, and completing it broke the proxy this KPI rested on: every
  // billed call used to be an agent turn, because the calls that were not had no row. A vision-only
  // conversation is the first one that is billed and never answered.
  test("a call billed before the bot gate is not involvement", async () => {
    const before = await getKpis(ctx(), {}, appDb);
    await seedVisionOnlyConversation(30);
    const after = await getKpis(ctx(), {}, appDb);
    expect(after.involved).toBe(before.involved);
    // The conversation is real and still counts in the denominator, so the rate must FALL: the
    // funnel saw a customer it never engaged.
    expect(after.totalConversations).toBe(before.totalConversations + 1);
    expect(after.involvementRate).toBeLessThan(before.involvementRate);
    // And the resolution rate, whose denominator is `involved`, must not move at all.
    expect(after.resolutionRate).toBe(before.resolutionRate);
  });

  test("a legacy row with no node still counts as the agent turn it was", async () => {
    // The eight conversations seeded above all carry `node: null`, which is what every row written
    // before this column had a default looks like. `notIn` alone drops them (SQL NOT IN with NULL),
    // so this is the assertion that catches the filter tightening past its own rule.
    const kpis = await getKpis(ctx(), {}, appDb);
    expect(kpis.involved).toBeGreaterThanOrEqual(8);
  });

  test("the rates derive from the recorded resolutions", async () => {
    const kpis = await getKpis(ctx(), {}, appDb);
    expect(kpis.resolutionRate).toBeCloseTo(
      kpis.resolvedByBot / kpis.involved,
      10,
    );
    expect(kpis.automationRate).toBeCloseTo(
      kpis.resolvedByBot / kpis.totalConversations,
      10,
    );
  });
});
