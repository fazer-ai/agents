import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { deliverRedirectClosing } from "@/modules/channel-redirect/followup";
import type { ChatwootClient } from "@/modules/chatwoot/client";
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

const WIDGET_CONV = 501;
let tenantId = 0n;
let instanceId = 0n;

function stubClient() {
  const statuses: Array<[number, string]> = [];
  const client = {
    sendMessage: async () => ({}),
    toggleStatus: async (c: number, s: string) => {
      statuses.push([c, s]);
      return {};
    },
  } as unknown as ChatwootClient;
  return { statuses, makeClient: async () => client };
}

// The redirect ladder's closing stage resolves the conversation the episode moved AWAY from. That is
// housekeeping, not an outcome the agent decided, and before the origin was recorded it landed in
// the dashboard's Resolution funnel exactly like a real resolution.
describe.skipIf(!dbUp)("the redirect closing records its own origin", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "REDIR", slug: `redir-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 31,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 41,
        name: "Site",
        agentId: agent.id,
        channelType: "Channel::WebWidget",
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        chatwootConversationId: WIDGET_CONV,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${WIDGET_CONV}`,
        lastInboundAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the widget conversation it closes is not credited to the agent", async () => {
    const s = stubClient();
    const outcome = await deliverRedirectClosing({
      tenantId,
      instanceId,
      widgetConversationId: WIDGET_CONV,
      // No sibling seeded: the entry inbox has no conversation, so only the widget is closed, which
      // is the half this test is about.
      entryInboxId: 99,
      closingMessage: "Até logo!",
      closeChat: true,
      base: appDb,
      deps: { makeClient: s.makeClient },
    });
    expect(outcome).toBe("delivered");
    expect(s.statuses).toEqual([[WIDGET_CONV, "resolved"]]);
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      select: { resolvedBy: true },
    });
    expect(row.resolvedBy).toBe("redirect_closing");
  });

  // The OTHER conversation the closing stage touches: the WhatsApp sibling on the entry inbox. It
  // takes the same path and needs the same two halves recorded, and the floor is the one the
  // sibling lookup read — the version this close was decided against, not the row's at write time.
  test("the WhatsApp sibling it closes records the same origin, with its floor", async () => {
    const SIBLING_CONV = 8802;
    const SIBLING_AT = 1_700_300_000.25;
    // Its own widget row: the one above is already resolved by the previous test, and the closing
    // stage answers "already-closed" before it reaches the sibling.
    const WIDGET_CONV_2 = 502;
    const contact = await suDb.contact.create({
      // Scoped by instance: a Chatwoot contact id is unique inside one account.
      data: { tenantId, chatwootInstanceId: instanceId, chatwootContactId: 77 },
    });
    const widgetInbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: 41 },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: widgetInbox.id,
        contactId: contact.id,
        chatwootConversationId: WIDGET_CONV_2,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${WIDGET_CONV_2}`,
        lastInboundAt: new Date(),
      },
    });
    const waInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 42,
        name: "WhatsApp",
        channelType: "Channel::Whatsapp",
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: waInbox.id,
        contactId: contact.id,
        chatwootConversationId: SIBLING_CONV,
        status: "open",
        chatwootStatusAt: SIBLING_AT,
        threadId: `${tenantId}:${instanceId}:${SIBLING_CONV}`,
        lastInboundAt: new Date(),
      },
    });
    const s = stubClient();
    const outcome = await deliverRedirectClosing({
      tenantId,
      instanceId,
      widgetConversationId: WIDGET_CONV_2,
      entryInboxId: 42,
      closingMessage: "Até logo!",
      closeChat: false,
      base: appDb,
      deps: { makeClient: s.makeClient },
    });
    expect(outcome).toBe("delivered");
    expect(s.statuses).toEqual([[SIBLING_CONV, "resolved"]]);
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: SIBLING_CONV },
      select: { resolvedBy: true, resolvedByAt: true },
    });
    expect(row.resolvedBy).toBe("redirect_closing");
    expect(row.resolvedByAt).toBe(SIBLING_AT);
  });
});
