import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  linkSearchFor,
  resolveChatwootConversation,
} from "@/modules/conversations/chatwoot-link";
import { seedChatwootInstance } from "@/tests/utils/chatwoot";

// A Chatwoot conversation (account, the number in Chatwoot's URL, optionally the inbox) resolves to
// this platform's conversation among the tenants the caller can open, and to nothing elsewhere.

const ctxFor = (tenantId: bigint, role: TenantContext["role"] = "AGENT") =>
  ({ tenantId, userId: 1n, role }) as TenantContext;

describe("the tenants a link searches", () => {
  const ctx = ctxFor(10n);
  const at = new Date();

  test("a person searches every membership, with the role held there", () => {
    const who = linkSearchFor(ctx, {
      memberships: [
        { tenantId: 10n, role: "AGENT", createdAt: at },
        { tenantId: 11n, role: "TENANT_ADMIN", createdAt: at },
      ],
    });
    expect(who).toEqual({
      scopes: [
        { ...ctx, tenantId: 10n, role: "AGENT" },
        { ...ctx, tenantId: 11n, role: "TENANT_ADMIN" },
      ],
    });
  });

  test("an API key searches only its own tenant, and a session with no list its request's", () => {
    expect(
      linkSearchFor(ctx, {
        isApiKey: true,
        memberships: [{ tenantId: 11n, role: "AGENT", createdAt: at }],
      }),
    ).toEqual({ scopes: [ctx] });
    expect(linkSearchFor(ctx, null)).toEqual({ scopes: [ctx] });
  });

  test("a SUPER_ADMIN searches the fleet", () => {
    expect(
      linkSearchFor(
        { tenantId: null, userId: 1n, role: "SUPER_ADMIN" } as TenantContext,
        { memberships: [] },
      ),
    ).toEqual({ fleet: true });
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let app: PrismaClient | undefined;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

// Unlikely enough to be any other suite's, and shared by both tenants: the ambiguity under test.
const ACCOUNT = 70_000 + (process.pid % 20_000);
const DISPLAY = 42;

describe.skipIf(!dbUp)("resolving a Chatwoot conversation", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let convA = "";
  let convB = "";
  let onlyB = "";
  const botA = createHash("sha256")
    .update(`link-bot-a-${process.pid}`)
    .digest("hex");
  const botB = createHash("sha256")
    .update(`link-bot-b-${process.pid}`)
    .digest("hex");
  const INBOX_A = 501;
  const INBOX_B = 502;

  async function seed(
    tenantId: bigint,
    baseUrl: string,
    inbox: number,
    botHash: string,
  ) {
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: ACCOUNT,
      baseUrl,
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Link",
        systemPrompt: "-",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        agentId: agent.id,
        chatwootAgentBotId: inbox,
        accessToken: "-",
        webhookSecret: "-",
        webhookRouteTokenHash: botHash,
        name: "Link",
      },
    });
    const ib = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: inbox,
        name: `inbox ${inbox}`,
      },
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        inboxId: ib.id,
        chatwootConversationId: DISPLAY,
        threadId: `${tenantId}:${inst.id}:${DISPLAY}`,
        status: "open",
      },
    });
    // A neighbour under the same account and number but another inbox would be a second Chatwoot
    // conversation in the same tenant; it cannot exist, so the neighbour differs by number.
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        inboxId: ib.id,
        chatwootConversationId: DISPLAY + 1,
        threadId: `${tenantId}:${inst.id}:${DISPLAY + 1}`,
        status: "open",
      },
    });
    return { conv: String(conv.id), inst, inbox: ib };
  }

  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "Link A", slug: `link-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "Link B", slug: `link-b-${process.pid}` },
      })
    ).id;
    convA = (await seed(tenantA, "https://chat-a.test.local", INBOX_A, botA))
      .conv;
    const b = await seed(tenantB, "https://chat-b.test.local", INBOX_B, botB);
    convB = b.conv;
    // Recorded on B's server only: the same numbers on A's server name a conversation this platform
    // never heard of.
    onlyB = String(
      (
        await suDb.conversation.create({
          data: {
            tenantId: tenantB,
            chatwootInstanceId: b.inst.id,
            inboxId: b.inbox.id,
            chatwootConversationId: DISPLAY + 2,
            threadId: `${tenantB}:${b.inst.id}:${DISPLAY + 2}`,
            status: "open",
          },
        })
      ).id,
    );
  });

  afterAll(async () => {
    for (const id of [tenantA, tenantB]) {
      if (id) await suDb.tenant.delete({ where: { id } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  const scopes = (...ids: bigint[]) => ({
    scopes: ids.map((id) => ctxFor(id)),
  });

  test("a member of the tenant gets that conversation, with its tenant", async () => {
    expect(
      await resolveChatwootConversation(
        scopes(tenantA),
        { accountId: ACCOUNT, conversationId: DISPLAY },
        appDb,
      ),
    ).toEqual([{ id: convA, tenantId: String(tenantA) }]);
  });

  test("a tenant the caller does not belong to is not searched", async () => {
    expect(
      await resolveChatwootConversation(
        scopes(tenantB),
        { accountId: ACCOUNT, conversationId: DISPLAY, inboxId: INBOX_A },
        appDb,
      ),
    ).toEqual([]);
  });

  test("an account id two tenants share returns both, and the inbox tells them apart", async () => {
    const both = await resolveChatwootConversation(
      scopes(tenantA, tenantB),
      { accountId: ACCOUNT, conversationId: DISPLAY },
      appDb,
    );
    expect(both.map((m) => m.id).sort()).toEqual([convA, convB].sort());
    expect(
      await resolveChatwootConversation(
        scopes(tenantA, tenantB),
        { accountId: ACCOUNT, conversationId: DISPLAY, inboxId: INBOX_B },
        appDb,
      ),
    ).toEqual([{ id: convB, tenantId: String(tenantB) }]);
  });

  test("a number, account or inbox nothing matches gives nothing", async () => {
    for (const ref of [
      { accountId: ACCOUNT, conversationId: DISPLAY + 100 },
      { accountId: ACCOUNT + 1, conversationId: DISPLAY },
      { accountId: ACCOUNT, conversationId: DISPLAY, inboxId: 9999 },
    ]) {
      expect(
        await resolveChatwootConversation(scopes(tenantA, tenantB), ref, appDb),
      ).toEqual([]);
    }
  });

  test("the bot names the server: a number only the other server recorded is not found", async () => {
    const at = { accountId: ACCOUNT, conversationId: DISPLAY + 2 };
    expect(
      await resolveChatwootConversation(scopes(tenantA, tenantB), at, appDb),
    ).toEqual([{ id: onlyB, tenantId: String(tenantB) }]);
    expect(
      await resolveChatwootConversation(
        scopes(tenantA, tenantB),
        { ...at, botHash: botA },
        appDb,
      ),
    ).toEqual([]);
    expect(
      await resolveChatwootConversation(
        scopes(tenantA, tenantB),
        { accountId: ACCOUNT, conversationId: DISPLAY, botHash: botB },
        appDb,
      ),
    ).toEqual([{ id: convB, tenantId: String(tenantB) }]);
  });

  test("the fleet sees every tenant", async () => {
    const all = await resolveChatwootConversation(
      { fleet: true },
      { accountId: ACCOUNT, conversationId: DISPLAY },
      appDb,
    );
    expect(all.map((m) => m.id).sort()).toEqual([convA, convB].sort());
  });
});
