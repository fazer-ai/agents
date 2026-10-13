import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { stashMediaAnnotation } from "@/modules/chatwoot/annotations";
import {
  channelFailureOf,
  mediaFallbackDedupeKey,
  mediaFallbackHandler,
  newerThanFailure,
  RATE_LIMITED_RESEND_DELAY_MS,
  RESEND_DELAY_MS,
} from "@/modules/chatwoot/channel-failure";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  CHATWOOT_REPLY_BY_OPERATOR_KEY,
  CHATWOOT_REPLY_TEXT_KEY,
  CHATWOOT_SEND_ID_KEY,
} from "@/modules/chatwoot/constants";
import { parseChatwootMessages } from "@/modules/chatwoot/messages";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { type ClaimedJob, completeJob } from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// An outgoing attachment the CHANNEL refused after Chatwoot accepted it. The failure
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
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
    // The whole reply the voice note carries when its speech left an item out.
    replyText?: string;
    byOperator?: boolean;
    event?: string;
    // A TEXT reply: its content, with no voice note attached.
    content?: string;
    // A file other than a voice note, which a caption alone does not replace.
    image?: boolean;
    // The send id the message went out with, when it was one of ours.
    sendId?: string;
  } = {},
) {
  const n = normalizeChatwootEvent({
    event: opts.event ?? "message_updated",
    id: messageId,
    content: opts.content ?? null,
    message_type: "outgoing",
    private: false,
    sender:
      opts.sender === undefined
        ? { type: "agent_bot", id: BOT_ID }
        : opts.sender,
    content_attributes: {
      ...(opts.error === null
        ? {}
        : { external_error: opts.error ?? "131053: Media upload error" }),
      ...(opts.replyText === undefined
        ? {}
        : { [CHATWOOT_REPLY_TEXT_KEY]: opts.replyText }),
      ...(opts.byOperator ? { [CHATWOOT_REPLY_BY_OPERATOR_KEY]: true } : {}),
      ...(opts.sendId ? { [CHATWOOT_SEND_ID_KEY]: opts.sendId } : {}),
    },
    attachments: opts.image
      ? [
          {
            id: messageId * 10,
            file_type: "image",
            data_url: "https://chat.example/a.png",
          },
        ]
      : opts.transcribed === null || opts.content !== undefined
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
      byOperator: false,
      rendered: false,
      wasResend: false,
      replyKey: null,
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
    // NOTE: A title that names media but carries no code is NOT media: the table is by code.
    expect(
      channelFailureOf(updated(5, { error: "Media upload error" }), BOT_ID),
    ).toMatchObject({ code: null, kind: "unknown" });
  });

  // The Cloud API sends some codes in parentheses, and a regex anchored on a leading number read
  // none of them: 131000 arrived as `code: null` and was dropped as unknown.
  test("the code is read from the parenthesised form as from the leading one", () => {
    const read = (error: string) =>
      channelFailureOf(updated(20, { error }), BOT_ID);
    expect(read("(#131000) Something went wrong")).toMatchObject({
      code: "131000",
      kind: "unknown",
    });
    expect(read("(#2) Service temporarily unavailable")?.code).toBe("2");
    expect(read("(#368) Temporarily blocked")).toMatchObject({
      code: "368",
      kind: "account",
    });
    expect(read("(#130429) Rate limit hit")?.kind).toBe("rate_limit");
    // NOTE: A number later in the sentence is not the code.
    expect(read("Something went wrong (#131000)")?.code).toBeNull();
  });

  test("a text reply is its own content, and a reply with a file has no text to resend", () => {
    expect(
      channelFailureOf(
        updated(21, { error: "(#131000) x", content: "Até amanhã, {{nome}}" }),
        BOT_ID,
      )?.text,
    ).toBe("Até amanhã, {{nome}}");
    expect(
      channelFailureOf(
        updated(22, {
          error: "(#131000) x",
          content: "a legenda",
          image: true,
        }),
        BOT_ID,
      )?.text,
    ).toBeNull();
  });

  test("a failure on one of our resends is known to be one", () => {
    const of = (sendId?: string) =>
      channelFailureOf(updated(23, { error: "(#131000) x", sendId }), BOT_ID)
        ?.wasResend;
    expect(of("channel-resend:9")).toBe(true);
    expect(of("reply:k1:channel-resend:9")).toBe(true);
    expect(of("reply:k1:media-fallback:9")).toBe(true);
    expect(of("media-fallback:9")).toBe(true);
    // NOTE: The send ids of every first reply are not resends.
    expect(of("turn:abc:0")).toBe(false);
    expect(of()).toBe(false);
  });

  // A voice note whose words were the operator's says so, and the text that replaces it keeps them.
  test("a voice note of the operator's words is read as such", () => {
    expect(
      channelFailureOf(updated(13, { byOperator: true }), BOT_ID)?.byOperator,
    ).toBe(true);
  });

  // The transcription is the speech, which has holes where a URL or an address was left out.
  test("the whole reply the voice note carries is the text, not the speech with holes", () => {
    const holed = "Acompanhe seu pedido em a qualquer momento";
    const whole =
      "Acompanhe seu pedido em https://x.com.br/p/1 a qualquer momento";
    expect(
      channelFailureOf(
        updated(12, { transcribed: holed, replyText: whole }),
        BOT_ID,
      )?.text,
    ).toBe(whole);
    // NOTE: A blank one is no reply: the transcription is still the text.
    expect(
      channelFailureOf(
        updated(13, { transcribed: holed, replyText: "  " }),
        BOT_ID,
      )?.text,
    ).toBe(holed);
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

// The server log is where a skipped resend is explained, so each cause names itself.
test("what came after a failed reply names why its resend is skipped", () => {
  const after = (rows: Record<string, unknown>[]) =>
    newerThanFailure(
      parseChatwootMessages({
        payload: [
          { id: 1, content: "x", message_type: 1, private: false },
          ...rows.map((r, i) => ({
            id: 2 + i,
            content: "y",
            private: false,
            ...r,
          })),
        ],
      }),
      1,
    );
  expect(after([])).toBeNull();
  // A reaction answers nothing, and an imported row is old history with a new id.
  expect(
    after([
      {
        message_type: 1,
        sender: { type: "user", id: 3 },
        content_attributes: { is_reaction: true },
      },
      {
        message_type: 0,
        sender: { type: "contact", id: 31 },
        content_attributes: { imported: true },
      },
    ]),
  ).toBeNull();
  expect(
    after([{ message_type: 0, sender: { type: "contact", id: 31 } }]),
  ).toBe("the customer wrote after the failed reply");
  expect(
    after([{ message_type: 1, sender: { type: "agent_bot", id: BOT_ID } }]),
  ).toBe("the bot already sent something newer");
  expect(after([{ message_type: 1, sender: { type: "user", id: 3 } }])).toBe(
    "a person already sent something newer",
  );
  // The rest of the same reply (the balloon after it, the text after a voice note) is not newer.
  const bot = (sendId: string) => ({
    message_type: 1,
    sender: { type: "agent_bot", id: BOT_ID },
    content_attributes: { fazer_ai_send_id: sendId },
  });
  const rows = parseChatwootMessages({
    payload: [
      { id: 1, content: "x", message_type: 1, private: false },
      { id: 2, content: "y", private: false, ...bot("reply:k1:b") },
    ],
  });
  expect(newerThanFailure(rows, 1, "k1")).toBeNull();
  expect(newerThanFailure(rows, 1, "k2")).toBe(
    "the bot already sent something newer",
  );
  expect(newerThanFailure(rows, 1, null)).toBe(
    "the bot already sent something newer",
  );
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
    // NOTE: The reply never rides the Json payload.
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

  test("a voice note whose speech left a link out arms the whole reply, link included (#792)", async () => {
    const whole = `${REPLY}, acompanhe em https://x.com.br/p/1`;
    await deliver(
      updated(9002, {
        transcribed: `${REPLY}, acompanhe em`,
        replyText: whole,
      }),
    );
    const [job] = await jobsFor(9002);
    expect(
      job?.payloadSecret ? decryptJson<string>(job.payloadSecret) : null,
    ).toBe(whole);
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
    // The failed message the thread is built around, and what the conversation received after it.
    failedId?: number;
    after?: {
      messageType: number;
      sender: { type: string; id: number } | null;
      private?: boolean;
      sendId?: string;
    }[];
    // Messages that land only once the job has read the conversation live.
    afterLive?: {
      messageType: number;
      sender: { type: string; id: number } | null;
      reaction?: boolean;
    }[];
  }) {
    const sent: {
      conv: number;
      text: string;
      private: boolean;
      sendId: string | null;
    }[] = [];
    let token = "";
    let readLive = false;
    const makeClient = (async (cfg: { botToken: string }) => {
      token = cfg.botToken;
      return {
        getConversation: async () => {
          readLive = true;
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
        // NOTE: Pages the way Chatwoot does: the latest ~20, or the ~20 older than `before`. The thread is
        // the failed voice note, `filler` newer messages, and the named sends.
        getMessages: async (_c: number, o?: { before?: number }) => {
          await opts.onRead?.();
          if (opts.unreadable) return {};
          if (opts.emptyPage) return { payload: [] };
          const failedId = opts.failedId ?? 9001;
          type Row = {
            id: number;
            sendId: string | null;
            messageType?: number;
            sender?: { type: string; id: number } | null;
            private?: boolean;
          };
          const thread: Row[] = [
            { id: failedId, sendId: null },
            ...(opts.after ?? []).map((m, i) => ({
              ...m,
              id: failedId + 1 + i,
              sendId: m.sendId ?? null,
            })),
            ...(readLive ? (opts.afterLive ?? []) : []).map((m, i) => ({
              ...m,
              id: failedId + 50 + i,
              sendId: null,
            })),
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
              message_type: m.messageType ?? 1,
              private: m.private === true,
              created_at: Math.floor(Date.now() / 1000),
              sender:
                m.sender === undefined
                  ? { type: "agent_bot", id: BOT_ID }
                  : m.sender,
              content_attributes: {
                ...(m.sendId ? { fazer_ai_send_id: m.sendId } : {}),
                ...("reaction" in m && m.reaction ? { is_reaction: true } : {}),
              },
            })),
          };
        },
        sendMessage: async (
          conv: number,
          text: string,
          o?: { private?: boolean; sendId?: string },
        ) => {
          // NOTE: The customer has to READ it: a private note would be the team talking to itself.
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
      // NOTE: ...and inside it, it does.
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
        // NOTE: The takeover webhook commits while the GET is in flight: newer than the snapshot.
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

  // The text replacing the voice note is the model's reply, which Chatwoot renders as
  // Liquid, so it goes escaped; the operator's signature keeps its own Liquid.
  test("the model's text goes escaped and the signature's Liquid is left alone", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          signature: {
            enabled: true,
            text: "Att {{contact.name}}",
            position: "bottom",
          },
        },
      },
    });
    try {
      const cw = fakeChatwoot({});
      await mediaFallbackHandler(
        {
          ...(await claimed(9001)),
          payloadSecret: encryptJson("Seu cadastro: {{contact.email}} fim"),
        },
        appDb,
        cw.makeClient,
      );
      expect(cw.sent.map((m) => m.text)).toEqual([
        "Seu cadastro: {{ '{{' }}contact.email}} fim\n\nAtt {{contact.name}}",
      ]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: {} },
      });
    }
  });

  // The operator's words (a guardrail template spoken as audio) keep Chatwoot's Liquid in the text.
  test("an operator's text replacing the voice note is sent as written", async () => {
    const cw = fakeChatwoot({});
    const job = await claimed(9001);
    await mediaFallbackHandler(
      {
        ...job,
        payload: { ...(job.payload as object), byOperator: true },
        payloadSecret: encryptJson("Olá {{contact.name}}"),
      },
      appDb,
      cw.makeClient,
    );
    expect(cw.sent.map((m) => m.text)).toEqual(["Olá {{contact.name}}"]);
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
    // NOTE: Back to what the tests below expect to claim.
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
    // NOTE: As if the job had run: a later redelivery must not put it back to PENDING.
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

  // The production case: a text reply refused with 131000 was dropped as unknown, and the customer
  // never got the answer. Every code nobody listed as permanent is resent once, after a delay.
  test("a refusal not known to be permanent arms the same reply, after a delay", async () => {
    const text = "O plano custa R$ 89 por mês";
    const before = Date.now();
    await deliver(
      updated(9004, { error: "(#131000) Something went wrong", content: text }),
    );
    await deliver(updated(9005, { error: "999999: Some future error" }));
    await deliver(
      updated(9009, { error: "(#130429) Rate limit hit", content: text }),
    );
    const [generic] = await jobsFor(9004);
    expect(
      generic?.payloadSecret
        ? decryptJson<string>(generic.payloadSecret)
        : null,
    ).toBe(text);
    expect(generic?.payload).toMatchObject({ messageId: 9004, resend: true });
    expect(generic?.runAt.getTime()).toBeGreaterThanOrEqual(
      before + RESEND_DELAY_MS,
    );
    expect(await jobsFor(9005)).toHaveLength(1);
    const [limited] = await jobsFor(9009);
    expect(limited?.runAt.getTime()).toBeGreaterThanOrEqual(
      before + RATE_LIMITED_RESEND_DELAY_MS,
    );
    expect((await linesFor(9004))[0]?.detail).toEqual({
      messageId: 9004,
      code: "131000",
      codeRead: true,
      class: "unknown",
      action: "resend",
    });
    expect((await linesFor(9009))[0]?.detail).toMatchObject({
      class: "rate_limit",
      action: "resend",
    });
  });

  test("a refusal the channel documents as permanent arms nothing", async () => {
    await deliver(
      updated(9110, { error: "(#368) Temporarily blocked", content: "x" }),
    );
    await deliver(
      updated(9111, { error: "(#131047) Re-engagement message", content: "x" }),
    );
    expect(await jobsFor(9110)).toHaveLength(0);
    expect(await jobsFor(9111)).toHaveLength(0);
    expect((await linesFor(9110))[0]?.detail).toMatchObject({
      class: "account",
      action: "none",
    });
    expect((await linesFor(9111))[0]?.detail).toMatchObject({
      class: "delivery",
      action: "none",
    });
  });

  test("the refusal of a resend is not resent a third time, and the line says so", async () => {
    await deliver(
      updated(9012, {
        error: "(#131000) Something went wrong",
        content: "x",
        sendId: "channel-resend:9004",
      }),
    );
    expect(await jobsFor(9012)).toHaveLength(0);
    expect((await linesFor(9012))[0]?.detail).toMatchObject({
      code: "131000",
      action: "not_resent",
    });
  });

  test("the resend goes out as the customer would have read it, with no second signature", async () => {
    const text = "Até amanhã, {{nome}}. Equipe Loja";
    await deliver(
      updated(9013, { error: "(#131000) Something went wrong", content: text }),
    );
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          signature: { enabled: true, text: "Equipe Loja", position: "bottom" },
        },
      },
    });
    try {
      const cw = fakeChatwoot({ failedId: 9013 });
      await mediaFallbackHandler(await claimed(9013), appDb, cw.makeClient);
      expect(cw.sent).toEqual([
        {
          conv: CONV_ID,
          text: "Até amanhã, {{ '{{' }}nome}}. Equipe Loja",
          private: false,
          sendId: "channel-resend:9013",
        },
      ]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: {} },
      });
    }
  });

  // A voice note refused with a code outside the media list is resent too, and its words are the
  // words it was spoken from: signed, as the media text is, not escaped as rendered content.
  test("a voice note refused with an unlisted code resends its words as the media text would", async () => {
    await deliver(updated(9015, { error: "(#131000) Something went wrong" }));
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          signature: { enabled: true, text: "Equipe Voz", position: "bottom" },
        },
      },
    });
    try {
      const cw = fakeChatwoot({ failedId: 9015 });
      await mediaFallbackHandler(await claimed(9015), appDb, cw.makeClient);
      expect(cw.sent.map((m) => [m.text, m.sendId])).toEqual([
        [`${REPLY}\n\nEquipe Voz`, "channel-resend:9015"],
      ]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: {} },
      });
    }
  });

  // A voice note refused while the text after it landed: that text is the rest of the same reply,
  // and the spoken part still has to reach the customer.
  test("the rest of the same reply does not cancel the resend, a newer reply does", async () => {
    await deliver(
      updated(9017, { error: "(#131000) x", sendId: "reply:k17:audio" }),
    );
    const sameReply = fakeChatwoot({
      failedId: 9017,
      after: [
        {
          messageType: 1,
          sender: { type: "agent_bot", id: BOT_ID },
          sendId: "reply:k17:text",
        },
      ],
    });
    await mediaFallbackHandler(
      await claimed(9017),
      appDb,
      sameReply.makeClient,
    );
    expect(sameReply.sent).toHaveLength(1);
    const newer = fakeChatwoot({
      failedId: 9017,
      after: [
        {
          messageType: 1,
          sender: { type: "agent_bot", id: BOT_ID },
          sendId: "reply:k99:text",
        },
      ],
    });
    await mediaFallbackHandler(await claimed(9017), appDb, newer.makeClient);
    expect(newer.sent).toEqual([]);
  });

  // Two balloons of one reply refused: the first one's resend landing must not read as a newer reply
  // to the second one's job, so the replacement keeps the reply's key.
  test("a sibling's resend is still the same reply, and carries the key forward", async () => {
    await deliver(
      updated(9018, {
        error: "(#131000) x",
        content: "a",
        sendId: "reply:k18:a",
      }),
    );
    const first = fakeChatwoot({ failedId: 9018 });
    await mediaFallbackHandler(await claimed(9018), appDb, first.makeClient);
    expect(first.sent.map((m) => m.sendId)).toEqual([
      "reply:k18:channel-resend:9018",
    ]);
    await deliver(
      updated(9019, {
        error: "(#131000) x",
        content: "b",
        sendId: "reply:k18:b",
      }),
    );
    const second = fakeChatwoot({
      failedId: 9019,
      after: [
        {
          messageType: 1,
          sender: { type: "agent_bot", id: BOT_ID },
          sendId: "reply:k18:channel-resend:9018",
        },
      ],
    });
    await mediaFallbackHandler(await claimed(9019), appDb, second.makeClient);
    expect(second.sent).toHaveLength(1);
  });

  // A customer message that lands while the job reads who owns the conversation is not on the
  // pages read before; the latest page, read again after those reads, has it. A reaction does not
  // count there either.
  test("a customer message landing during the ownership reads stops the resend, a reaction does not", async () => {
    await deliver(updated(9016, { error: "(#131000) x", content: "x" }));
    const wrote = fakeChatwoot({
      failedId: 9016,
      afterLive: [{ messageType: 0, sender: { type: "contact", id: 31 } }],
    });
    await mediaFallbackHandler(await claimed(9016), appDb, wrote.makeClient);
    expect(wrote.sent).toEqual([]);
    const reacted = fakeChatwoot({
      failedId: 9016,
      afterLive: [
        { messageType: 0, sender: { type: "contact", id: 31 }, reaction: true },
      ],
    });
    await mediaFallbackHandler(await claimed(9016), appDb, reacted.makeClient);
    expect(reacted.sent).toHaveLength(1);
  });

  // The latest page is read again after the live read; a person taking the conversation while that
  // read is in flight is caught by the mirror, read after it.
  test("a takeover landing during the resend's last page read stops it", async () => {
    await deliver(updated(9020, { error: "(#131000) x", content: "x" }));
    let live = false;
    const cw = fakeChatwoot({
      failedId: 9020,
      onLive: async () => {
        live = true;
      },
      onRead: async () => {
        if (!live) return;
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
      await mediaFallbackHandler(await claimed(9020), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    } finally {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { assigneeType: null, assigneeId: null, lastEventAt: new Date() },
      });
    }
  });

  // The next turn answers a customer who wrote again, with fresh context; a newer reply already
  // moved the conversation on. Either way the old reply would arrive out of place.
  test("a resend is skipped when the conversation received anything after the failure", async () => {
    await deliver(updated(9014, { error: "(#131000) x", content: "x" }));
    for (const after of [
      { messageType: 0, sender: { type: "contact", id: 31 } },
      { messageType: 1, sender: { type: "agent_bot", id: BOT_ID } },
      { messageType: 1, sender: { type: "user", id: 3 } },
    ]) {
      const cw = fakeChatwoot({ failedId: 9014, after: [after] });
      await mediaFallbackHandler(await claimed(9014), appDb, cw.makeClient);
      expect(cw.sent).toEqual([]);
    }
    // A customer message pushed off the latest page by the team's notes is still found: the read-back
    // pages down to the failed reply, not only the newest page.
    const buried = fakeChatwoot({
      failedId: 9014,
      after: [
        { messageType: 0, sender: { type: "contact", id: 31 } },
        ...Array.from({ length: 25 }, () => ({
          messageType: 1,
          sender: { type: "user", id: 3 },
          private: true,
        })),
      ],
    });
    await mediaFallbackHandler(await claimed(9014), appDb, buried.makeClient);
    expect(buried.sent).toEqual([]);
    // A private note and an activity line are not something the customer received.
    const quiet = fakeChatwoot({
      failedId: 9014,
      after: [
        { messageType: 1, sender: { type: "user", id: 3 }, private: true },
        { messageType: 2, sender: null },
      ],
    });
    await mediaFallbackHandler(await claimed(9014), appDb, quiet.makeClient);
    expect(quiet.sent).toHaveLength(1);
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
