import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  postTurnFailureNote,
  recordConversationError,
} from "@/modules/conversations/error";
import { seedChatwootInstance } from "../utils/chatwoot";

// A turn that dies leaves the customer with no reply, and until now the only trace was a badge in
// our console plus a row in execution_logs — neither of which anyone has open while they work the
// inbox (issue #63). The failure is now announced where the team is, once per conversation per
// window so a provider outage cannot bury the inbox in notes.

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

// A Chatwoot that authenticates like the real one: `sendPrivateNote` posts through `sendMessage`,
// which sends the PERSONA BOT token, so a client built without one is rejected with 401 instead of
// quietly accepting the note. A stub that ignores the token green-lights a note production never
// posts.
function noteRecorder(opts: { fail?: boolean } = {}) {
  const notes: Array<[number, string]> = [];
  const makeClient = async (cfg: { botToken?: string }) => {
    const token = cfg.botToken ?? "";
    return {
      sendPrivateNote: async (conversationId: number, content: string) => {
        if (!token) throw new Error("401 Unauthorized: missing bot token");
        if (opts.fail) throw new Error("chatwoot is down");
        notes.push([conversationId, content]);
        return {};
      },
    } as unknown as ChatwootClient;
  };
  return {
    notes,
    makeClient: makeClient as unknown as Parameters<
      typeof postTurnFailureNote
    >[0]["makeClient"],
  };
}

async function seedConversation(
  convId: number,
  inboxId?: bigint,
): Promise<void> {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      inboxId: inboxId ?? null,
      status: "open",
      threadId: `t:${process.pid}:${convId}`,
    },
  });
}

describe.skipIf(!dbUp)("turn failure surfacing", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CE", slug: `ce-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 7,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    // The persona whose turn fails: the note is posted AS its Chatwoot Agent Bot, resolved through
    // the conversation's inbox.
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "CE Persona",
        systemPrompt: "x",
        mode: "production",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `ce-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 84,
        name: "Sup",
        agentId: agent.id,
      },
    });
    // An inbox with no persona bound: nothing to post as.
    const orphanInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 85,
        name: "Sem persona",
        agentId: null,
      },
    });
    await seedConversation(400, inbox.id);
    await seedConversation(401, inbox.id);
    await seedConversation(402, inbox.id);
    await seedConversation(403, orphanInbox.id);
    await seedConversation(404, inbox.id);
  });

  afterAll(async () => {
    for (const table of [
      "conversations",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "chatwoot_instances",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
      );
    }
    await suDb.$executeRawUnsafe(
      `DELETE FROM chatwoot_deployments WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the first failure is announced and stamps the conversation", async () => {
    const first = await recordConversationError({
      tenantId,
      instanceId,
      chatwootConversationId: 400,
      error: new Error("the model provider returned no completion"),
      base: appDb,
    });
    expect(first.announce).toBe(true);
    const row = await suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: 400 },
      select: { lastError: true, lastErrorAt: true },
    });
    expect(row?.lastError).toContain("no completion");
    expect(row?.lastErrorAt).not.toBeNull();
  });

  test("a second failure inside the window is NOT announced again", async () => {
    const again = await recordConversationError({
      tenantId,
      instanceId,
      chatwootConversationId: 400,
      error: new Error("still broken"),
      base: appDb,
    });
    expect(again.announce).toBe(false);
  });

  test("a failure after the window is announced again", async () => {
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: 401 },
      data: {
        lastError: "old",
        lastErrorAt: new Date(Date.now() - 31 * 60_000),
      },
    });
    const stale = await recordConversationError({
      tenantId,
      instanceId,
      chatwootConversationId: 401,
      error: new Error("broken again"),
      base: appDb,
    });
    expect(stale.announce).toBe(true);
  });

  test("the note tells the operator a human has to take over, and why", async () => {
    const chatwoot = noteRecorder();
    await postTurnFailureNote({
      tenantId,
      instanceId,
      chatwootConversationId: 402,
      error: new Error("the model provider returned no completion"),
      base: appDb,
      makeClient: chatwoot.makeClient,
    });
    expect(chatwoot.notes).toHaveLength(1);
    const [conversationId, content] = chatwoot.notes[0] as [number, string];
    expect(conversationId).toBe(402);
    expect(content).toContain("sem resposta");
    expect(content).toContain("humano");
    expect(content).toContain("no completion");
  });

  test("an inbox with no persona bound skips the note instead of failing", async () => {
    const chatwoot = noteRecorder();
    await expect(
      postTurnFailureNote({
        tenantId,
        instanceId,
        chatwootConversationId: 403,
        error: new Error("boom"),
        base: appDb,
        makeClient: chatwoot.makeClient,
      }),
    ).resolves.toBeUndefined();
    expect(chatwoot.notes).toHaveLength(0);
  });

  // Two deliveries for one conversation are processed concurrently whenever debounce is off, and a
  // read-then-write cooldown lets both read the pre-failure stamp and both announce. The second
  // client is what makes the interleaving real: on a single pool the two transactions can be handed
  // the same connection and serialize by accident, which hides the defect instead of proving it.
  test("two failures racing on one conversation announce exactly once", async () => {
    const other = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl as string }),
    });
    try {
      // Warm it: a cold client spends longer opening its connection than the first transaction takes
      // end to end, so the two would never overlap and the assertion would pass on any code at all.
      await other.$queryRaw`SELECT 1`;
      const results = await Promise.all(
        [appDb, other].map((db) =>
          recordConversationError({
            tenantId,
            instanceId,
            chatwootConversationId: 404,
            error: new Error("provider down"),
            base: db,
          }),
        ),
      );
      expect(results.filter((r) => r.announce)).toHaveLength(1);
    } finally {
      await other.$disconnect();
    }
  });

  test("a Chatwoot that refuses the note does not turn one failure into two", async () => {
    const chatwoot = noteRecorder({ fail: true });
    await expect(
      postTurnFailureNote({
        tenantId,
        instanceId,
        chatwootConversationId: 402,
        error: new Error("boom"),
        base: appDb,
        makeClient: chatwoot.makeClient,
      }),
    ).resolves.toBeUndefined();
  });
});
