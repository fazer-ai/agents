import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ResolvedModelConfig } from "@/graph/models";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";
import { UsageReportingModel } from "../utils/scripted-models";

// The speech normalizer is a BILLED model call on the audio path, and it used to leave no trace at
// all: no llm_usage row, no execution_logs line, only a logger.warn on failure. Turning it on by
// default without these two rows would be a fleet-wide cost increase nobody could see. Every test
// here goes through the real runAgentTurn and reads the rows the operator would read, plus the one
// thing no row records: the text the voice provider was actually handed.
//
// The last two tests are the feature's headline capability, end to end: the rewrite on a credential
// of its OWN, resolved from the vault by loadAgentConfig (the only place that resolution happens, and
// the only place a wrong field name would leave it silently unused), and that same credential when
// its entry does not exist, which must cost the rewrite and never the voice note.

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
let contactId = 0n;

// A word that exists ONLY in the reply, so its absence from the flow row is evidence about PII and
// not a coincidence of wording.
const MARKER = "xilofone";
const REPLY = `Claro, levo o ${MARKER} amanhã às 08:00`;
const NORMALIZED = `Claro, levo o ${MARKER} amanhã às oito horas`;

// A voice provider that records the text it was asked to speak: whether the synth input is the
// rewritten reply or the raw one is the observable effect of the whole feature, and no row carries it.
function audioFetch(spoken: string[] = []) {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
    if (typeof body.input === "string") spoken.push(body.input);
    return new Response(new ArrayBuffer(16), {
      status: 200,
      headers: { "content-type": "audio/ogg" },
    });
  }) as unknown as typeof fetch;
}

function makeStub(rec: { text: string[]; audio: string[] }) {
  const client = {
    sendMessage: async (_c: number, content: string) => {
      rec.text.push(content);
      return {};
    },
    sendAudioMessage: async (_c: number, _a: ArrayBuffer, fileName: string) => {
      rec.audio.push(fileName);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

const audioEvent = (convId: number, inboxId = 7): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId: convId,
  contactInboxId: null,
  inboxId,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  message: {
    id: 1,
    content: "",
    messageType: "incoming",
    private: false,
    attachments: [{ id: 5, fileType: "audio", dataUrl: "https://x/a.ogg" }],
    transcribedText: "quero agendar",
  },
});

async function seedConversation(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      contactId,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
}

// The flow emit is fire-and-forget, so the row lands shortly AFTER the turn returns.
async function waitForLog(convChatwootId: number, stage: string) {
  for (let i = 0; i < 100; i++) {
    const row = await suDb.executionLog.findFirst({
      where: {
        tenantId,
        stage,
        threadId: `${tenantId}:${instanceId}:${convChatwootId}`,
      },
      select: {
        level: true,
        status: true,
        durationMs: true,
        provider: true,
        model: true,
        detail: true,
      },
    });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe.skipIf(!dbUp)("tts speech normalization observability", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TTSNORM", slug: `ttsnorm-${process.pid}` },
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
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-llm") },
      select: { id: true },
    });
    const ttsKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "tts-key", secret: encryptJson("sk-tts") },
      select: { id: true },
    });
    const normKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "norm-key", secret: encryptJson("sk-norm") },
      select: { id: true },
    });
    // One agent per rewrite configuration, each answering its own inbox through its own bot, so a
    // test picks the configuration by the inbox its event names.
    const seedAgent = async (
      inbox: number,
      bot: number,
      ttsOverrides: Record<string, unknown>,
    ) => {
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: `Atendente ${inbox}`,
          systemPrompt: "Você é prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: {
            tts: {
              mode: "mirror",
              provider: "openai",
              credentialRef: `vault:${ttsKey.id}`,
              normalize: true,
              ...ttsOverrides,
            },
            split: { enabled: false },
          },
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: bot,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `ttsnorm-route-${inbox}-${process.pid}`,
          name: `Atendente ${inbox}`,
        },
      });
      await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: inbox,
          name: `Suporte ${inbox}`,
          agentId: agent.id,
        },
      });
    };
    // Inbox 7: the rewrite inherits everything from the agent.
    await seedAgent(7, 9, {});
    // Inbox 8: the rewrite on a credential of its own, on a model of its own.
    await seedAgent(8, 10, {
      normalizeProvider: "openai",
      normalizeModel: "gpt-4o-mini-rewriter",
      normalizeCredentialRef: `vault:${normKey.id}`,
    });
    // Inbox 9: the same, pointed at a vault entry that does not exist.
    await seedAgent(9, 11, {
      normalizeProvider: "openai",
      normalizeCredentialRef: "vault:999999999",
    });
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instanceId,
        tenantId,
        name: "Cliente",
        chatwootContactId: 1,
      },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "contacts",
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

  test("an audio turn bills the normalizer as its own usage row and its own flow stage", async () => {
    await seedConversation(9201);
    const rec = { text: [] as string[], audio: [] as string[] };
    const spoken: string[] = [];
    // One queue, in call order: the agent's own generation, then the rewrite for speech.
    const model = new UsageReportingModel([REPLY, NORMALIZED]);
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: audioEvent(9201),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
        ttsFetch: audioFetch(spoken),
      },
    });
    expect(outcome).toBe("posted");
    expect(rec.audio.length).toBe(1);
    // The voice provider spoke the REWRITE, and the customer's transcript kept the original: the
    // rewrite reaches synthesis and nothing else.
    expect(spoken).toEqual([NORMALIZED]);
    expect(rec.text).toEqual([]);
    // Two model calls happened, so two rows must exist — the whole point is that the second one
    // stops being invisible.
    const usage = await suDb.llmUsage.findMany({
      where: { tenantId, threadId: `${tenantId}:${instanceId}:9201` },
      select: { node: true, model: true, promptTokens: true, source: true },
      orderBy: { id: "asc" },
    });
    expect(usage.map((u) => u.node).sort()).toEqual(["agent", "tts_normalize"]);
    const norm = usage.find((u) => u.node === "tts_normalize");
    expect(norm?.model).toBe("gpt-4o-mini");
    expect(norm?.promptTokens).toBeGreaterThan(0);
    expect(norm?.source).toBe("inbox");

    const log = await waitForLog(9201, "normalize");
    expect(log?.status).toBe("ok");
    expect(log?.level).toBe("info");
    expect(log?.durationMs).not.toBeNull();
    // Its own provider/model, which is exactly why this is not an event on the `tts` line: there
    // those two columns mean the voice engine.
    expect(log?.provider).toBe("openai");
    expect(log?.model).toBe("gpt-4o-mini");
    const detail = log?.detail as Record<string, unknown> | null;
    expect(detail?.rewritten).toBe(true);
    expect(Number(detail?.inChars)).toBeGreaterThan(0);
    expect(Number(detail?.outChars)).toBeGreaterThan(0);
    // The invariant that keeps execution_logs exportable: the rewritten text is the CUSTOMER's
    // message, so not one word of it may reach the row.
    expect(JSON.stringify(detail)).not.toContain(MARKER);
  });

  test("a normalizer failure is a warn on its own stage, and the audio still goes out", async () => {
    await seedConversation(9202);
    const rec = { text: [] as string[], audio: [] as string[] };
    // Answers the turn, then throws on the rewrite — the shape of a provider timing out mid-turn.
    let call = 0;
    const model = new UsageReportingModel([REPLY]);
    const flaky = {
      bindTools: () => flaky,
      invoke: async (...args: unknown[]) => {
        call += 1;
        if (call > 1) throw new Error("normalizer upstream 503");
        return (model as unknown as BaseChatModel).invoke(
          ...(args as Parameters<BaseChatModel["invoke"]>),
        );
      },
    };
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: audioEvent(9202),
      base: appDb,
      deps: {
        makeModel: () => flaky as unknown as BaseChatModel,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
        ttsFetch: audioFetch(),
      },
    });
    // Best-effort: the customer still gets the voice note, synthesized from the raw reply.
    expect(outcome).toBe("posted");
    expect(rec.audio.length).toBe(1);
    expect(rec.text.length).toBe(0);
    const log = await waitForLog(9202, "normalize");
    expect(log?.status).toBe("error");
    // warn, not error: the turn recovered. A red line here would page an operator for a reply the
    // customer received.
    expect(log?.level).toBe("warn");
  });

  test("the rewrite runs on its own key and its own model, resolved from the vault", async () => {
    await seedConversation(9203);
    const rec = { text: [] as string[], audio: [] as string[] };
    const spoken: string[] = [];
    // What the factory is handed, per call: the agent's turn first, then the rewrite.
    const built: { apiKey: string; model: string }[] = [];
    const model = new UsageReportingModel([REPLY, NORMALIZED]);
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 10,
      event: audioEvent(9203, 8),
      base: appDb,
      deps: {
        makeModel: (cfg: ResolvedModelConfig) => {
          built.push({ apiKey: cfg.apiKey, model: cfg.model });
          return model as unknown as BaseChatModel;
        },
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
        ttsFetch: audioFetch(spoken),
      },
    });
    expect(outcome).toBe("posted");
    expect(spoken).toEqual([NORMALIZED]);
    // The agent's key for the agent's turn; the rewrite's OWN key, decrypted from ITS vault entry by
    // loadAgentConfig, for the rewrite. A resolution that fell back to the agent's key would pass
    // every unit test in prepare.test.ts (they hand it the resolved key) and fail only here.
    expect(built).toEqual([
      { apiKey: "sk-llm", model: "gpt-4o-mini" },
      { apiKey: "sk-norm", model: "gpt-4o-mini-rewriter" },
    ]);
    // And the bill names the model that was actually charged, not the agent's.
    const usage = await suDb.llmUsage.findMany({
      where: { tenantId, threadId: `${tenantId}:${instanceId}:9203` },
      select: { node: true, model: true },
      orderBy: { id: "asc" },
    });
    expect(usage).toEqual([
      { node: "agent", model: "gpt-4o-mini" },
      { node: "tts_normalize", model: "gpt-4o-mini-rewriter" },
    ]);
    const log = await waitForLog(9203, "normalize");
    expect(log?.status).toBe("ok");
    expect(log?.model).toBe("gpt-4o-mini-rewriter");
  });

  test("a rewrite credential whose entry is gone costs the rewrite, never the voice note", async () => {
    await seedConversation(9204);
    const rec = { text: [] as string[], audio: [] as string[] };
    const spoken: string[] = [];
    const built: string[] = [];
    const model = new UsageReportingModel([REPLY, NORMALIZED]);
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 11,
      event: audioEvent(9204, 9),
      base: appDb,
      deps: {
        makeModel: (cfg: ResolvedModelConfig) => {
          built.push(cfg.apiKey);
          return model as unknown as BaseChatModel;
        },
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
        ttsFetch: audioFetch(spoken),
      },
    });
    // The voice note goes out, spoken from the RAW reply: skipped, not degraded to text.
    expect(outcome).toBe("posted");
    expect(rec.audio.length).toBe(1);
    expect(rec.text).toEqual([]);
    expect(spoken).toEqual([REPLY]);
    // Exactly one model was built (the agent's), on the agent's key: the missing entry never fell
    // back to it, and no second bill exists.
    expect(built).toEqual(["sk-llm"]);
    const usage = await suDb.llmUsage.findMany({
      where: { tenantId, threadId: `${tenantId}:${instanceId}:9204` },
      select: { node: true },
    });
    expect(usage.map((u) => u.node)).toEqual(["agent"]);
    // Visible, on its own stage, with the reason: this is the line the operator has to see, because
    // nothing else about the turn looks wrong.
    const log = await waitForLog(9204, "normalize");
    expect(log?.status).toBe("skipped");
    expect(log?.level).toBe("warn");
    expect((log?.detail as Record<string, unknown> | null)?.reason).toBe(
      "credential_not_found",
    );
  });
});
