import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { listConversations } from "@/modules/conversations/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #607: the Conversations list narrowed to one agent. "One agent's conversations" means the
// ones on inboxes BOUND to it; an inbox it only observes is somebody else's conversation to answer.

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

// The MCP tool reads through the app's default client, which in the suite points at no database, so
// the call over a real MCP client needs it to be this file's. Restored as a fresh literal holding the
// original, the only form that puts it back (see mcp-oauth-consent-seam.test.ts and the fence in
// module-mock-undo.test.ts); top-level so a skipped describe cannot leave it installed.
const originalPrisma = (await import("@/api/lib/prisma")).default;
mock.module("@/api/lib/prisma", () => ({ default: app }));
afterAll(() => {
  mock.module("@/api/lib/prisma", () => ({ default: originalPrisma }));
});

let tenantA = 0n;
let tenantB = 0n;
// A: `sales` answers inbox 1 and observes inbox 2; `support` answers inbox 2. Inbox 3 is unbound.
let sales = 0n;
let support = 0n;
// B's own agent, bound to B's inbox: an id that exists, in another tenant.
let foreign = 0n;

const ctx = (t: bigint): TenantContext => ({
  tenantId: t,
  userId: null,
  role: "TENANT_ADMIN",
});

const ids = (items: { chatwootConversationId: number }[]) =>
  items.map((c) => c.chatwootConversationId).sort((a, b) => a - b);

async function agent(tenantId: bigint, name: string) {
  return (
    await suDb.agent.create({
      data: { tenantId, name, systemPrompt: "x" },
    })
  ).id;
}

describe.skipIf(!dbUp)("conversations filtered by agent", () => {
  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "Conv607A", slug: `conv-607-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "Conv607B", slug: `conv-607-b-${process.pid}` },
      })
    ).id;
    sales = await agent(tenantA, "Sales");
    support = await agent(tenantA, "Support");
    foreign = await agent(tenantB, "Foreign");

    const instA = (
      await seedChatwootInstance(suDb, {
        tenantId: tenantA,
        accountId: 60701,
        baseUrl: "https://cw.example",
        adminToken: "enc",
      })
    ).id;
    const instB = (
      await seedChatwootInstance(suDb, {
        tenantId: tenantB,
        accountId: 60702,
        baseUrl: "https://cw.example",
        adminToken: "enc",
      })
    ).id;
    const inbox = async (
      tenantId: bigint,
      inst: bigint,
      n: number,
      agentId: bigint | null,
    ) =>
      (
        await suDb.inbox.create({
          data: {
            tenantId,
            chatwootInstanceId: inst,
            chatwootInboxId: n,
            name: `Inbox ${n}`,
            agentId,
          },
        })
      ).id;
    const i1 = await inbox(tenantA, instA, 1, sales);
    const i2 = await inbox(tenantA, instA, 2, support);
    const i3 = await inbox(tenantA, instA, 3, null);
    const iB = await inbox(tenantB, instB, 9, foreign);
    await suDb.inboxObserver.create({
      data: { tenantId: tenantA, inboxId: i2, agentId: sales },
    });
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instA,
        tenantId: tenantA,
        chatwootContactId: 5,
        name: "Alice",
      },
    });

    // Conversation ids name their inbox (1xx on inbox 1, ...) so a failure reads at a glance.
    const conv = async (
      tenantId: bigint,
      inst: bigint,
      inboxId: bigint,
      n: number,
      status: string,
      hour: number,
    ) =>
      suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: inst,
          chatwootConversationId: n,
          inboxId,
          contactId: tenantId === tenantA ? contact.id : null,
          status,
          threadId: `${tenantId}:${inst}:${n}`,
          lastEventAt: new Date(Date.UTC(2026, 8, 1, hour)),
        },
      });
    await conv(tenantA, instA, i1, 101, "pending", 1);
    await conv(tenantA, instA, i1, 102, "open", 2);
    await conv(tenantA, instA, i1, 103, "pending", 3);
    await conv(tenantA, instA, i2, 201, "pending", 4);
    await conv(tenantA, instA, i3, 301, "pending", 5);
    await conv(tenantB, instB, iB, 901, "pending", 6);
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      for (const tbl of [
        "conversations",
        "inbox_observers",
        "inboxes",
        "contacts",
        "chatwoot_instances",
        "agents",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("returns only the conversations on inboxes bound to the agent", async () => {
    const page = await listConversations(
      ctx(tenantA),
      { agentId: sales },
      appDb,
    );
    expect(ids(page.items)).toEqual([101, 102, 103]);
  });

  test("an inbox the agent only observes is not its conversation", async () => {
    const page = await listConversations(
      ctx(tenantA),
      { agentId: support },
      appDb,
    );
    // 201 is on inbox 2, which `sales` observes and `support` answers: it is support's alone.
    expect(ids(page.items)).toEqual([201]);
  });

  test("without the filter every conversation is still listed", async () => {
    const page = await listConversations(ctx(tenantA), {}, appDb);
    expect(ids(page.items)).toEqual([101, 102, 103, 201, 301]);
  });

  test("another tenant's agent id is an empty page, not that tenant's rows", async () => {
    const page = await listConversations(
      ctx(tenantA),
      { agentId: foreign },
      appDb,
    );
    expect(page.items).toEqual([]);
    const none = await listConversations(
      ctx(tenantA),
      { agentId: 999_999_999n },
      appDb,
    );
    expect(none.items).toEqual([]);
  });

  test("composes with status and free-text search instead of replacing them", async () => {
    const pending = await listConversations(
      ctx(tenantA),
      { agentId: sales, status: "pending" },
      appDb,
    );
    expect(ids(pending.items)).toEqual([101, 103]);
    const searched = await listConversations(
      ctx(tenantA),
      { agentId: sales, q: "102" },
      appDb,
    );
    expect(ids(searched.items)).toEqual([102]);
  });

  test("pages with the keyset cursor under the filter", async () => {
    const seen: number[] = [];
    let cursor: bigint | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await listConversations(
        ctx(tenantA),
        { agentId: sales, limit: 1, cursor },
        appDb,
      );
      seen.push(...page.items.map((c) => c.chatwootConversationId));
      if (!page.nextCursor) break;
      cursor = BigInt(page.nextCursor);
    }
    expect(seen).toEqual([103, 102, 101]);
  });

  // Over a real MCP client: the tool is registered with the argument, and a call reaches the filter.
  test("the MCP conversations tool takes agent_id and refuses a malformed one", async () => {
    const principal: VerifiedToken = {
      userId: 1n,
      tenantId: tenantA,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      clientId: "c",
      jti: "j",
    };
    const server = buildMcpServer(principal);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "conv-607", version: "0" });
    await client.connect(clientT);
    try {
      const tools = (await client.listTools()).tools;
      const listTool = tools.find(
        (t) => t.description?.startsWith("List recent conversations") ?? false,
      );
      expect(listTool).toBeDefined();
      const schema = listTool?.inputSchema as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(Object.keys(schema?.properties ?? {})).toContain("agent_id");
      const name = listTool?.name ?? "";
      const called = (await client.callTool({
        name,
        arguments: { agent_id: String(support) },
      })) as { content: { text: string }[] };
      const list = JSON.parse(called.content[0]?.text ?? "{}") as {
        items: { chatwootConversationId: number }[];
      };
      expect(ids(list.items)).toEqual([201]);
      const bad = (await client.callTool({
        name,
        arguments: { agent_id: " 17 " },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(bad.isError).toBe(true);
      // The parser's own refusal, not a database error that happens to quote the same words.
      expect(JSON.parse(bad.content[0]?.text ?? "{}")).toEqual({
        ok: false,
        error: "invalid agent_id",
      });
    } finally {
      await client.close();
    }
  });
});
