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
  openTranscription,
  overlayMediaAnnotations,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";
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
const BACK = "o verso do mesmo documento";

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
  // When the flush first deferred for a file on its way, which the media ceiling counts from;
  // absent, this flush.
  mediaWaitSince?: number,
  // When the burst first deferred for a busy thread.
  deferringSince?: number,
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
      payload: {
        threadId: thread,
        agentBotId: 9,
        burstStartedAt: 1,
        ...(mediaWaitSince !== undefined ? { mediaWaitSince } : {}),
        ...(deferringSince !== undefined ? { deferringSince } : {}),
      },
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
      // The media wait keeps its own stamp, apart from the busy-thread deferral's.
      const row = await suDb.schedulerJob.findFirstOrThrow({
        where: {
          tenantId,
          dedupeKey: debounceDedupeKey(`${tenantId}:${instanceId}:9707`),
        },
        select: { payload: true },
      });
      expect(row.payload).toHaveProperty("mediaWaitSince");
      expect(row.payload).not.toHaveProperty("deferringSince");

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
      const back = {
        ...p,
        visionFetch: (async () => {
          p.calls.vision++;
          return new Response(
            JSON.stringify({ choices: [{ message: { content: BACK } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      };
      const second = await flush(9711, s.client(page), back, Date.now());

      expect(second.out).toEqual({ outcome: "done" });
      expect(p.calls.vision).toBe(2);
      expect(second.seen).toContain(DESCRIPTION);
      expect(second.seen).toContain(BACK);
      expect(second.seen).not.toContain("anexos-nao-lidos");
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

    test("a cleared mark reaches a row an earlier overlay marked", () => {
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 1 },
        { transcriptionUnavailable: true },
      );
      const row = {
        id: 1,
        transcribedText: null,
      } as unknown as ChatwootMessageRow;
      overlayMediaAnnotations(tenantId, instanceId, [row]);
      expect(row.transcriptionUnavailable).toBe(true);

      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 1 },
        { transcriptionUnavailable: false },
      );
      overlayMediaAnnotations(tenantId, instanceId, [row]);
      expect(row.transcriptionUnavailable).toBe(false);
    });

    // A timeout or the caller's deadline is no answer from the storage.
    test("a download cut short keeps the mark a 404 left", async () => {
      await seedConversation(9715);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9715, 1, s.client(page), p.sttFetch);
      const cut = s.client(page);
      cut.downloadAttachment = (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as typeof cut.downloadAttachment;

      await arriveVoice(9715, 1, cut, p.sttFetch);

      expect(
        mediaAnnotationFor(tenantId, instanceId, 1)?.transcriptionUnavailable,
      ).toBe(true);
    });

    test("an image download cut short keeps the mark a 404 left", async () => {
      await seedConversation(9723);
      const s = storage();
      const p = provider();
      const page = [image(1)];
      await arriveImage(9723, 1, s.client(page), p.visionFetch);
      const cut = s.client(page);
      cut.downloadAttachment = (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as typeof cut.downloadAttachment;

      const again = await arriveImage(9723, 1, cut, p.visionFetch);

      expect(again?.unreadFiles).toEqual([
        { name: "comprovante.png", cause: "failed", retryable: true },
      ]);
      const { out } = await flush(9723, s.client(page), p, Date.now());
      expect(out.outcome).toBe("reschedule");
    });

    // The file is in storage and the provider failed on it: waiting longer only pays it again.
    test("an image downloaded at the flush stops the wait even when the provider fails", async () => {
      await seedConversation(9724);
      const s = storage();
      const p = provider();
      const page = [image(1)];
      await arriveImage(9724, 1, s.client(page), p.visionFetch);

      s.state.stored = true;
      const failing = {
        ...p,
        visionFetch: (async () => {
          p.calls.vision++;
          throw new DOMException("The operation timed out.", "TimeoutError");
        }) as unknown as typeof fetch,
      };
      const { out } = await flush(9724, s.client(page), failing, Date.now());

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
    });

    // The flush's wait for the arrival pass is shorter than that pass's 404 backoff.
    test("a voice note whose arrival download is still retrying is marked on its way from the first 404", async () => {
      await seedConversation(9725);
      let release: () => void = () => {};
      const landed = new Promise<void>((r) => {
        release = r;
      });
      let missed: () => void = () => {};
      const firstMissing = new Promise<void>((r) => {
        missed = r;
      });
      const s = storage();
      const retrying = s.client([voice(1)]);
      retrying.downloadAttachment = (async (
        _url: string,
        opts?: { onMissing?: () => void },
      ) => {
        opts?.onMissing?.();
        missed();
        await landed;
        return {
          bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]).buffer,
          contentType: "audio/ogg",
        };
      }) as typeof retrying.downloadAttachment;
      const p = provider();
      const arrival = arriveVoice(9725, 1, retrying, p.sttFetch);
      await firstMissing;
      const during = mediaAnnotationFor(
        tenantId,
        instanceId,
        1,
      )?.transcriptionUnavailable;
      release();
      await arrival;

      expect(during).toBe(true);
      expect(
        mediaAnnotationFor(tenantId, instanceId, 1)?.transcriptionUnavailable,
      ).toBe(false);
    });

    test("a flush that stops waiting while the arrival download retries defers without downloading again", async () => {
      await seedConversation(9726);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      const target = { tenantId, instanceId, messageId: 1 };
      const close = openTranscription(target);
      stashMediaAnnotation(target, { transcriptionUnavailable: true });

      const first = await flush(9726, s.client(page), p, Date.now()).finally(
        close,
      );

      expect(first.out.outcome).toBe("reschedule");
      expect(s.state.downloads).toBe(0);
      expect(s.state.sent).toBe(0);

      s.state.stored = true;
      const second = await flush(9726, s.client(page), p, Date.now());
      expect(second.out).toEqual({ outcome: "done" });
      expect(second.seen).toContain(WORDS);
    });

    // The credential went away after the arrival pass: no flush can download the note now.
    test("a voice note the agent can no longer transcribe does not defer the reply", async () => {
      await seedConversation(9727);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9727, 1, s.client(page), p.sttFetch);
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            ...settings(),
            stt: {
              enabled: true,
              provider: "openai",
              credentialRef: "vault:999999999",
            },
          },
        },
      });

      const { out } = await flush(9727, s.client(page), p, Date.now()).finally(
        () =>
          suDb.agent.update({
            where: { id: agentId },
            data: { settings: settings() },
          }),
      );

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
    });

    test("an image whose first download answers 404 and then times out stays on its way", async () => {
      await seedConversation(9728);
      const s = storage();
      const p = provider();
      const cut = s.client([image(1)]);
      cut.downloadAttachment = (async (
        _url: string,
        opts?: { onMissing?: () => void },
      ) => {
        opts?.onMissing?.();
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as typeof cut.downloadAttachment;

      const arrival = await arriveImage(9728, 1, cut, p.visionFetch);

      expect(arrival?.unreadFiles).toEqual([
        { name: "comprovante.png", cause: "failed", retryable: true },
      ]);
    });

    test("a flush attempt that fails keeps the media wait's deadline", async () => {
      await seedConversation(9729);
      const s = storage();
      const p = provider();
      await arriveVoice(9729, 1, s.client([voice(1)]), p.sttFetch);
      const broken = s.client([voice(1)]);
      broken.getMessages = (async () => {
        throw new ChatwootApiError(502, "GET messages");
      }) as typeof broken.getMessages;
      const since = Date.now() - 30_000;

      await flush(9729, broken, p, since).catch(() => null);

      const row = await suDb.schedulerJob.findFirstOrThrow({
        where: {
          tenantId,
          dedupeKey: debounceDedupeKey(`${tenantId}:${instanceId}:9729`),
        },
        select: { payload: true },
      });
      expect(row.payload).toHaveProperty("mediaWaitSince", since);
    });

    // A debounce it never turned on does not cap the media wait's burst: the late file is what it is for.
    test("an agent with debounce off keeps the late voice note when a text joins its wait", async () => {
      await seedConversation(9730);
      const s = storage();
      const p = provider();
      const page = [
        voice(1),
        {
          id: 2,
          content: "consegue?",
          message_type: 0,
          private: false,
          attachments: [],
        },
      ];
      await arriveVoice(9730, 1, s.client(page), p.sttFetch);
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            ...settings(),
            debounce: { enabled: false, maxMessagesPerBurst: 1 },
          },
        },
      });
      s.state.stored = true;

      const { out, seen } = await flush(
        9730,
        s.client(page),
        p,
        Date.now(),
      ).finally(() =>
        suDb.agent.update({
          where: { id: agentId },
          data: { settings: settings() },
        }),
      );

      expect(out).toEqual({ outcome: "done" });
      expect(seen).toContain(WORDS);
      expect(seen).toContain("consegue?");
    });

    // The edit took the file away: nothing is left to download, so nothing is left to wait for.
    test("a message whose failed file was edited away does not defer the reply", async () => {
      await seedConversation(9731);
      const s = storage();
      const p = provider();
      await arriveVoice(9731, 1, s.client([voice(1)]), p.sttFetch);
      const edited = [
        {
          id: 1,
          content: "esquece o áudio",
          message_type: 0,
          private: false,
          attachments: [],
        },
      ];

      const { out } = await flush(9731, s.client(edited), p, Date.now());

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
    });

    test("no voice note is tried again once the media wait is over", async () => {
      await seedConversation(9716);
      const s = storage();
      const p = provider();
      const page = [voice(1), voice(2)];
      await arriveVoice(9716, 1, s.client(page), p.sttFetch);
      await arriveVoice(9716, 2, s.client(page), p.sttFetch);
      const before = s.state.downloads;
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

      const { out } = await flush(9716, slow, p, real() - 59_000).finally(() =>
        clock.mockRestore(),
      );

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.downloads - before).toBe(1);
    });

    test("no late image is tried again once an earlier one ran the media wait out", async () => {
      await seedConversation(9720);
      const s = storage();
      const p = provider();
      const page = [image(1), image(2)];
      await arriveImage(9720, 1, s.client(page), p.visionFetch);
      await arriveImage(9720, 2, s.client(page), p.visionFetch);
      const before = s.state.downloads;
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

      const { out } = await flush(9720, slow, p, real() - 59_000).finally(() =>
        clock.mockRestore(),
      );

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.downloads - before).toBe(1);
    });

    // The operator turned transcription off after the arrival pass: no flush will open the note.
    test("a voice note the agent no longer transcribes does not defer the reply", async () => {
      await seedConversation(9721);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9721, 1, s.client(page), p.sttFetch);
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { ...settings(), stt: { enabled: false } } },
      });

      const { out } = await flush(9721, s.client(page), p, Date.now()).finally(
        () =>
          suDb.agent.update({
            where: { id: agentId },
            data: { settings: settings() },
          }),
      );

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
    });

    test("a voice note under the media refusal mark does not defer the reply", async () => {
      await seedConversation(9722);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9722, 1, s.client(page), p.sttFetch);
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: 9722 },
        data: { mediaRefusedThroughMessageId: 1n },
      });

      const { out } = await flush(9722, s.client(page), p, Date.now());

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.sent).toBe(1);
    });

    test("past the media ceiling a late image is not downloaded again", async () => {
      await seedConversation(9718);
      const s = storage();
      const p = provider();
      const page = [image(1)];
      await arriveImage(9718, 1, s.client(page), p.visionFetch);
      const before = s.state.downloads;

      const { out } = await flush(9718, s.client(page), p, Date.now() - 61_000);

      expect(out).toEqual({ outcome: "done" });
      expect(s.state.downloads).toBe(before);
    });

    // A burst that waited a long time for a busy thread has not waited for the file at all.
    test("time spent waiting for a busy thread does not use up the media wait", async () => {
      await seedConversation(9719);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9719, 1, s.client(page), p.sttFetch);

      const first = await flush(
        9719,
        s.client(page),
        p,
        undefined,
        Date.now() - 120_000,
      );
      expect(first.out.outcome).toBe("reschedule");
      expect(s.state.sent).toBe(0);

      s.state.stored = true;
      const second = await flush(
        9719,
        s.client(page),
        p,
        undefined,
        Date.now() - 120_000,
      );
      expect(second.out).toEqual({ outcome: "done" });
      expect(second.seen).toContain(WORDS);
    });

    test("the next round of a media wait is never set past its ceiling", async () => {
      await seedConversation(9717);
      const s = storage();
      const p = provider();
      const page = [voice(1)];
      await arriveVoice(9717, 1, s.client(page), p.sttFetch);
      const start = Date.now() - 57_000;

      const { out } = await flush(9717, s.client(page), p, start);

      expect(out.outcome).toBe("reschedule");
      const runAt = new Date((out as { runAt: Date }).runAt).getTime();
      expect(runAt).toBeLessThanOrEqual(start + 60_000);
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
