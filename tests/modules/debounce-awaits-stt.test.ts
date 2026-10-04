import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  clearMediaAnnotations,
  openTranscription,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { debounceDedupeKey } from "@/modules/debounce/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// A voice note whose transcription is still running when the flush fires: the flush re-reads the
// thread, finds the audio with no words yet, and before this rendered it as the "not audible" marker,
// so the model asked the customer to resend what landed a fraction of a second later. The eager pass
// now announces the transcription it is running, and the flush waits for it, bounded.
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
let inboxDbId = 0n;

const REPLY = "Entendi o seu áudio.";
const WORDS = "quero remarcar a consulta de amanhã";
const MARKER = "não audível";

// What the model was handed, so a test can say whether it heard the words or the marker.
class CaptureModel {
  seen: string[] = [];
  async invoke(messages: Array<{ content: unknown }>) {
    this.seen.push(messages.map((m) => String(m.content)).join("\n"));
    return new AIMessage(REPLY);
  }
  bindTools(_tools: unknown) {
    return {
      invoke: (messages: Array<{ content: unknown }>) => this.invoke(messages),
    };
  }
}

// Two voice notes, the second one (id 3) the one still being transcribed.
const PAGE = {
  payload: [2, 3].map((id) => ({
    id,
    content: "",
    message_type: 0,
    private: false,
    attachments: [
      {
        id: 100 + id,
        file_type: "audio",
        data_url: `https://chat.example.com/a/${id}.oga`,
      },
    ],
  })),
};

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

async function flush(
  convId: number,
  transcriptionWaitMs?: number,
  signal?: AbortSignal,
  afterRead?: () => void,
) {
  const thread = `${tenantId}:${instanceId}:${convId}`;
  const row = await suDb.schedulerJob.create({
    data: {
      tenantId,
      kind: "DEBOUNCE",
      dedupeKey: debounceDedupeKey(thread),
      status: "CLAIMED",
      runAt: new Date(),
      payload: { threadId: thread, agentBotId: 9, burstStartedAt: 1 },
    },
    select: { id: true, claimSeq: true, payload: true },
  });
  const sent: Array<[number, string]> = [];
  const client = {
    getMessages: async () => {
      if (afterRead) setTimeout(afterRead, 0);
      return PAGE;
    },
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
  const model = new CaptureModel();
  const started = Date.now();
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
    ...(signal ? { signal } : {}),
    deps: {
      makeModel: () => model as unknown as BaseChatModel,
      makeClient: async () => client,
      checkpointer: new MemorySaver(),
      ...(transcriptionWaitMs !== undefined ? { transcriptionWaitMs } : {}),
    },
  });
  return { out, sent, seen: model.seen, elapsedMs: Date.now() - started };
}

describe.skipIf(!dbUp)(
  "debounce flush: a voice note still being transcribed",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "STTW", slug: `sttw-${process.pid}` },
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
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `sttw-route-${process.pid}`,
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

    afterAll(async () => {
      clearMediaAnnotations();
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    const first = () =>
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 2 },
        { transcribedText: "oi, tudo bem?" },
      );

    test("the flush waits for the transcription and the model hears the words", async () => {
      clearMediaAnnotations();
      await seedConversation(901);
      first();
      const close = openTranscription({ tenantId, instanceId, messageId: 3 });
      setTimeout(() => {
        stashMediaAnnotation(
          { tenantId, instanceId, messageId: 3 },
          { transcribedText: WORDS },
        );
        close();
      }, 300);
      const { out, sent, seen } = await flush(901);
      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([[901, REPLY]]);
      expect(seen[0]).toContain(
        `<mensagem-de-audio>${WORDS}</mensagem-de-audio>`,
      );
      expect(seen[0]).not.toContain(MARKER);
    });

    test("a transcription past the bound leaves the marker, and the reply still goes out", async () => {
      clearMediaAnnotations();
      await seedConversation(902);
      first();
      const close = openTranscription({ tenantId, instanceId, messageId: 3 });
      try {
        const { out, sent, seen, elapsedMs } = await flush(902, 200);
        expect(out).toEqual({ outcome: "done" });
        expect(sent).toEqual([[902, REPLY]]);
        expect(seen[0]).toContain(MARKER);
        expect(elapsedMs).toBeLessThan(3000);
      } finally {
        close();
      }
    });

    test("a transcription that ends without words stops the wait at once", async () => {
      clearMediaAnnotations();
      await seedConversation(903);
      first();
      const close = openTranscription({ tenantId, instanceId, messageId: 3 });
      setTimeout(close, 100);
      const { out, seen, elapsedMs } = await flush(903, 10_000);
      expect(out).toEqual({ outcome: "done" });
      expect(seen[0]).toContain(MARKER);
      expect(elapsedMs).toBeLessThan(5000);
    });

    test("with no transcription running, the flush does not wait", async () => {
      clearMediaAnnotations();
      await seedConversation(904);
      first();
      const { out, seen, elapsedMs } = await flush(904, 10_000);
      expect(out).toEqual({ outcome: "done" });
      expect(seen[0]).toContain(MARKER);
      expect(elapsedMs).toBeLessThan(5000);
    });

    // A second delivery of a note already transcribed can run the pass again: the words are here, so
    // there is nothing to wait for.
    test("a voice note whose words are already here is not waited for", async () => {
      clearMediaAnnotations();
      await seedConversation(905);
      first();
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 3 },
        { transcribedText: WORDS },
      );
      const close = openTranscription({ tenantId, instanceId, messageId: 3 });
      try {
        const { seen, elapsedMs } = await flush(905, 10_000);
        expect(seen[0]).toContain(WORDS);
        expect(elapsedMs).toBeLessThan(5000);
      } finally {
        close();
      }
    });

    // The words land right after the thread is read, while the selection is still reading the
    // database: nothing is open any more when the wait is asked, and they still reach the model.
    test("words that land after the read and before the render reach the model", async () => {
      clearMediaAnnotations();
      await seedConversation(907);
      first();
      const { seen } = await flush(907, 10_000, undefined, () =>
        stashMediaAnnotation(
          { tenantId, instanceId, messageId: 3 },
          { transcribedText: WORDS },
        ),
      );
      expect(seen[0]).toContain(WORDS);
      expect(seen[0]).not.toContain(MARKER);
    });

    test("the job's deadline ends the wait", async () => {
      clearMediaAnnotations();
      await seedConversation(906);
      first();
      const close = openTranscription({ tenantId, instanceId, messageId: 3 });
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(), 100);
      try {
        const { elapsedMs } = await flush(906, 10_000, deadline.signal);
        expect(elapsedMs).toBeLessThan(5000);
      } finally {
        close();
      }
    });
  },
);
