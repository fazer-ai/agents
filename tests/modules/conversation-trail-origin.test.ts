import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getConversationDetail } from "@/modules/conversations/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog } from "../utils/flowlog";

// Issue #846: every proactive line that was not an appointment reminder came back as a "followup"
// marker, so an inbound integration's event and a channel-redirect follow-up were badged "Follow-up"
// on the conversation. The turn now records where it came from and which message it sent, and the
// trail hands both to the screen. A line written before that keeps the old inference.

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
let convId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

async function proactiveLine(detail: Prisma.InputJsonObject) {
  await suDb.executionLog.create({
    data: {
      tenantId,
      conversationId: convId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      stage: "generate",
      level: "info",
      status: "ok",
      detail,
    },
  });
}

async function trail() {
  const d = await getConversationDetail(ctx(), convId, appDb);
  return d.trail;
}

describe.skipIf(!dbUp)("where a proactive turn came from (issue #846)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ORIGIN846", slug: `origin846-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      adminToken: "enc",
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 10,
        name: "Support",
      },
    });
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: inst.id,
        tenantId,
        chatwootContactId: 5,
        name: "Alice",
      },
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootConversationId: 100,
        inboxId: inbox.id,
        contactId: contact.id,
        status: "pending",
        assigneeType: "AgentBot",
        threadId: `${tenantId}:${inst.id}:100`,
        lastEventAt: new Date("2026-09-20T10:00:00Z"),
      },
    });
    convId = conv.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.$executeRaw`DELETE FROM integration_instances WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM inboxes WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM chatwoot_instances WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a recorded origin is the kind, with the message it sent and the integration it names", async () => {
    await clearFlowLog(suDb, { tenantId });
    const inst = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "GENERIC",
        name: "ERP da loja",
        enabled: true,
        config: {},
        inboundAuthStrategy: "NONE",
      },
    });
    await proactiveLine({
      trigger: "GENERIC",
      outcome: "messaged",
      origin: "event",
      messageId: 501,
      integrationInstanceId: String(inst.id),
    });
    await proactiveLine({
      trigger: "followup",
      outcome: "messaged",
      step: 2,
      origin: "followup",
      messageId: 502,
    });
    await proactiveLine({
      trigger: "channel-redirect",
      outcome: "templated",
      origin: "redirect",
      messageId: 503,
    });
    await proactiveLine({
      trigger: "appointment_reminder",
      outcome: "messaged",
      origin: "reminder",
      messageId: 504,
    });
    // An event that only left a note: recorded, and no message to badge.
    await proactiveLine({
      trigger: "GENERIC",
      outcome: "noted",
      origin: "event",
      integrationInstanceId: String(inst.id),
    });
    const t = await trail();
    const got = t.map((e) => ({
      kind: e.kind,
      originRecorded: e.originRecorded,
      messageId: e.messageId,
      integrationName: e.integrationName,
      step: e.step,
    }));
    expect(got).toEqual([
      {
        kind: "event",
        originRecorded: true,
        messageId: 501,
        integrationName: "ERP da loja",
        step: null,
      },
      {
        kind: "followup",
        originRecorded: true,
        messageId: 502,
        integrationName: null,
        step: 2,
      },
      {
        kind: "redirect",
        originRecorded: true,
        messageId: 503,
        integrationName: null,
        step: null,
      },
      {
        kind: "reminder",
        originRecorded: true,
        messageId: 504,
        integrationName: null,
        step: null,
      },
      {
        kind: "event",
        originRecorded: true,
        messageId: null,
        integrationName: "ERP da loja",
        step: null,
      },
    ]);
  });

  test("an event whose integration is gone, or of another tenant, carries no name", async () => {
    await clearFlowLog(suDb, { tenantId });
    const other = await suDb.tenant.create({
      data: { name: "ORIGIN846B", slug: `origin846b-${process.pid}` },
    });
    try {
      const foreign = await suDb.integrationInstance.create({
        data: {
          tenantId: other.id,
          catalogType: "GENERIC",
          name: "Segredo de outro tenant",
          enabled: true,
          config: {},
          inboundAuthStrategy: "NONE",
        },
      });
      await proactiveLine({
        trigger: "GENERIC",
        outcome: "messaged",
        origin: "event",
        messageId: 601,
        integrationInstanceId: String(foreign.id),
      });
      await proactiveLine({
        trigger: "GENERIC",
        outcome: "messaged",
        origin: "event",
        messageId: 602,
        integrationInstanceId: "999999999",
      });
      const t = await trail();
      expect(t.map((e) => [e.kind, e.integrationName])).toEqual([
        ["event", null],
        ["event", null],
      ]);
    } finally {
      await suDb.$executeRaw`DELETE FROM integration_instances WHERE tenant_id = ${other.id}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${other.id}`;
    }
  });

  test("a line from before #846 keeps the old inference and is not treated as recorded", async () => {
    await clearFlowLog(suDb, { tenantId });
    await proactiveLine({ trigger: "GENERIC", outcome: "messaged" });
    await proactiveLine({
      trigger: "appointment_reminder",
      outcome: "messaged",
    });
    await proactiveLine({ trigger: "followup", outcome: "messaged", step: 1 });
    // A messageId without an origin is not trusted either: only a recorded line matches by id.
    // And an integration id on a line that is not an event names nothing, even a live one.
    const live = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "GENERIC",
        name: "Viva",
        enabled: true,
        config: {},
        inboundAuthStrategy: "NONE",
      },
    });
    await proactiveLine({
      trigger: "followup",
      outcome: "messaged",
      origin: "followup",
      messageId: 10,
      integrationInstanceId: String(live.id),
    });
    await proactiveLine({
      trigger: "followup",
      outcome: "messaged",
      messageId: 9,
    });
    const t = await trail();
    expect(
      t.map((e) => [e.kind, e.originRecorded, e.messageId, e.integrationName]),
    ).toEqual([
      ["followup", false, null, null],
      ["reminder", false, null, null],
      ["followup", false, null, null],
      ["followup", true, 10, null],
      ["followup", false, null, null],
    ]);
  });

  test("a tool marker carries none of the proactive fields", async () => {
    await clearFlowLog(suDb, { tenantId });
    await suDb.executionLog.create({
      data: {
        tenantId,
        conversationId: convId,
        turnId: "t-tool-846",
        source: "inbox",
        stage: "tool",
        level: "info",
        status: "ok",
        durationMs: 1,
        detail: { tool: "search_knowledge" },
      },
    });
    const [e] = await trail();
    expect(e?.kind).toBe("tool");
    expect(e?.originRecorded).toBeNull();
    expect(e?.messageId).toBeNull();
    expect(e?.integrationName).toBeNull();
  });
});
