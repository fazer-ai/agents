import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { clearMediaAnnotations } from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { reengageConversation } from "@/modules/conversations/reengage";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// The re-engage transcribes the voice notes nobody transcribed. The arrival pass only runs when the
// agent will answer, so a note that came in while a person held the conversation has no words, and
// without this the model tells the customer it could not hear an audio that is fine.
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

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentId = 0n;
let llmKeyId = 0n;

const REPLY = "Anotado, já vou verificar.";
const UNHEARD = "não audível";

class TurnCapturingModel extends BaseChatModel {
  humanTexts: string[] = [];
  constructor(private readonly reply: string) {
    super({});
  }
  _llmType() {
    return "fake-turn-capture";
  }
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    for (const m of messages) {
      if (m.getType() === "human" && typeof m.content === "string")
        this.humanTexts.push(m.content);
    }
    return {
      generations: [{ text: this.reply, message: new AIMessage(this.reply) }],
    };
  }
}

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function voice(id: number, attachmentId: number, transcribed?: string) {
  return {
    id,
    content: "",
    message_type: 0,
    private: false,
    attachments: [
      {
        id: attachmentId,
        file_type: "audio",
        data_url: `https://chat.example.com/a/${attachmentId}.ogg`,
        ...(transcribed ? { meta: { transcribed_text: transcribed } } : {}),
      },
    ],
  };
}

// Every attachment URL the stub client was asked to download, in order, so a test can tell which
// voice note was transcribed: the provider stub answers the same text for any of them.
const downloaded: string[] = [];

function makeStub(payload: unknown[]) {
  const client = {
    getMessages: async () => ({ payload }),
    sendMessage: async () => ({}),
    toggleTyping: async () => ({}),
    updateAttachmentMeta: async () => ({}),
    downloadAttachment: async (url: string) => {
      downloaded.push(url);
      return {
        bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
        contentType: "audio/ogg",
      };
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

function stt(text: string) {
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    calls.n++;
    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function setStt(enabled: boolean) {
  // Off is the switch, with the provider and credential still there: a missing credential would
  // skip the transcription for a different reason.
  await suDb.agent.update({
    where: { id: agentId },
    data: {
      settings: {
        stt: {
          enabled,
          provider: "openai",
          credentialRef: `vault:${llmKeyId}`,
        },
      },
    },
  });
}

async function seedConversation(
  convId: number,
  over: { contactInboxId?: number } = {},
): Promise<bigint> {
  const c = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      ...(over.contactInboxId !== undefined
        ? { contactInboxId: over.contactInboxId }
        : {}),
      status: "pending",
      inboxId: inboxDbId,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
  return c.id;
}

async function reengage(
  convDbId: bigint,
  payload: unknown[],
  fetchImpl: typeof fetch,
  extra: {
    ownershipRead?: () => Promise<
      { ours: true } | { ours: false; closed: null }
    >;
  } = {},
) {
  const model = new TurnCapturingModel(REPLY);
  const res = await reengageConversation(
    ctx(),
    convDbId,
    {
      makeModel: () => model,
      makeClient: makeStub(payload),
      checkpointer: new MemorySaver(),
      sttFetch: fetchImpl,
      ...extra,
    },
    appDb,
  );
  return { res, seen: model.humanTexts.join("\n"), model };
}

describe.skipIf(!dbUp)("reengage: the voice note nobody transcribed", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RA", slug: `ra-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    llmKeyId = llmKey.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {},
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `ra-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    inboxDbId = inbox.id;
  });

  beforeEach(() => {
    clearMediaAnnotations();
    downloaded.length = 0;
  });

  afterAll(async () => {
    clearMediaAnnotations();
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "audit_logs",
        "llm_usage",
        "conversations",
        "contacts",
        "inboxes",
        "agents",
        "vault_entries",
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

  test("a voice note nobody transcribed is transcribed and reaches the model in its words", async () => {
    await setStt(true);
    const id = await seedConversation(1240);
    const provider = stt("o pedido é o 4471");
    const { res, seen } = await reengage(
      id,
      [voice(1, 11)],
      provider.fetchImpl,
    );
    expect(res.outcome).toBe("posted");
    expect(provider.calls.n).toBe(1);
    expect(seen).toContain("o pedido é o 4471");
    expect(seen).not.toContain(UNHEARD);
  });

  test("a transcription already on the attachment is reused, not paid for again", async () => {
    await setStt(true);
    const id = await seedConversation(1241);
    const provider = stt("não deveria ser chamado");
    const { seen } = await reengage(
      id,
      [voice(1, 21, "já tinha sido ouvido"), voice(2, 22)],
      provider.fetchImpl,
    );
    expect(provider.calls.n).toBe(1);
    expect(seen).toContain("já tinha sido ouvido");
  });

  test("with STT off, nothing is transcribed and the note stays unheard", async () => {
    await setStt(false);
    const id = await seedConversation(1242);
    const provider = stt("não deveria ser chamado");
    const { seen } = await reengage(id, [voice(1, 31)], provider.fetchImpl);
    expect(provider.calls.n).toBe(0);
    expect(seen).toContain(UNHEARD);
  });

  test("a voice note the contact authorization refused is not transcribed", async () => {
    await setStt(true);
    const id = await seedConversation(1243);
    await suDb.conversation.update({
      where: { id },
      data: { mediaRefusedThroughMessageId: 1 },
    });
    const provider = stt("só a segunda");
    const { seen } = await reengage(
      id,
      [voice(1, 41), voice(2, 42)],
      provider.fetchImpl,
    );
    expect(provider.calls.n).toBe(1);
    expect(downloaded).toEqual(["https://chat.example.com/a/42.ogg"]);
    expect(seen).toContain("só a segunda");
  });

  test("a person who takes the conversation while a note is transcribed is not answered over", async () => {
    await setStt(true);
    const id = await seedConversation(1244, { contactInboxId: 78 });
    let taken = false;
    const provider = stt("pode cancelar");
    const slow = (async (...args: unknown[]) => {
      const r = await (
        provider.fetchImpl as (...a: unknown[]) => Promise<Response>
      )(...args);
      taken = true;
      return r;
    }) as unknown as typeof fetch;
    const { res, model } = await reengage(id, [voice(1, 51)], slow, {
      ownershipRead: async () =>
        taken
          ? ({ ours: false, closed: null } as const)
          : ({ ours: true } as const),
    });
    expect(provider.calls.n).toBe(1);
    expect(res.outcome).not.toBe("posted");
    expect(model.humanTexts).toEqual([]);
  });
});
