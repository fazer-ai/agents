import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
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
import {
  clearMediaAnnotations,
  mediaAnnotationFor,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { debounceDedupeKey } from "@/modules/debounce/service";
import { transcribeInboundAudio } from "@/modules/stt/service";
import { readSttConfig } from "@/modules/stt/settings";
import { extractMessageVisuals } from "@/modules/vision/extract-message";
import { readVisionConfig } from "@/modules/vision/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// A Chatwoot that keeps attachments in external object storage serves a fresh file only once the
// upload to the bucket finished. The arrival pass downloads before that and gets a 404 past its
// retries; the reply's flush runs seconds later, when the file is there. The stub below is that
// storage: `GET attachment` answers what the real client throws after its retries, until `stored`.
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
let keyId = 0n;

const REPLY = "Anotado.";
const WORDS = "quero remarcar a consulta de amanhã";
const DESCRIPTION = "um comprovante de pagamento";
const UNHEARD = "não audível";

class TurnCapturingModel extends BaseChatModel {
  humanTexts: string[] = [];
  constructor() {
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
      if (m.type === "human" && typeof m.content === "string")
        this.humanTexts.push(m.content);
    }
    return {
      generations: [{ text: REPLY, message: new AIMessage(REPLY) }],
    };
  }
}

function png(): ArrayBuffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(800, 16);
  b.writeUInt32BE(600, 20);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const AUDIO_URL = "https://chat.example.com/a/301.ogg";
const IMAGE_URL = "https://chat.example.com/a/302.png";
const IMAGE_URL_2 = "https://chat.example.com/a/303.png";

function voice(id: number) {
  return {
    id,
    content: "",
    message_type: 0,
    private: false,
    attachments: [{ id: 301, file_type: "audio", data_url: AUDIO_URL }],
  };
}

function album(id: number) {
  return {
    id,
    content: "",
    message_type: 0,
    private: false,
    attachments: [
      { id: 302, file_type: "image", data_url: IMAGE_URL },
      { id: 303, file_type: "image", data_url: IMAGE_URL_2 },
    ],
  };
}

function image(id: number) {
  return {
    id,
    content: "",
    message_type: 0,
    private: false,
    attachments: [{ id: 302, file_type: "image", data_url: IMAGE_URL }],
  };
}

// The storage: what the real client throws for `GET attachment` while the file is not served, and
// the bytes once it is. `refusal` stands for a status that will not change by asking again.
function storage(opts: { refusal?: number; late?: string[] } = {}) {
  const state = { stored: false, downloads: 0, sent: 0 };
  const client = (payload: unknown[]) =>
    ({
      getMessages: async () => ({ payload }),
      sendMessage: async () => {
        state.sent++;
        return {};
      },
      toggleTyping: async () => ({}),
      updateAttachmentMeta: async () => ({}),
      downloadAttachment: async (url: string) => {
        state.downloads++;
        if (opts.refusal)
          throw new ChatwootApiError(opts.refusal, "GET attachment");
        if (!state.stored && (!opts.late || opts.late.includes(url)))
          throw new ChatwootApiError(404, "GET attachment");
        return url === AUDIO_URL
          ? {
              bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]).buffer,
              contentType: "audio/ogg",
            }
          : { bytes: png(), contentType: "image/png" };
      },
    }) as unknown as ChatwootClient;
  return { state, client };
}

function provider() {
  const calls = { stt: 0, vision: 0 };
  return {
    calls,
    sttFetch: (async () => {
      calls.stt++;
      return new Response(JSON.stringify({ text: WORDS }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
    visionFetch: (async () => {
      calls.vision++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: DESCRIPTION } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  };
}

function settings() {
  return {
    stt: { enabled: true, provider: "openai", credentialRef: `vault:${keyId}` },
    vision: {
      enabled: true,
      provider: "openai",
      credentialRef: `vault:${keyId}`,
    },
  };
}

async function seedConversation(convId: number): Promise<void> {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      inboxId: inboxDbId,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
}

// The arrival pass's two reads, as the webhook runs them: STT throws on the download, vision
// counts the file unread.
async function arriveVoice(
  convId: number,
  messageId: number,
  client: ChatwootClient,
  fetchImpl: typeof fetch,
) {
  await transcribeInboundAudio({
    tenantId,
    instanceId,
    conversationId: convId,
    messageId,
    attachmentId: 301,
    dataUrl: AUDIO_URL,
    cfg: readSttConfig(settings()),
    base: appDb,
    deps: { makeClient: async () => client, fetchImpl },
  }).catch(() => null);
}

async function arriveImage(
  convId: number,
  messageId: number,
  client: ChatwootClient,
  fetchImpl: typeof fetch,
) {
  return extractMessageVisuals({
    tenantId,
    instanceId,
    conversationId: convId,
    messageId,
    visuals: [
      {
        id: 302,
        dataUrl: IMAGE_URL,
        name: "comprovante.png",
        imageDescription: null,
        extractedText: null,
      },
    ],
    cfg: readVisionConfig(settings()),
    base: appDb,
    deps: { makeClient: async () => client, fetchImpl },
  });
}

async function flush(
  convId: number,
  client: ChatwootClient,
  p: ReturnType<typeof provider>,
  // The burst's start, which the media ceiling counts from. `1` is long past it.
  burstStartedAt = 1,
) {
  const thread = `${tenantId}:${instanceId}:${convId}`;
  // A rescheduled flush leaves its row behind; the next round stands in for the worker's reclaim.
  await suDb.schedulerJob.deleteMany({
    where: { tenantId, dedupeKey: debounceDedupeKey(thread) },
  });
  const row = await suDb.schedulerJob.create({
    data: {
      tenantId,
      kind: "DEBOUNCE",
      dedupeKey: debounceDedupeKey(thread),
      status: "CLAIMED",
      runAt: new Date(),
      payload: { threadId: thread, agentBotId: 9, burstStartedAt },
    },
    select: { id: true, claimSeq: true, payload: true },
  });
  const model = new TurnCapturingModel();
  const out = await flushDebounceJob({
    job: {
      id: row.id,
      tenantId,
      kind: "DEBOUNCE",
      payload: row.payload as Record<string, unknown>,
      attempts: 0,
      claimSeq: row.claimSeq,
    },
    base: appDb,
    deps: {
      makeModel: () => model,
      makeClient: async () => client,
      checkpointer: new MemorySaver(),
      sttFetch: p.sttFetch,
      visionFetch: p.visionFetch,
      transcriptionWaitMs: 50,
    },
  });
  return { out, seen: model.humanTexts.join("\n"), model };
}

describe.skipIf(!dbUp)(
  "debounce flush: media the arrival pass could not download",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "RUM", slug: `rum-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 9,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const key = await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      });
      keyId = key.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${key.id}`,
          },
          settings: settings(),
        },
      });
      agentId = agent.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
          chatwootAgentBotId: 9,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `rum-route-${process.pid}`,
          name: "Atendente",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: 7,
          name: "Suporte",
          agentId,
        },
      });
      inboxDbId = inbox.id;
    });

    beforeEach(() => {
      clearMediaAnnotations();
    });

    afterAll(async () => {
      clearMediaAnnotations();
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("a voice note that was still uploading at arrival reaches the model as words", async () => {
      await seedConversation(9701);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9701, 1, s.client(page), p.sttFetch);
      expect(p.calls.stt).toBe(0);

      s.state.stored = true;
      const { out, seen } = await flush(9701, s.client(page), p);

      expect(out).toEqual({ outcome: "done" });
      expect(p.calls.stt).toBe(1);
      expect(seen).toContain(`<mensagem-de-audio>${WORDS}</mensagem-de-audio>`);
      expect(seen).not.toContain(UNHEARD);
    });

    test("a voice note whose download was refused is not downloaded again", async () => {
      await seedConversation(9702);
      const s = storage({ refusal: 403 });
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9702, 1, s.client(page), p.sttFetch);
      const before = s.state.downloads;

      const { out, seen } = await flush(9702, s.client(page), p);

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.downloads).toBe(before);
      expect(seen).toContain(UNHEARD);
    });

    test("an image that was still uploading at arrival reaches the model as its description", async () => {
      await seedConversation(9703);
      const s = storage();
      const p = provider();
      const page = [image(1)];
      const arrival = await arriveImage(9703, 1, s.client(page), p.visionFetch);
      expect(arrival?.unreadFiles).toEqual([
        { name: "comprovante.png", cause: "failed", retryable: true },
      ]);
      expect(p.calls.vision).toBe(0);

      s.state.stored = true;
      const { out, seen } = await flush(9703, s.client(page), p);

      expect(out).toEqual({ outcome: "done" });
      expect(p.calls.vision).toBe(1);
      expect(seen).toContain(DESCRIPTION);
    });

    test("an image whose download was refused is not downloaded again", async () => {
      await seedConversation(9704);
      const s = storage({ refusal: 403 });
      const p = provider();
      const page = [image(1)];
      const arrival = await arriveImage(9704, 1, s.client(page), p.visionFetch);
      expect(arrival?.unreadFiles).toEqual([
        { name: "comprovante.png", cause: "failed" },
      ]);
      const before = s.state.downloads;

      const { out, seen } = await flush(9704, s.client(page), p);

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.downloads).toBe(before);
      expect(seen).not.toContain(DESCRIPTION);
    });

    test("a voice note still uploading when the flush runs defers the reply instead of calling it inaudible", async () => {
      await seedConversation(9707);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9707, 1, s.client(page), p.sttFetch);

      const first = await flush(9707, s.client(page), p, Date.now());

      expect(first.out.outcome).toBe("reschedule");
      expect(s.state.sent).toBe(0);
      expect(first.model.humanTexts).toEqual([]);

      s.state.stored = true;
      const second = await flush(9707, s.client(page), p, Date.now());

      expect(second.out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
      expect(second.seen).toContain(WORDS);
    });

    test("an image still uploading when the flush runs defers the reply", async () => {
      await seedConversation(9708);
      const s = storage();
      const p = provider();
      const page = [image(1)];
      await arriveImage(9708, 1, s.client(page), p.visionFetch);

      const { out, model } = await flush(9708, s.client(page), p, Date.now());

      expect(out.outcome).toBe("reschedule");
      expect(s.state.sent).toBe(0);
      expect(model.humanTexts).toEqual([]);
    });

    test("past the media ceiling the reply goes out with the voice note unread", async () => {
      await seedConversation(9709);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9709, 1, s.client(page), p.sttFetch);

      const { out, seen } = await flush(
        9709,
        s.client(page),
        p,
        Date.now() - 61_000,
      );

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
      expect(seen).toContain(UNHEARD);
    });

    test("a refused download does not defer the reply", async () => {
      await seedConversation(9710);
      const s = storage({ refusal: 403 });
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9710, 1, s.client(page), p.sttFetch);

      const { out } = await flush(9710, s.client(page), p, Date.now());

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
    });

    test("an album with one file still uploading waits for it and reads only that file again", async () => {
      await seedConversation(9711);
      const s = storage({ late: [IMAGE_URL_2] });
      const p = provider();
      const page = [album(1)];
      const arrival = await extractMessageVisuals({
        tenantId,
        instanceId,
        conversationId: 9711,
        messageId: 1,
        visuals: [
          {
            id: 302,
            dataUrl: IMAGE_URL,
            name: "frente.png",
            imageDescription: null,
            extractedText: null,
          },
          {
            id: 303,
            dataUrl: IMAGE_URL_2,
            name: "verso.png",
            imageDescription: null,
            extractedText: null,
          },
        ],
        cfg: readVisionConfig(settings()),
        base: appDb,
        deps: {
          makeClient: async () => s.client(page),
          fetchImpl: p.visionFetch,
        },
      });
      expect(arrival?.unreadFiles).toEqual([
        { name: "verso.png", cause: "failed", retryable: true },
      ]);
      expect(p.calls.vision).toBe(1);

      const first = await flush(9711, s.client(page), p, Date.now());
      expect(first.out.outcome).toBe("reschedule");
      expect(s.state.sent).toBe(0);

      s.state.stored = true;
      const second = await flush(9711, s.client(page), p, Date.now());

      expect(second.out).toEqual({ outcome: "done" });
      expect(p.calls.vision).toBe(2);
      expect(second.seen).not.toContain("verso.png");
    });

    // The download succeeded and the provider failed: the file is no longer on its way, so the
    // flush answers instead of paying the provider again on every round until the ceiling.
    test("a voice note downloaded at the flush stops the wait even when the provider fails", async () => {
      await seedConversation(9712);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9712, 1, s.client(page), p.sttFetch);

      s.state.stored = true;
      const failing = {
        ...p,
        sttFetch: (async () => {
          p.calls.stt++;
          return new Response("upstream error", { status: 500 });
        }) as unknown as typeof fetch,
      };
      const { out } = await flush(9712, s.client(page), failing, Date.now());

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
      expect(
        mediaAnnotationFor(tenantId, instanceId, 1)?.transcriptionUnavailable,
      ).toBe(false);
    });

    test("a download refused after a 404 stops the wait", async () => {
      await seedConversation(9713);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9713, 1, s.client(page), p.sttFetch);

      const refused = storage({ refusal: 403 });
      const { out } = await flush(9713, refused.client(page), p, Date.now());

      expect(out).toEqual({ outcome: "done" });
      expect(refused.state.sent).toBe(1);
    });

    // A flush that starts just inside the ceiling spends seconds retrying; it does not reschedule
    // past the ceiling on a verdict taken before the retries.
    test("the ceiling is asked after the retries, not only when the flush starts", async () => {
      await seedConversation(9714);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9714, 1, s.client(page), p.sttFetch);
      // Each download moves the clock two seconds on, as a slow storage would.
      const real = Date.now.bind(Date);
      let ahead = 0;
      const slow = s.client(page);
      const download = slow.downloadAttachment.bind(slow);
      slow.downloadAttachment = (async (
        ...args: Parameters<typeof download>
      ) => {
        ahead += 2_000;
        return download(...args);
      }) as typeof slow.downloadAttachment;
      const clock = spyOn(Date, "now").mockImplementation(() => real() + ahead);

      const { out } = await flush(9714, slow, p, real() - 59_000).finally(() =>
        clock.mockRestore(),
      );

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
    });

    // Files over the per-message cap are counted unread and never tried: reading the message again
    // would only meet the same cap.
    test("an image message with files over the cap is not read again", async () => {
      await seedConversation(9706);
      const s = storage();
      s.state.stored = true;
      const p = provider();
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 1 },
        {
          attachmentsUnread: 2,
          unreadFiles: [
            { name: "comprovante.png", cause: "failed", retryable: true },
          ],
        },
      );

      const { out } = await flush(9706, s.client([image(1)]), p);

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.downloads).toBe(0);
      expect(p.calls.vision).toBe(0);
    });

    test("a voice note transcribed by the reply drops the mark", async () => {
      await seedConversation(9705);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9705, 1, s.client(page), p.sttFetch);
      expect(
        mediaAnnotationFor(tenantId, instanceId, 1)?.transcriptionUnavailable,
      ).toBe(true);

      s.state.stored = true;
      await flush(9705, s.client(page), p);

      const note = mediaAnnotationFor(tenantId, instanceId, 1);
      expect(note?.transcribedText).toBe(WORDS);
      expect(note?.transcriptionUnavailable).toBe(false);
    });
  },
);
