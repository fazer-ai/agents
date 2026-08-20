import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runRedirectGate } from "@/modules/channel-redirect/gate";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// The redirect gate stamps `redirectSentAt` and spends one of `maxResends` the moment it believes the
// link went out — and that belief came from a `send` that could not report otherwise. Since the
// webhook's public post can now decline to send (the conversation stopped being the bot's mid-flight),
// a stamp on an undelivered link costs the lead the link entirely: the one-shot rule suppresses every
// later attempt, permanently when maxResends is 0. These pin the stamp to the delivery, not to the
// attempt.

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

// TEST-NET-3 on a closed port: passes the SSRF check without a DNS lookup, and nothing can reach it
// even if a call escaped the double.
const BASE_URL = "https://203.0.113.22:9";
const WIDGET_INBOX = 555;
const ENTRY_INBOX = 556;

let tenantId: bigint;
let instanceId: bigint;
let realFetch: typeof globalThis.fetch;

function installChatwootDouble(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/redirect_tokens") && init?.method === "POST") {
      return json({
        token: "tok-123",
        website_url: "https://chat.example.com",
      });
    }
    return json({});
  }) as typeof globalThis.fetch;
}

const cfg = readChannelRedirectConfig({
  channelRedirect: {
    enabled: true,
    entryInboxId: ENTRY_INBOX,
    widgetInboxId: WIDGET_INBOX,
    redirectMessage: "Fale com a gente por aqui: {link}",
    maxResends: 0,
  },
});

async function seedConversation(
  chatwootConversationId: number,
): Promise<{ id: bigint; contactId: bigint }> {
  const contact = await suDb.contact.create({
    data: {
      tenantId,
      chatwootContactId: 4000 + chatwootConversationId,
      name: "Lead",
    },
    select: { id: true },
  });
  const inbox = await suDb.inbox.upsert({
    where: {
      tenantId_chatwootInstanceId_chatwootInboxId: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: ENTRY_INBOX,
      },
    },
    create: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootInboxId: ENTRY_INBOX,
      name: "WhatsApp",
    },
    update: {},
    select: { id: true },
  });
  const conv = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inbox.id,
      contactId: contact.id,
      chatwootConversationId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${chatwootConversationId}`,
    },
    select: { id: true },
  });
  return { id: conv.id, contactId: contact.id };
}

describe.skipIf(!dbUp)("runRedirectGate delivery accounting", () => {
  beforeAll(async () => {
    installChatwootDouble();
    const t = await suDb.tenant.create({
      data: { name: "REDIR", slug: `redir-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 12,
      baseUrl: BASE_URL,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    if (realFetch) globalThis.fetch = realFetch;
    if (dbUp) {
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
      await suDb.$disconnect();
      await appDb.$disconnect();
    }
  });

  test("a link that was not delivered does not spend the resend budget", async () => {
    const conv = await seedConversation(7301);
    const outcome = await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7301,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async () => false,
    });

    expect(outcome).toBe("withheld");
    const row = await suDb.conversation.findUnique({
      where: { id: conv.id },
      select: { redirectSentAt: true, redirectCount: true },
    });
    // Untouched, so the lead is still owed the link: with maxResends at 0 a stamp here is permanent.
    expect(row?.redirectSentAt).toBeNull();
    expect(row?.redirectCount).toBe(0);
  });

  test("a delivered link is stamped and spends one", async () => {
    const conv = await seedConversation(7302);
    const sent: string[] = [];
    const outcome = await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7302,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async (text: string) => {
        sent.push(text);
        return true;
      },
    });

    expect(outcome).toBe("sent");
    expect(sent[0]).toContain("https://chat.example.com");
    const row = await suDb.conversation.findUnique({
      where: { id: conv.id },
      select: { redirectSentAt: true, redirectCount: true },
    });
    expect(row?.redirectSentAt).not.toBeNull();
    expect(row?.redirectCount).toBe(1);
  });
});
