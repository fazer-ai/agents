import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import { buildNativeTools } from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import type { FlowContext } from "@/modules/flowlog/service";
import { synthesizeReply } from "@/modules/tts/service";
import { TTS_DEFAULTS, type TtsConfig } from "@/modules/tts/settings";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRow } from "../utils/flowlog";

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
let llmKeyId = 0n;
let ttsKeyId = 0n;
let igInboxId = 0n;

const REPLY = "Claro, vou te ajudar!";

function fakeModel() {
  return new FakeListChatModel({ responses: [REPLY] });
}

function audioFetch() {
  return (async () =>
    new Response(new ArrayBuffer(16), {
      status: 200,
      headers: { "content-type": "audio/ogg" },
    })) as unknown as typeof fetch;
}

function makeStub(rec: {
  text: Array<[number, string]>;
  audio: Array<[number, string]>;
}) {
  const client = {
    sendMessage: async (c: number, content: string) => {
      rec.text.push([c, content]);
      return {};
    },
    sendAudioMessage: async (c: number, _a: ArrayBuffer, fileName: string) => {
      rec.audio.push([c, fileName]);
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

const textEvent = (convId: number): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId: convId,
  contactInboxId: null,
  inboxId: 7,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  message: { id: 2, content: "oi", messageType: "incoming", private: false },
});

async function seedConversation(convId: number, inboxDbId?: bigint) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      contactId,
      ...(inboxDbId === undefined ? {} : { inboxId: inboxDbId }),
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
}

describe.skipIf(!dbUp)("tts", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TTS", slug: `tts-${process.pid}` },
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
    llmKeyId = llmKey.id;
    const ttsKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "tts-key", secret: encryptJson("sk-tts") },
      select: { id: true },
    });
    ttsKeyId = ttsKey.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKeyId}`,
        },
        settings: {
          tts: {
            mode: "mirror",
            provider: "openai",
            credentialRef: `vault:${ttsKeyId}`,
          },
          // Pin split off so these TTS tests exercise the plain text/audio reply
          // path (split is on by default now and has its own test).
          split: { enabled: false },
        },
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
        webhookRouteTokenHash: `tts-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    // NOTE: a second inbox on a channel that refuses Ogg/Opus (Meta's Instagram messaging accepts audio
    // only as aac/m4a/wav/mp4) — the reply container must follow the channel.
    const igInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 8,
        name: "Instagram",
        channelType: "Channel::Instagram",
        agentId: agent.id,
      },
      select: { id: true },
    });
    igInboxId = igInbox.id;
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

  test("synthesizeReply resolves the credential and returns audio", async () => {
    const cfg: TtsConfig = {
      ...TTS_DEFAULTS,
      mode: "mirror",
      provider: "openai",
      model: "",
      voice: "",
      credentialRef: `vault:${ttsKeyId}`,
      baseURL: null,
      normalize: false,
    };
    const res = await synthesizeReply({
      tenantId,
      cfg,
      text: "olá",
      base: appDb,
      deps: { fetchImpl: audioFetch() },
    });
    expect(res?.mime).toBe("audio/ogg");
    expect(res?.fileName).toBe("reply.ogg");
  });

  test("synthesizeReply skips with a warn/skipped flow event when misconfigured (no voice)", async () => {
    // ElevenLabs requires a voice; with none set the synth is not runnable → null, and (with a flow
    // context) a warn+skipped line so the operator sees WHY the audio reply didn't happen.
    const cfg: TtsConfig = {
      ...TTS_DEFAULTS,
      mode: "mirror",
      provider: "elevenlabs",
      model: "",
      voice: "",
      credentialRef: `vault:${ttsKeyId}`,
      baseURL: null,
      normalize: false,
    };
    const f: FlowContext = {
      tenantId,
      turnId: "tts-skip-novoice",
      source: "inbox",
      base: appDb,
    };
    const res = await synthesizeReply({
      tenantId,
      cfg,
      text: "olá",
      base: appDb,
      deps: { fetchImpl: audioFetch() },
      flow: f,
    });
    expect(res).toBeNull();
    // emit is fire-and-forget → poll for the row.
    let row: { level: string; status: string | null } | null = null;
    for (let i = 0; i < 100 && !row; i++) {
      row = await flowLogRow(suDb, {
        where: { tenantId, turnId: "tts-skip-novoice", stage: "tts" },
        select: { level: true, status: true },
      });
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    expect(row?.level).toBe("warn");
    expect(row?.status).toBe("skipped");
  });

  // NOTE: a failing ElevenLabs synth used to log `format: "ogg_opus"` (our INTERNAL container name) next
  // to a bare "failed with 400" — which reads exactly like the value we put on the wire, and was
  // reported as such. The line now carries the provider-level format alongside it, plus the
  // provider's own machine-readable error code (never its free-text message).
  test("a provider failure logs the wire format and the provider's error code", async () => {
    const cfg: TtsConfig = {
      ...TTS_DEFAULTS,
      mode: "mirror",
      provider: "elevenlabs",
      model: "",
      voice: "Keren123",
      credentialRef: `vault:${ttsKeyId}`,
      baseURL: null,
      normalize: false,
    };
    const f: FlowContext = {
      tenantId,
      turnId: "tts-fail-400",
      source: "inbox",
      base: appDb,
    };
    const failingFetch = (async () =>
      new Response(
        JSON.stringify({
          detail: {
            status: "voice_not_found",
            message: "A voice with voice_id Keren123 was not found.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(
      synthesizeReply({
        tenantId,
        cfg,
        text: "olá",
        base: appDb,
        deps: { fetchImpl: failingFetch },
        flow: f,
      }),
    ).rejects.toThrow("TTS elevenlabs failed with 400 (voice_not_found)");

    let row: {
      level: string;
      status: string | null;
      errorMessage: string | null;
      detail: unknown;
    } | null = null;
    for (let i = 0; i < 100 && !row; i++) {
      row = await flowLogRow(suDb, {
        where: { tenantId, turnId: "tts-fail-400", stage: "tts" },
        select: {
          level: true,
          status: true,
          errorMessage: true,
          detail: true,
        },
      });
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    // TTS is best-effort (the runtime falls back to text), so the line is advisory, not a red error.
    expect(row?.level).toBe("warn");
    expect(row?.status).toBe("error");
    expect(row?.errorMessage).toBe(
      "TTS elevenlabs failed with 400 (voice_not_found)",
    );
    expect(row?.errorMessage).not.toContain("was not found.");
    const detail = row?.detail as Record<string, unknown>;
    expect(detail.format).toBe("ogg_opus");
    expect(detail.providerFormat).toBe("opus_48000_64");
  });

  test("normalize=true rewrites the synth input via the injected normalizer", async () => {
    const cfg: TtsConfig = {
      ...TTS_DEFAULTS,
      mode: "mirror",
      provider: "openai",
      model: "",
      voice: "",
      credentialRef: `vault:${ttsKeyId}`,
      baseURL: null,
      normalize: true,
    };
    let captured = "";
    const captureFetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)).input;
      return new Response(new ArrayBuffer(16), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }) as unknown as typeof fetch;
    await synthesizeReply({
      tenantId,
      cfg,
      text: "Total: R$ 50",
      base: appDb,
      deps: {
        fetchImpl: captureFetch,
        normalizeSpeech: async () => "cinquenta reais",
      },
    });
    expect(captured).toBe("cinquenta reais");
  });

  // The rewrite is a BILLED call, and with it shipping on by default an agent set to mirror with no
  // TTS credential would pay for one on every audio-triggering turn and still fall back to text. Every
  // check that can abort the synthesis has to come first.
  test("no credential → the paid rewrite is never called", async () => {
    const cfg: TtsConfig = {
      ...TTS_DEFAULTS,
      mode: "mirror",
      provider: "openai",
      credentialRef: null,
      normalize: true,
    };
    let called = 0;
    const res = await synthesizeReply({
      tenantId,
      cfg,
      text: "olá",
      base: appDb,
      deps: {
        fetchImpl: audioFetch(),
        normalizeSpeech: async (t) => {
          called += 1;
          return t;
        },
      },
    });
    expect(res).toBeNull();
    expect(called).toBe(0);
  });

  test("a credential that no longer resolves → the paid rewrite is never called", async () => {
    const cfg: TtsConfig = {
      ...TTS_DEFAULTS,
      mode: "mirror",
      provider: "openai",
      credentialRef: "vault:999999999999",
      normalize: true,
    };
    let called = 0;
    const res = await synthesizeReply({
      tenantId,
      cfg,
      text: "olá",
      base: appDb,
      deps: {
        fetchImpl: audioFetch(),
        normalizeSpeech: async (t) => {
          called += 1;
          return t;
        },
      },
    });
    expect(res).toBeNull();
    expect(called).toBe(0);
  });

  test("normalize falls back to the raw text when the normalizer throws", async () => {
    const cfg: TtsConfig = {
      ...TTS_DEFAULTS,
      mode: "mirror",
      provider: "openai",
      model: "",
      voice: "",
      credentialRef: `vault:${ttsKeyId}`,
      baseURL: null,
      normalize: true,
    };
    let captured = "";
    const captureFetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)).input;
      return new Response(new ArrayBuffer(16), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }) as unknown as typeof fetch;
    await synthesizeReply({
      tenantId,
      cfg,
      text: "olá",
      base: appDb,
      deps: {
        fetchImpl: captureFetch,
        normalizeSpeech: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(captured).toBe("olá");
  });

  test("set_voice_preference writes Contact.voiceReply", async () => {
    const tools = buildNativeTools({
      client: {} as ChatwootClient,
      conversationId: 1,
      tenantId,
      base: appDb,
      contactDbId: contactId,
    });
    const tool = tools.find((x) => x.name === "set_voice_preference");
    expect(tool).toBeDefined();
    await tool?.invoke({ preference: "audio" });
    const c = await suDb.contact.findUniqueOrThrow({
      where: { id: contactId },
      select: { voiceReply: true },
    });
    expect(c.voiceReply).toBe(true);
    // "default" resets the preference to null → replies mirror the customer (item 14).
    await tool?.invoke({ preference: "default" });
    const c2 = await suDb.contact.findUniqueOrThrow({
      where: { id: contactId },
      select: { voiceReply: true },
    });
    expect(c2.voiceReply).toBeNull();
  });

  test("mirror mode → an audio message gets an audio reply", async () => {
    await seedConversation(910);
    const rec = {
      text: [] as [number, string][],
      audio: [] as [number, string][],
    };
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: audioEvent(910),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
        ttsFetch: audioFetch(),
      },
    });
    expect(outcome).toBe("posted");
    expect(rec.audio).toEqual([[910, "reply.ogg"]]);
    expect(rec.text).toEqual([]);
  });

  test("mirror mode on an Instagram inbox → the audio reply is aac, not ogg", async () => {
    await seedConversation(933, igInboxId);
    const rec = {
      text: [] as [number, string][],
      audio: [] as [number, string][],
    };
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: audioEvent(933, 8),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
        ttsFetch: audioFetch(),
      },
    });
    // NOTE: ogg would make Meta's send job fail AFTER Chatwoot shows the message as sent (the customer
    // never receives it); on this channel the openai provider must emit aac.
    expect(outcome).toBe("posted");
    expect(rec.audio).toEqual([[933, "reply.aac"]]);
    expect(rec.text).toEqual([]);
  });

  test("mirror mode → a text message gets a text reply", async () => {
    await seedConversation(911);
    const rec = {
      text: [] as [number, string][],
      audio: [] as [number, string][],
    };
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: textEvent(911),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
        ttsFetch: audioFetch(),
      },
    });
    expect(outcome).toBe("posted");
    expect(rec.text).toEqual([[911, REPLY]]);
    expect(rec.audio).toEqual([]);
  });
});
