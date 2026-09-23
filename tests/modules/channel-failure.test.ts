import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { stashMediaAnnotation } from "@/modules/chatwoot/annotations";
import {
  channelFailureOf,
  mediaFallbackDedupeKey,
  mediaFallbackHandler,
} from "@/modules/chatwoot/channel-failure";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { type ClaimedJob, completeJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// Issue #587: an outgoing attachment the CHANNEL refused after Chatwoot accepted it. The failure
// arrives later, as a `message_updated` carrying `content_attributes.external_error`. A media-class
// code is answered with the same reply as text, once; anything else is a line naming the code.

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

const INBOX_ID = 5871;
const CONV_ID = 58_701;
const BOT_ID = 7;
const REPLY = "Seu pedido sai amanhã às 10h";

let tenantId: bigint;
let instanceId: bigint;
let agentId: bigint;

function updated(
  messageId: number,
  opts: {
    error?: string | null;
    sender?: { type: string; id: number } | null;
    transcribed?: string | null;
    event?: string;
  } = {},
) {
  const n = normalizeChatwootEvent({
    event: opts.event ?? "message_updated",
    id: messageId,
    content: null,
    message_type: "outgoing",
    private: false,
    sender:
      opts.sender === undefined
        ? { type: "agent_bot", id: BOT_ID }
        : opts.sender,
    content_attributes:
      opts.error === null
        ? {}
        : { external_error: opts.error ?? "131053: Media upload error" },
    attachments:
      opts.transcribed === null
        ? []
        : [
            {
              id: messageId * 10,
              file_type: "audio",
              data_url: "https://chat.example/a.ogg",
              transcribed_text: opts.transcribed ?? REPLY,
            },
          ],
    conversation: {
      id: CONV_ID,
      inbox_id: INBOX_ID,
      status: "pending",
      meta: { sender: { id: 31, name: "Cliente" } },
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
  if (!n) throw new Error("unreachable: the fixture is a valid event");
  return n;
}

async function deliver(n: ReturnType<typeof updated>) {
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `cf-${process.pid}-${crypto.randomUUID()}`,
      event: "message_updated",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: row.id,
    agentBotId: BOT_ID,
    normalized: n,
    base: appDb,
    deps: {
      sleep: async () => {},
      makeClient: (async () => {
        throw new Error("the webhook sends nothing itself: the job does");
      }) as never,
      makeModel: () => {
        throw new Error("no model may run on a channel failure");
      },
    },
  });
}

const jobsFor = (messageId: number) =>
  suDb.schedulerJob.findMany({
    where: {
      tenantId,
      kind: "MEDIA_TEXT_FALLBACK",
      dedupeKey: mediaFallbackDedupeKey(instanceId, messageId),
    },
  });

// Every event in this file is on one conversation, so the conversation scopes the read to what the
// file produced and the message id picks the event within it.
const linesFor = async (messageId: number) => {
  const conv = await suDb.conversation.findFirst({
    where: { tenantId, chatwootConversationId: CONV_ID },
    select: { id: true },
  });
  if (!conv) return [];
  return (
    await flowLogRows(suDb, {
      where: { conversationId: conv.id, stage: "channel_error" },
      orderBy: { id: "asc" },
    })
  ).filter(
    (r) => (r.detail as { messageId?: number } | null)?.messageId === messageId,
  );
};

describe("channelFailureOf", () => {
  test("reads the code and the text of the route's own failed audio", () => {
    expect(channelFailureOf(updated(1), BOT_ID)).toEqual({
      messageId: 1,
      conversationId: CONV_ID,
      code: "131053",
      kind: "media",
      text: REPLY,
    });
    expect(
      channelFailureOf(updated(2, { error: "131052: x" }), BOT_ID)?.kind,
    ).toBe("media");
    expect(
      channelFailureOf(
        updated(3, { error: "131026: Message undeliverable" }),
        BOT_ID,
      )?.kind,
    ).toBe("delivery");
    expect(
      channelFailureOf(updated(4, { error: "999999: new" }), BOT_ID)?.kind,
    ).toBe("unknown");
    // A title that names media but carries no code is NOT media: the table is by code.
    expect(
      channelFailureOf(updated(5, { error: "Media upload error" }), BOT_ID),
    ).toMatchObject({ code: null, kind: "unknown" });
  });

  test("anything but the route's own bot's failed outgoing message is not one", () => {
    expect(channelFailureOf(updated(6, { error: null }), BOT_ID)).toBeNull();
    expect(
      channelFailureOf(
        updated(7, { sender: { type: "user", id: BOT_ID } }),
        BOT_ID,
      ),
    ).toBeNull();
    expect(
      channelFailureOf(
        updated(8, { sender: { type: "agent_bot", id: 99 } }),
        BOT_ID,
      ),
    ).toBeNull();
    expect(channelFailureOf(updated(9, { sender: null }), BOT_ID)).toBeNull();
    expect(
      channelFailureOf(updated(10, { event: "message_created" }), BOT_ID),
    ).toBeNull();
    expect(channelFailureOf(updated(11), null)).toBeNull();
  });
});

test("the fallback's key names the Chatwoot instance, so a replaced server cannot collide", () => {
  expect(mediaFallbackDedupeKey(1n, 42)).not.toBe(
    mediaFallbackDedupeKey(2n, 42),
  );
});

describe.skipIf(!dbUp)("a channel failure reported to the bot", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: {
          name: "Falha de canal",
          slug: `channel-failure-${process.pid}`,
        },
      })
    ).id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 5,
        baseUrl: "https://chat.falha.example",
        adminToken: encryptJson("ADMIN"),
      })
    ).id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Voz",
        systemPrompt: "x",
        enabled: true,
        mode: "production",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
      },
      select: { id: true },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: BOT_ID,
        accessToken: encryptJson("BOT-TOKEN"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `cf-route-${process.pid}`,
        name: "Voz",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
        name: "WhatsApp",
        agentId: agent.id,
      },
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    await clearFlowLog(suDb, { tenantId });
    await suDb.tenant.delete({ where: { id: tenantId } });
  });

  test("a media failure arms the reply as text, and the line names what was done", async () => {
    await deliver(updated(9001));
    const jobs = await jobsFor(9001);
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(
      job?.payloadSecret ? decryptJson<string>(job.payloadSecret) : null,
    ).toBe(REPLY);
    // The reply never rides the Json payload.
    expect(JSON.stringify(job?.payload)).not.toContain("pedido");
    const lines = await linesFor(9001);
    expect(lines.map((l) => [l.level, l.detail])).toEqual([
      [
        "warn",
        {
          messageId: 9001,
          code: "131053",
          codeRead: true,
          class: "media",
          action: "text_fallback",
        },
      ],
    ]);
    expect(
      JSON.stringify(lines, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toContain("Media upload error");
  });

  // The fake Chatwoot the job talks to: what the conversation looks like NOW, what its latest page
  // holds, and every send it receives.
  function fakeChatwoot(opts: {
    status?: string;
    assignee?: { type: string; id: number } | null;
    recentSendIds?: string[];
    filler?: number;
    unreadable?: boolean;
    emptyPage?: boolean;
    onRead?: () => Promise<void>;
    onLive?: () => Promise<void>;
    liveInbox?: number;
  }) {
    const sent: {
      conv: number;
      text: string;
      private: boolean;
      sendId: string | null;
    }[] = [];
    let token = "";
    const makeClient = (async (cfg: { botToken: string }) => {
      token = cfg.botToken;
      return {
        getConversation: async () => {
          await opts.onLive?.();
          return {
            id: CONV_ID,
            inbox_id: opts.liveInbox ?? INBOX_ID,
            last_activity_at: Math.floor(Date.now() / 1000) - 60,
            status: opts.status ?? "pending",
            meta: {
              assignee: opts.assignee
                ? { id: opts.assignee.id, type: opts.assignee.type }
                : null,
              assignee_type: opts.assignee?.type ?? null,
            },
            assignee_type: opts.assignee?.type ?? null,
            assignee_id: opts.assignee?.id ?? null,
          };
        },
        // Pages the way Chatwoot does: the latest ~20, or the ~20 older than `before`. The thread is
        // the failed voice note, `filler` newer messages, and the named sends.
        getMessages: async (_c: number, o?: { before?: number }) => {
          await opts.onRead?.();
          if (opts.unreadable) return {};
          if (opts.emptyPage) return { payload: [] };
          const thread = [
            { id: 9001, sendId: null as string | null },
            ...Array.from({ length: opts.filler ?? 0 }, (_, i) => ({
              id: 10_000 + i,
              sendId: null as string | null,
            })),
            ...(opts.recentSendIds ?? []).map((sendId, i) => ({
              id: 9_500 + i,
              sendId,
            })),
          ]
            .sort((a, b) => a.id - b.id)
            .filter((m) => o?.before === undefined || m.id < o.before);
          return {
            payload: thread.slice(-20).map((m) => ({
              id: m.id,
              content: REPLY,
              message_type: 1,
              private: false,
              created_at: Math.floor(Date.now() / 1000),
              sender: { type: "agent_bot", id: BOT_ID },
              content_attributes: m.sendId
                ? { fazer_ai_send_id: m.sendId }
                : {},
            })),
          };
        },
        sendMessage: async (
          conv: number,
          text: string,
          o?: { private?: boolean; sendId?: string },
        ) => {
          // The customer has to READ it: a private note would be the team talking to itself.
          sent.push({
            conv,
            text,
            private: o?.private === true,
            sendId: o?.sendId ?? null,
          });
          return {};
        },
      } as unknown as ChatwootClient;
    }) as never;
    return { sent, makeClient, token: () => token };
  }

  async function claimed(messageId: number): Promise<ClaimedJob> {
    const [row] = await jobsFor(messageId);
    if (!row) throw new Error("the job was not armed");
    return {
      id: row.id,
      tenantId,
      kind: "MEDIA_TEXT_FALLBACK",
      payload: row.payload as Record<string, unknown>,
      payloadSecret: row.payloadSecret,
      attempts: 0,
      claimSeq: row.claimSeq,
    };
  }

  test("the job sends the text once, under the bot's token, to the conversation", async () => {
    const cw = fakeChatwoot({});
    const out = await mediaFallbackHandler(
      await claimed(9001),
      appDb,
      cw.makeClient,
    );
    expect(out).toEqual({ outcome: "done" });
    expect(cw.sent).toEqual([
      {
        conv: CONV_ID,
        text: REPLY,
        private: false,
        sendId: "media-fallback:9001",
      },
    ]);
    expect(cw.token()).toBe("BOT-TOKEN");
  });

  test("a job that runs again after its send landed does not send twice", async () => {
    const cw = fakeChatwoot({ recentSendIds: ["media-fallback:9001"] });
    const out = await mediaFallbackHandler(
      await claimed(9001),
      appDb,
      cw.makeClient,
    );
    expect(out).toEqual({ outcome: "done" });
    expect(cw.sent).toEqual([]);
  });

  test("a rerun finds its earlier send even when newer messages pushed it off the latest page", async () => {
    const found = fakeChatwoot({
      recentSendIds: ["media-fallback:9001"],
      filler: 45,
    });
    await mediaFallbackHandler(await claimed(9001), appDb, found.makeClient);
    expect(found.sent).toEqual([]);
    // ...and the same busy conversation with no earlier send does get the text: reaching the failed
    // message is what proves there is none.
    const absent = fakeChatwoot({ filler: 45 });
    await mediaFallbackHandler(await claimed(9001), appDb, absent.makeClient);
    expect(absent.sent).toHaveLength(1);
    // Too busy to reach the failed message at all: nothing, rather than a possible duplicate.
    const lost = fakeChatwoot({ filler: 200 });
    await mediaFallbackHandler(await claimed(9001), appDb, lost.makeClient);
    expect(lost.sent).toEqual([]);
  });

  test("a page that did not read is not proof the send is missing: the job throws to retry", async () => {
    const cw = fakeChatwoot({ unreadable: true });
    await expect(
      mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient),
    ).rejects.toThrow();
    expect(cw.sent).toEqual([]);
  });

  test("a conversation Chatwoot already moved to another inbox gets nothing under the old persona", async () => {
    const cw = fakeChatwoot({ liveInbox: INBOX_ID + 1 });
    await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
    expect(cw.sent).toEqual([]);
  });

  test("past the WhatsApp 24h window the text does not go out", async () => {
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: INBOX_ID },
      data: { channelType: "Channel::Whatsapp", provider: "whatsapp_cloud" },
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: CONV_ID },
      data: { lastInboundAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    try {
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
      // ...and inside it, it does.
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { lastInboundAt: new Date() },
      });
      const inside = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, inside.makeClient);
      expect(inside.sent).toHaveLength(1);
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        data: { channelType: null, provider: null },
      });
    }
  });

  test("a colleague's reply claimed the conversation before Chatwoot's toggle landed: nothing from the bot", async () => {
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: CONV_ID },
      data: {
        status: "open",
        statusClaimUntil: new Date(Date.now() + 60_000),
        statusClaimFrom: "pending",
      },
    });
    try {
      // Chatwoot still answers `pending`: its toggle is on the wire.
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: {
          status: "pending",
          statusClaimUntil: null,
          statusClaimFrom: null,
        },
      });
    }
  });

  test("a takeover the mirror recorded after Chatwoot's snapshot was taken stops the send", async () => {
    const cw = fakeChatwoot({
      onLive: async () => {
        // The takeover webhook commits while the GET is in flight: newer than the snapshot.
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: {
            assigneeType: "User",
            assigneeId: 3,
            lastEventAt: new Date(Date.now() + 3_600_000),
          },
        });
      },
    });
    try {
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { assigneeType: null, assigneeId: null, lastEventAt: new Date() },
      });
    }
  });

  test("a reply longer than the channel takes in one message is not sent to be refused", async () => {
    const job = {
      ...(await claimed(9001)),
      payloadSecret: encryptJson("a".repeat(4_097)),
    };
    const cw = fakeChatwoot({});
    await mediaFallbackHandler(job, appDb, cw.makeClient);
    expect(cw.sent).toEqual([]);
  });

  test("a job whose body a reset forgot finishes without sending", async () => {
    const job = { ...(await claimed(9001)), payloadSecret: null };
    const cw = fakeChatwoot({});
    expect(await mediaFallbackHandler(job, appDb, cw.makeClient)).toEqual({
      outcome: "done",
    });
    expect(cw.sent).toEqual([]);
  });

  test("an empty first page is not proof the send is missing either", async () => {
    const cw = fakeChatwoot({ emptyPage: true });
    await expect(
      mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient),
    ).rejects.toThrow();
    expect(cw.sent).toEqual([]);
  });

  test("a signature the agent carries is on the text, as on any text reply", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          signature: { enabled: true, text: "Equipe Voz", position: "bottom" },
        },
      },
    });
    try {
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent.map((m) => m.text)).toEqual([`${REPLY}\n\nEquipe Voz`]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: {} },
      });
    }
  });

  test("an inbox handed to another agent, or a test agent on a conversation never activated, gets nothing", async () => {
    const other = await suDb.agent.create({
      data: { tenantId, name: "Outro", systemPrompt: "x", settings: {} },
      select: { id: true },
    });
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: INBOX_ID },
      data: { agentId: other.id },
    });
    try {
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        data: { agentId },
      });
    }
    await suDb.agent.update({ where: { id: agentId }, data: { mode: "test" } });
    try {
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production" },
      });
    }
  });

  test("a reset that lands while the job reads the conversation still stops the send", async () => {
    const cw = fakeChatwoot({
      onRead: async () => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { resetAtMessageId: 9001 },
        });
      },
    });
    try {
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { resetAtMessageId: null },
      });
    }
  });

  test("a reset that lands while the job reads who owns the conversation still stops the send", async () => {
    const cw = fakeChatwoot({
      onLive: async () => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { resetAtMessageId: 9001 },
        });
      },
    });
    try {
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { resetAtMessageId: null },
      });
    }
  });

  test("a finished job keeps its key and drops the reply it carried", async () => {
    const [row] = await jobsFor(9001);
    if (!row) throw new Error("the job was not armed");
    await suDb.schedulerJob.update({
      where: { id: row.id },
      data: { status: "CLAIMED" },
    });
    await completeJob(
      tenantId,
      row.id,
      row.claimSeq,
      "MEDIA_TEXT_FALLBACK",
      appDb,
    );
    const after = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("DONE");
    expect(after.dedupeKey).toBe(mediaFallbackDedupeKey(instanceId, 9001));
    expect(after.payloadSecret).toBeNull();
    // Back to what the tests below expect to claim.
    await suDb.schedulerJob.update({
      where: { id: row.id },
      data: { status: "PENDING", payloadSecret: encryptJson(REPLY) },
    });
  });

  test("an upstream Chatwoot with no transcription on the attachment still gets the text this process spoke", async () => {
    stashMediaAnnotation(
      { tenantId, instanceId, messageId: 9010 },
      { transcribedText: REPLY },
    );
    await deliver(updated(9010, { transcribed: null }));
    const [job] = await jobsFor(9010);
    expect(
      job?.payloadSecret ? decryptJson<string>(job.payloadSecret) : null,
    ).toBe(REPLY);
  });

  test("a monitoring agent, or a conversation reset after the failure, gets nothing", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: { mode: "monitoring" },
    });
    try {
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production" },
      });
    }
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: CONV_ID },
      data: { resetAtMessageId: 9001 },
    });
    try {
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { resetAtMessageId: null },
      });
    }
  });

  test("an agent switched off or an account disconnected while the job waited sends nothing", async () => {
    const agentRow = await suDb.agent.update({
      where: { id: agentId },
      data: { enabled: false },
    });
    try {
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentRow.id },
        data: { enabled: true },
      });
    }
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: new Date() },
    });
    try {
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(await claimed(9001), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.chatwootInstance.update({
        where: { id: instanceId },
        data: { disconnectedAt: null },
      });
    }
  });

  test("a conversation a person or another bot took in the meantime gets nothing from this bot", async () => {
    for (const state of [
      { status: "open" },
      { status: "pending", assignee: { type: "User", id: 3 } },
      { status: "pending", assignee: { type: "AgentBot", id: 99 } },
    ]) {
      const cw = fakeChatwoot(state);
      const out = await mediaFallbackHandler(
        await claimed(9001),
        appDb,
        cw.makeClient,
      );
      expect(out).toEqual({ outcome: "done" });
      expect(cw.sent).toEqual([]);
    }
  });

  test("the line is the agent's, so the Logs page filtered by agent shows it", async () => {
    const [line] = await linesFor(9001);
    expect(line?.agentId).toBe(agentId);
  });

  test("a redelivery, before or after the text went out, arms nothing new", async () => {
    await deliver(updated(9002));
    await deliver(updated(9002));
    let jobs = await jobsFor(9002);
    expect(jobs).toHaveLength(1);
    // As if the job had run: a later redelivery must not put it back to PENDING.
    await suDb.schedulerJob.update({
      where: { id: jobs[0]?.id },
      data: { status: "DONE" },
    });
    await deliver(updated(9002));
    jobs = await jobsFor(9002);
    expect(jobs.map((j) => j.status)).toEqual(["DONE"]);
  });

  test("a /reset retires the conversation's pending fallback and forgets every body, keeping the keys", async () => {
    await deliver(updated(9030));
    await deliver(updated(9031));
    const [dead] = await jobsFor(9031);
    if (!dead) throw new Error("the job was not armed");
    await suDb.schedulerJob.update({
      where: { id: dead.id },
      data: { status: "DEAD" },
    });
    await deliver(updated(9032));
    const [running] = await jobsFor(9032);
    if (!running) throw new Error("the job was not armed");
    await suDb.schedulerJob.update({
      where: { id: running.id },
      data: { status: "CLAIMED" },
    });
    await suDb.agent.update({ where: { id: agentId }, data: { mode: "test" } });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: CONV_ID },
      data: { testActivatedAt: new Date() },
    });
    try {
      const reset = normalizeChatwootEvent({
        event: "message_created",
        id: 9040,
        content: "/reset",
        message_type: "incoming",
        private: false,
        sender: { type: "contact", id: 31 },
        conversation: {
          id: CONV_ID,
          inbox_id: INBOX_ID,
          status: "pending",
          meta: { sender: { id: 31, name: "Cliente" } },
          last_activity_at: Math.floor(Date.now() / 1000),
        },
      });
      if (!reset) throw new Error("unreachable");
      await deliver(reset);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production" },
      });
    }
    const pending = (await jobsFor(9030))[0];
    const after = (await jobsFor(9031))[0];
    expect(pending?.status).toBe("DONE");
    expect(pending?.payloadSecret).toBeNull();
    expect(after?.status).toBe("DEAD");
    expect(after?.payloadSecret).toBeNull();
    // A claimed one keeps its claim and loses its body: whatever becomes of the claim, the words go.
    const claimedRow = (await jobsFor(9032))[0];
    expect(claimedRow?.status).toBe("CLAIMED");
    expect(claimedRow?.payloadSecret).toBeNull();
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: CONV_ID },
      data: { resetAtMessageId: null, testActivatedAt: null },
    });
  });

  test("a delivery-class failure sends nothing and names the code", async () => {
    await deliver(updated(9003, { error: "131026: Message undeliverable" }));
    expect(await jobsFor(9003)).toHaveLength(0);
    expect((await linesFor(9003)).map((l) => l.detail)).toEqual([
      {
        messageId: 9003,
        code: "131026",
        codeRead: true,
        class: "delivery",
        action: "none",
      },
    ]);
  });

  test("an unknown or unreadable code sends nothing and says so", async () => {
    await deliver(updated(9004, { error: "999999: Some future error" }));
    await deliver(updated(9005, { error: "Media upload error" }));
    expect(await jobsFor(9004)).toHaveLength(0);
    expect(await jobsFor(9005)).toHaveLength(0);
    expect((await linesFor(9004))[0]?.detail).toMatchObject({
      code: "999999",
      class: "unknown",
      action: "none",
    });
    expect((await linesFor(9005))[0]?.detail).toMatchObject({
      code: null,
      codeRead: false,
      class: "unknown",
    });
  });

  test("a media failure with no text to send says that, and sends nothing", async () => {
    await deliver(updated(9006, { transcribed: null }));
    expect(await jobsFor(9006)).toHaveLength(0);
    expect((await linesFor(9006))[0]?.detail).toMatchObject({
      code: "131053",
      class: "media",
      action: "no_text",
    });
  });

  test("a failure on a message the bot did not send is ignored", async () => {
    await deliver(updated(9007, { sender: { type: "user", id: 3 } }));
    await deliver(updated(9008, { sender: { type: "agent_bot", id: 99 } }));
    for (const id of [9007, 9008]) {
      expect(await jobsFor(id)).toHaveLength(0);
      expect(await linesFor(id)).toHaveLength(0);
    }
  });
});
