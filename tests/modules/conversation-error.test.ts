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

function noteRecorder(opts: { fail?: boolean } = {}) {
  const notes: Array<[number, string]> = [];
  const client = {
    sendPrivateNote: async (conversationId: number, content: string) => {
      if (opts.fail) throw new Error("chatwoot is down");
      notes.push([conversationId, content]);
      return {};
    },
  } as unknown as ChatwootClient;
  return { notes, makeClient: async () => client };
}

async function seedConversation(convId: number): Promise<void> {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
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
    await seedConversation(400);
    await seedConversation(401);
    await seedConversation(402);
  });

  afterAll(async () => {
    for (const table of ["conversations", "chatwoot_instances"]) {
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
