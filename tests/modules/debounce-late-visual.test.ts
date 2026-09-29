import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  clearMediaAnnotations,
  mediaAnnotationFor,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { reengageConversation } from "@/modules/conversations/reengage";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { debounceDedupeKey } from "@/modules/debounce/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// A file attached after its message was created reaches the flush unread, and the flush opens it
// unless the arrival pass already tried it. Vision is on with no credential, so each attempt writes
// one `vision` stage line through the `no_credential` exit, and counting lines counts attempts.
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
let agentId = 0n;
let visionKeyId = 0n;

// A PNG header declaring its size, which is all the download path reads before the provider.
function png(): ArrayBuffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(800, 16);
  b.writeUInt32BE(600, 20);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const REPLY = "Recebi a imagem.";
const fakeModel = () => new FakeListChatModel({ responses: [REPLY] });

function page(msgs: Array<{ id: number; content: string; anexos?: number[] }>) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content,
      message_type: 0,
      private: false,
      ...(m.anexos
        ? {
            attachments: m.anexos.map((id) => ({
              id,
              file_type: "image",
              data_url: `https://chat.example.com/a/${id}.png`,
            })),
          }
        : {}),
    })),
  };
}

function makeStub(opts: {
  page: unknown;
  sent: Array<[number, string]>;
  onDownload?: () => void;
}) {
  const client = {
    getMessages: async () => opts.page,
    downloadAttachment: async () => {
      opts.onDownload?.();
      return { bytes: png(), contentType: "image/png" };
    },
    updateAttachmentMeta: async () => ({}),
    sendMessage: async (conversationId: number, content: string) => {
      opts.sent.push([conversationId, content]);
      return {};
    },
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
  return async () => client;
}

async function seedConversation(convId: number): Promise<bigint> {
  const c = await suDb.conversation.create({
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
  return c.id;
}

async function flush(
  convId: number,
  pg: unknown,
  opts: {
    abortOnRead?: AbortController;
    abortOnDownload?: AbortController;
    visionFetch?: typeof fetch;
  } = {},
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
  const stub = makeStub({
    page: pg,
    sent,
    onDownload: () => opts.abortOnDownload?.abort(),
  });
  const makeClient = opts.abortOnRead
    ? async () => {
        const client = await stub();
        const read = client.getMessages.bind(client);
        client.getMessages = (async (...args: Parameters<typeof read>) => {
          opts.abortOnRead?.abort();
          return read(...args);
        }) as typeof client.getMessages;
        return client;
      }
    : stub;
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
    ...(opts.abortOnRead ? { signal: opts.abortOnRead.signal } : {}),
    ...(opts.abortOnDownload ? { signal: opts.abortOnDownload.signal } : {}),
    deps: {
      makeModel: fakeModel,
      makeClient,
      checkpointer: new MemorySaver(),
      ...(opts.visionFetch ? { visionFetch: opts.visionFetch } : {}),
    },
  });
  return { out, sent };
}

// The `vision` stage lines of this conversation: one per extraction attempted.
async function visionLines(convDbId: bigint) {
  return flowLogRows(suDb, {
    where: { tenantId, conversationId: convDbId, stage: "vision" },
    select: { status: true },
    orderBy: { id: "asc" },
  });
}

describe.skipIf(!dbUp)(
  "debounce flush: an image attached after its message",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "LV", slug: `lv-${process.pid}` },
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
      const visionKey = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: "vision-key",
          secret: encryptJson("sk-vision"),
        },
        select: { id: true },
      });
      visionKeyId = visionKey.id;
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
          settings: { vision: { enabled: true, provider: "openai" } },
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
          webhookRouteTokenHash: `lv-route-${process.pid}`,
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

    // The stash is keyed by (tenant, instance, messageId) and the cases reuse message ids.
    beforeEach(() => {
      clearMediaAnnotations();
    });

    afterAll(async () => {
      clearMediaAnnotations();
      if (tenantId) {
        await clearFlowLog(suDb, { tenantId });
        for (const table of [
          "scheduler_jobs",
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

    test("the flush reads an image the arrival pass never saw", async () => {
      const id = await seedConversation(9521);
      const { out } = await flush(
        9521,
        page([{ id: 1, content: "", anexos: [11] }]),
      );

      expect(out).toEqual({ outcome: "done" });
      expect((await visionLines(id)).length).toBe(1);
    });

    test("the flush does not pay again for an image the arrival pass tried and could not read", async () => {
      const id = await seedConversation(9522);
      // What `extractMessageVisuals` leaves when every file of the message failed.
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 1 },
        {
          attachmentsUnread: 1,
          unreadFiles: [{ name: null, cause: "failed" }],
        },
      );
      const { out } = await flush(
        9522,
        page([{ id: 1, content: "", anexos: [11] }]),
      );

      expect(out).toEqual({ outcome: "done" });
      expect((await visionLines(id)).length).toBe(0);
    });

    test("the flush does not re-read an image the arrival pass already read", async () => {
      const id = await seedConversation(9523);
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 1 },
        { imageDescription: "um comprovante", attachmentsUnread: 0 },
      );
      const { out } = await flush(
        9523,
        page([{ id: 1, content: "", anexos: [11] }]),
      );

      expect(out).toEqual({ outcome: "done" });
      expect((await visionLines(id)).length).toBe(0);
    });

    test("the flush starts no extraction once the job's deadline has passed", async () => {
      const id = await seedConversation(9525);
      // Aborted on the thread read, which is the last step before the fill.
      const deadline = new AbortController();
      await flush(9525, page([{ id: 1, content: "", anexos: [11] }]), {
        abortOnRead: deadline,
      });

      expect(deadline.signal.aborted).toBe(true);
      expect((await visionLines(id)).length).toBe(0);
    });

    test("the flush starts no provider call when the deadline passes during the download", async () => {
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            vision: {
              enabled: true,
              provider: "openai",
              credentialRef: `vault:${visionKeyId}`,
            },
          },
        },
      });
      try {
        await seedConversation(9526);
        const deadline = new AbortController();
        let providerCalls = 0;
        await flush(9526, page([{ id: 1, content: "", anexos: [11] }]), {
          abortOnDownload: deadline,
          visionFetch: (async () => {
            providerCalls++;
            return new Response(
              JSON.stringify({ choices: [{ message: { content: "lida" } }] }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }) as unknown as typeof fetch,
        });

        expect(deadline.signal.aborted).toBe(true);
        expect(providerCalls).toBe(0);
        // Not marked as tried: the job's retry must still read the file.
        expect(mediaAnnotationFor(tenantId, instanceId, 1)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { settings: { vision: { enabled: true, provider: "openai" } } },
        });
      }
    });

    // The operator's re-engage keeps its own reading: a person asked for the tail to be answered, so a
    // file that failed at arrival is worth one more paid attempt there.
    test("the re-engage still retries an image the arrival pass could not read", async () => {
      const id = await seedConversation(9524);
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 1 },
        {
          attachmentsUnread: 1,
          unreadFiles: [{ name: null, cause: "failed" }],
        },
      );
      const sent: Array<[number, string]> = [];
      const res = await reengageConversation(
        { tenantId, userId: null, role: "TENANT_ADMIN" },
        id,
        {
          makeModel: fakeModel,
          makeClient: makeStub({
            page: page([{ id: 1, content: "", anexos: [11] }]),
            sent,
          }),
          checkpointer: new MemorySaver(),
        },
        appDb,
      );

      expect(res.outcome).toBe("posted");
      expect((await visionLines(id)).length).toBe(1);
    });
  },
);
