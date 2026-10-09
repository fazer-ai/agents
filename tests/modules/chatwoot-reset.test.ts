import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  chatwootThreadId,
  contactInboxThreadId,
  getCheckpointer,
} from "@/graph/checkpointer";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { withKeyedQueue } from "@/lib/locks";
import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";
import {
  receiveChatwootWebhook,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import { enqueueJob } from "@/modules/scheduler/service";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { seedChatwootInstance } from "../utils/chatwoot";
import { isOwnershipRead } from "../utils/ownership-read";

// /reset drives real ChatwootClient calls (the command path builds its own client, and no
// injectable factory reaches it), so the double here is `globalThis.fetch` shaped like a Chatwoot
// server. It authenticates like one: Chatwoot's AccessTokenAuthHelper leaves @access_token nil for
// a blank header and authenticate_access_token! renders 401 before any authorization runs, so a
// client built without a bot token fails here, where a stub accepting any token would pass while
// the customer is told the conversation was cleared.

const BOT_TOKEN = "BOT-TOKEN";
const ADMIN_TOKEN = "ADMIN-TOKEN";
const CONV_ID = 42;
const INBOX_ID = 7;
const KANBAN_TASK_ID = 55;
const CONTACT_CW_ID = 808;
const WIDGET_INBOX_ID = 8;

interface CwCall {
  method: string;
  path: string;
  token: string;
  body: unknown;
}

interface FakeChatwoot {
  calls: CwCall[];
  impl: typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// What this conversation carries when the reset lands, in the order Chatwoot returns them.
const LIVE_LABELS = ["compra-de-ingresso", "orcamento-enviado"] as const;

// `failing` marks endpoints that answer 500 even with a valid token, so a test can drive a partial
// failure without going through the auth path. `takeoverAfterToggle` is a holder the live read
// reports only after the hand-back's status call, the only way to reach the takeover branch: an
// earlier guard stands the hand-back down if the holder already changed. Without it the GET carries
// no status, `parseLiveConversation` returns null, and the run takes the "unreadable, hand back
// anyway" path.
function fakeChatwoot(
  // A path that answers 500, or a predicate when the method matters too: the label snapshot (GET)
  // and the clear (POST) share one path, and a test needs the GET to fail with the POST still up.
  failing: RegExp | ((method: string, path: string) => boolean) | null = null,
  takeoverAfterToggle: {
    type: string;
    id: number;
    // Which live read it first shows up on, counting from the command's own refresh. Default is the
    // one after the status call; an earlier number puts the takeover in the window between the
    // command's holder check and the hand-back's first read.
    fromRead?: number;
  } | null = null,
): FakeChatwoot {
  let toggled = false;
  let liveReads = 0;
  const calls: CwCall[] = [];
  const impl = (async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const token = new Headers(init?.headers).get(CHATWOOT_AUTH_HEADER) ?? "";
    const raw = init?.body;
    calls.push({
      method,
      path: url.pathname,
      token,
      body: typeof raw === "string" ? JSON.parse(raw) : null,
    });
    if (method === "POST" && url.pathname.endsWith("/toggle_status")) {
      toggled = true;
    }
    if (token.trim() === "") {
      return jsonResponse({ error: "Invalid Access Token" }, 401);
    }
    if (
      typeof failing === "function"
        ? failing(method, url.pathname)
        : failing?.test(url.pathname)
    )
      return jsonResponse({ error: "boom" }, 500);
    if (
      method === "GET" &&
      url.pathname.endsWith(`/conversations/${CONV_ID}`)
    ) {
      liveReads += 1;
      return jsonResponse({
        id: CONV_ID,
        kanban_task: { id: KANBAN_TASK_ID },
        ...(takeoverAfterToggle
          ? {
              status: "pending",
              meta: (
                takeoverAfterToggle.fromRead != null
                  ? liveReads >= takeoverAfterToggle.fromRead
                  : toggled
              )
                ? {
                    assignee_type: takeoverAfterToggle.type,
                    assignee: {
                      id: takeoverAfterToggle.id,
                      type: takeoverAfterToggle.type,
                    },
                  }
                : { assignee_type: "User", assignee: { id: 77, type: "User" } },
            }
          : {}),
      });
    }
    // NOTE: a bot assignment answers the way the fork does, with the bot (`agent_bot_slim`), so the
    // hand-back takes it as landed and sends no unassign after it.
    if (method === "POST" && url.pathname.endsWith("/assignments")) {
      const body = typeof raw === "string" ? JSON.parse(raw) : null;
      if (body?.assignee_type === "AgentBot") {
        return jsonResponse({
          id: body.assignee_id,
          name: "Bot",
          bot_type: "webhook",
        });
      }
    }
    // NOTE: the labels standing on the conversation when the command arrives. The clear reads them
    // so the acknowledgement can name them; the fall-through below answers with no payload, which
    // reads as "no label" and would make that assertion vacuous.
    if (method === "GET" && url.pathname.endsWith("/labels")) {
      return jsonResponse({ payload: [...LIVE_LABELS] });
    }
    // The account's attribute schema. `crm_id` is deliberately absent from it: it is the key an
    // integration owns, and the one a wholesale clear would destroy.
    if (
      method === "GET" &&
      url.pathname.endsWith("/custom_attribute_definitions")
    ) {
      return jsonResponse([
        {
          attribute_key: "orcamento",
          attribute_model: "contact_attribute",
          attribute_display_name: "Orçamento",
          attribute_display_type: "text",
        },
        {
          attribute_key: "qualificado",
          attribute_model: "contact_attribute",
          attribute_display_name: "Qualificado",
          attribute_display_type: "text",
        },
        {
          attribute_key: "produto",
          attribute_model: "conversation_attribute",
          attribute_display_name: "Produto",
          attribute_display_type: "text",
        },
      ]);
    }
    if (
      method === "GET" &&
      url.pathname.endsWith(`/contacts/${CONTACT_CW_ID}`)
    ) {
      return jsonResponse({
        payload: {
          id: CONTACT_CW_ID,
          custom_attributes: {
            orcamento: "5000",
            qualificado: "sim",
            crm_id: "CRM-9",
          },
        },
      });
    }
    // NOTE: a card that already carries attributes, so a clear that merged into what it read would
    // write them back instead of emptying the card.
    if (
      method === "GET" &&
      url.pathname.endsWith(`/kanban/tasks/${KANBAN_TASK_ID}`)
    ) {
      return jsonResponse({
        id: KANBAN_TASK_ID,
        custom_attributes: { faturamento_mensal: "15 mil" },
      });
    }
    return jsonResponse({ id: 1 });
  }) as typeof fetch;
  return { calls, impl };
}

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

const SECRET = "reset-webhook-secret";
let tenantId = 0n;
let instanceId = 0n;
let routeToken = "";
let deliverySeq = 0;
const originalFetch = globalThis.fetch;

// Drives one incoming message through the receiver and the processor, exactly as a live delivery
// would. Defaults to the /reset this suite is named for.
async function sendReset(
  content = "/reset",
  convId = CONV_ID,
  // The conversation as CHATWOOT has it when the command arrives. Defaults to the bot-owned shape;
  // the handoff case sends the one a human is holding, which is the state the command has to undo.
  live: {
    status?: string;
    assigneeType?: string | null;
    assigneeId?: number;
    // The bot whose webhook ROUTE the delivery arrives on. Chatwoot fans a message out to the
    // conversation's assigned bot AND the inbox's, so these are not always the same persona.
    routeToken?: string;
    testActivated?: boolean;
    // Omit `meta` entirely: the payload then says nothing about ownership and the mirror's stored
    // trio is what the gate reads, which is how a real degraded event behaves.
    silentMeta?: boolean;
    // The inbox the delivery names. The mirror follows it, so a test that seeds a conversation on
    // another inbox has to say so here or the row is moved back to the default one.
    inboxId?: number;
    // A stand-in Prisma client, for driving a failure into one specific query.
    base?: PrismaClient;
    // Deliver the command with NO message id. `NormalizedChatwootMessage.id` is `number | null`, so
    // `commandMessageId` can be null even on a command that was parsed out of a message's own
    // content — and every step that orders rows against the command has to say what it does then.
    semMessageId?: boolean;
  } = {},
): Promise<void> {
  deliverySeq += 1;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: "message_created",
    ...(live.semMessageId ? {} : { id: 9000 + deliverySeq }),
    content,
    message_type: "incoming",
    private: false,
    conversation: {
      id: convId,
      inbox_id: live.inboxId ?? INBOX_ID,
      status: live.status ?? "pending",
      contact_inbox: { id: 301 },
      ...(live.silentMeta ? {} : { meta: undefined }),
      meta: live.silentMeta
        ? undefined
        : (live.assigneeType ?? null) === null
          ? { assignee_type: null, assignee: null }
          : {
              assignee_type: live.assigneeType,
              assignee: {
                id: live.assigneeId ?? 77,
                type: live.assigneeType,
              },
            },
    },
  });
  const r = await receiveChatwootWebhook({
    routeToken: live.routeToken ?? routeToken,
    rawBody: body,
    getHeader: (name: string) =>
      ({
        "x-chatwoot-signature": `sha256=${createHmac("sha256", SECRET)
          .update(`${nowSeconds}.${body}`)
          .digest("hex")}`,
        "x-chatwoot-timestamp": String(nowSeconds),
        "x-chatwoot-delivery": `reset-${deliverySeq}`,
      })[name.toLowerCase()] ?? null,
    nowSeconds,
    base: appDb,
  });
  await recordAndProcessChatwootDelivery({
    tenantId,
    instanceId: r.instanceId as bigint,
    deliveryId: r.deliveryId as string,
    agentBotId: r.agentBotId ?? null,
    normalized: r.normalized as NonNullable<typeof r.normalized>,
    base: live.base ?? appDb,
  });
}

// A `message_updated` carrying the audio that was not attached at creation time — the shape
// `hasPendingInboundMediaUpdate` recognises. Eligible for eager STT only: it drives no turn.
async function sendLateAudio(
  convId: number,
  inboxId: number,
  audioUrl: string,
): Promise<void> {
  deliverySeq += 1;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: "message_updated",
    id: 9500 + deliverySeq,
    content: "",
    message_type: "incoming",
    private: false,
    attachments: [
      { id: 77, file_type: "audio", data_url: audioUrl, transcribed_text: "" },
    ],
    conversation: {
      id: convId,
      inbox_id: inboxId,
      status: "pending",
      contact_inbox: { id: 301 },
      meta: { assignee_type: null, assignee: null },
    },
  });
  const r = await receiveChatwootWebhook({
    routeToken,
    rawBody: body,
    getHeader: (name: string) =>
      ({
        "x-chatwoot-signature": `sha256=${createHmac("sha256", SECRET)
          .update(`${nowSeconds}.${body}`)
          .digest("hex")}`,
        "x-chatwoot-timestamp": String(nowSeconds),
        "x-chatwoot-delivery": `late-audio-${deliverySeq}`,
      })[name.toLowerCase()] ?? null,
    nowSeconds,
    base: appDb,
  });
  await recordAndProcessChatwootDelivery({
    tenantId,
    instanceId: r.instanceId as bigint,
    deliveryId: r.deliveryId as string,
    agentBotId: r.agentBotId ?? null,
    normalized: r.normalized as NonNullable<typeof r.normalized>,
    base: appDb,
  });
}

const attributeCalls = (calls: CwCall[]) =>
  calls.filter((c) => c.path.endsWith("/custom_attributes"));
const ackCalls = (calls: CwCall[]) =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));

describe.skipIf(!dbUp)(
  "/reset clears through an authenticated bot client",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Reset", slug: `reset-${process.pid}` },
      });
      tenantId = t.id;
      const { token, hash } = generateRouteToken();
      routeToken = token;
      // TEST-NET-3 (RFC 5737, reserved for documentation) on the discard port: an IP literal keeps the
      // SSRF guard off DNS, and the address is public enough to pass its blocked-range check. Nothing is
      // dialed either way — globalThis.fetch is the double.
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 1,
        baseUrl: "https://203.0.113.10:9",
        adminToken: encryptJson(ADMIN_TOKEN),
      });
      instanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "x",
          mode: "test",
          // NOTE: a runnable model configuration: the hand-back refuses an agent that cannot
          // answer, since it cannot be handed a conversation.
          modelConfig: {
            provider: "openai-compatible",
            model: "local",
            baseURL: "https://llm.example.invalid/v1",
          },
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: INBOX_ID,
          name: "WhatsApp",
          agentId: agent.id,
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson(BOT_TOKEN),
          webhookSecret: encryptJson(SECRET),
          webhookRouteTokenHash: hash,
          name: "Atendente",
        },
      });
      const contact = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: CONTACT_CW_ID,
          name: "Cliente",
        },
      });
      // Test mode must already be ACTIVE for this conversation, or /reset defers to the silence gate.
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: inbox.id,
          contactId: contact.id,
          chatwootConversationId: CONV_ID,
          contactInboxId: 301,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
          testActivatedAt: new Date(),
        },
      });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    afterAll(async () => {
      globalThis.fetch = originalFetch;
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    });

    test("the custom-attributes call carries the persona bot's token, so the clear lands", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const attrs = attributeCalls(cw.calls);
      expect(attrs).toHaveLength(1);
      // NOTE: with an empty token Chatwoot answers 401 and the attributes survive the reset.
      expect(attrs[0]?.token).toBe(BOT_TOKEN);
      expect(attrs[0]?.body).toEqual({ custom_attributes: {} });
    });

    // The compacted memory of past attendances lives in its own table, not in the graph thread, so
    // deleting the thread alone would leave it behind — and the next compaction renders it back into
    // the thread's first message. A /reset that says "memória" and resurrects it is a lie.
    test("the compacted memory of past attendances is cleared too", async () => {
      await suDb.attendanceSummary.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 301,
          conversationId: 999,
          lastMessageId: "msg-abc",
          summary: "orçamento de R$ 250 aprovado",
          messageCount: 4,
          attendanceAt: new Date(),
        },
      });
      // A compaction armed on a resolve waits out a grace window, so at any moment there can be one
      // sitting in the queue holding this very conversation. Left armed it fires minutes later and
      // writes a fresh row: memory the operator explicitly deleted, back with no trace of where it
      // came from.
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "MEMORY_COMPACT",
          dedupeKey: contactInboxThreadId(tenantId, instanceId, 301),
          runAt: new Date(Date.now() + 600_000),
          status: "PENDING",
          payload: {},
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(
        await suDb.attendanceSummary.count({
          where: { tenantId, contactInboxId: 301 },
        }),
      ).toBe(0);
      const job = await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "MEMORY_COMPACT",
          dedupeKey: contactInboxThreadId(tenantId, instanceId, 301),
        },
      });
      // cancelPendingJob retires a row as DONE (its vocabulary for "this will not run").
      expect(job?.status).toBe("DONE");
    });

    // NOTE: o carimbo é escrito ANTES da limpeza, e o teste afirma isso pelo fonte porque o
    // comportamento que a ordem protege não é montável aqui. `clearContactMemory` apaga o
    // checkpoint por último, e ele vive em outro pool que nenhum rollback nosso alcança: um
    // statement nosso depois dele, falhando, restauraria a thread e os resumos ao lado de um
    // checkpoint que já foi. Escrito antes, uma limpeza que falha leva a fronteira junto. Nos dois
    // casos a coluna termina como estava, então uma asserção sobre a ordem no arquivo é o que
    // sobra.
    test("the clear's own boundary is written before the memory is deleted", async () => {
      const fonte = await Bun.file(
        join(import.meta.dir, "../../src/modules/chatwoot/webhook.ts"),
      ).text();
      const carimbo = fonte.indexOf("SET memory_cleared_at_message_id");
      const limpeza = fonte.indexOf("await clearContactMemory({");
      expect(carimbo).toBeGreaterThan(0);
      expect(limpeza).toBeGreaterThan(0);
      expect(carimbo).toBeLessThan(limpeza);
    });

    // NOTE: o fato de que a limpeza aconteceu fica na conversa, escrito pela transação que apagou a
    // thread, os resumos e o checkpoint. `reset_at_message_id` só registra que o operador DIGITOU o
    // comando (statement anterior e independente), e este passo recusa quando um turno já escreve a
    // thread; a cerca da ingestão pergunta por esta coluna porque ela não existe sem as deleções ao
    // lado dela.
    test("a successful clear records itself on the conversation, beside the command's own stamp", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { resetAtMessageId: true, memoryClearedAtMessageId: true },
      });
      expect(conv.memoryClearedAtMessageId).toBe(conv.resetAtMessageId);
    });

    // NOTE: compaction is not the only queued writer of this memory: continuous ingestion can owe
    // an append carrying text from before the reset, and both shapes have to stop, the row still
    // waiting and the row already claimed by a run blocked on the reset's own lock. The second is
    // the dangerous one: it lands the instant the lock is released and rebuilds memory the operator
    // was told had been cleared.
    test("queued ingestion for this thread is revoked, claimed rows included", async () => {
      const threadId = contactInboxThreadId(tenantId, instanceId, 301);
      // DEAD included: a job that exhausted its retries before the reset will never run, but its row
      // still holds the encrypted message body and nothing sweeps this table. Left behind, the
      // operator is told the memory was cleared over a stored copy of the conversation.
      for (const [messageId, status] of [
        [900, "PENDING"],
        [901, "CLAIMED"],
        [903, "DEAD"],
      ] as const) {
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "INGEST_MESSAGE",
            dedupeKey: `ingest:${threadId}:${messageId}`,
            runAt: new Date(),
            status,
            // NOTE: the payload names the message, the only shape this table holds: `armIngest`
            // (src/graph/ingest-job.ts) is the single writer of an INGEST_MESSAGE row and always
            // writes `messageId`. The revoke orders rows against the command, so a `{}` payload
            // would describe a row no code writes.
            payload: { messageId },
          },
        });
      }
      // Another thread's queued ingestion must survive: /reset clears the channel it was typed in.
      const otherThread = contactInboxThreadId(tenantId, instanceId, 999);
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: `ingest:${otherThread}:902`,
          runAt: new Date(),
          status: "PENDING",
          payload: {},
        },
      });

      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const statuses = await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "INGEST_MESSAGE" },
        select: { dedupeKey: true, status: true },
        orderBy: { dedupeKey: "asc" },
      });
      const byKey = new Map(statuses.map((r) => [r.dedupeKey, r.status]));
      // GONE, not retired as DONE. An ingestion row's key names one message and nothing reuses it,
      // so a finished one leaves nothing behind — and a revoked one can never reach the completion
      // that normally deletes it. Retired instead, it would sit there forever holding the encrypted
      // message body this reset was asked to erase.
      expect(byKey.has(`ingest:${threadId}:900`)).toBe(false);
      expect(byKey.has(`ingest:${threadId}:901`)).toBe(false);
      expect(byKey.has(`ingest:${threadId}:903`)).toBe(false);
      expect(byKey.get(`ingest:${otherThread}:902`)).toBe("PENDING");
    });

    // NOTE: the revoke stops at the episode boundary. It runs early in the command, but the command
    // waits for `withKeyedQueue('ingest:<thread>')` behind in-flight ingestion, and `armIngest`
    // does not take that queue (it calls `enqueueJob` directly). A customer message landing in that
    // stretch arrives after the reset and arms its own ingestion, which an unqualified revoke would
    // delete silently: INGEST_MESSAGE is JOB_DELETE_ON_DONE, so "revoked", "ingested" and "never
    // armed" all leave zero rows. The job's own `stillWanted` fence cannot help: the row is gone,
    // so there is nothing to re-read.
    test("an ingestion armed for a message ABOVE the command survives the revoke", async () => {
      const threadId = contactInboxThreadId(tenantId, instanceId, 301);
      // Far above any id `sendReset` can mint (it numbers commands from 9000), so the assertion does
      // not depend on how many deliveries ran before it in this file.
      for (const [messageId, status] of [
        [99_000, "PENDING"],
        [99_001, "CLAIMED"],
        [99_003, "DEAD"],
      ] as const) {
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "INGEST_MESSAGE",
            dedupeKey: `ingest:${threadId}:${messageId}`,
            runAt: new Date(),
            status,
            payload: { messageId },
          },
        });
      }
      // And one from before it, in the same call, so the test states the boundary rather than just
      // "nothing was deleted".
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: `ingest:${threadId}:800`,
          runAt: new Date(),
          status: "PENDING",
          payload: { messageId: 800 },
        },
      });

      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const rows = await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "INGEST_MESSAGE" },
        select: { dedupeKey: true, status: true },
      });
      const byKey = new Map(rows.map((r) => [r.dedupeKey, r.status]));
      // DEAD included on this side too. The reason the revoke takes DEAD at all is privacy: the row
      // still holds the encrypted body of a message the reset was asked to erase. A DEAD row for a
      // message that arrived AFTER the command holds a body the reset was never asked to erase, and
      // deleting it also throws away a dead-letter the operator may still need to see.
      expect(byKey.get(`ingest:${threadId}:99000`)).toBe("PENDING");
      expect(byKey.get(`ingest:${threadId}:99001`)).toBe("CLAIMED");
      expect(byKey.get(`ingest:${threadId}:99003`)).toBe("DEAD");
      expect(byKey.has(`ingest:${threadId}:800`)).toBe(false);
    });

    // NOTE: a command that named no message still revokes everything. With no id there is no
    // boundary, and inventing one is wrong both ways: zero would spare every row and hand the
    // operator a cleared thread that rebuilds itself, the newest message would delete what arrived
    // after. The OBSERVE cancel below makes the opposite choice (it skips itself), and the
    // difference is asserted rather than left to be re-aligned by shape: a verdict can wait for the
    // tick's own fence, but text from before the reset landing back in a cleared thread cannot.
    test("a command that named no message still revokes the whole prefix", async () => {
      const threadId = contactInboxThreadId(tenantId, instanceId, 301);
      for (const [messageId, status] of [
        [820, "PENDING"],
        [99_100, "PENDING"],
        [99_101, "DEAD"],
      ] as const) {
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "INGEST_MESSAGE",
            dedupeKey: `ingest:${threadId}:${messageId}`,
            runAt: new Date(),
            status,
            payload: { messageId },
          },
        });
      }

      // The premise, read BEFORE the command: this conversation row is shared with the tests above,
      // so it may already carry a boundary from one of them. What the null case has to show is that
      // this command does not MOVE it, which is the same statement without assuming a clean row.
      const antes = (
        await suDb.conversation.findFirstOrThrow({
          where: {
            tenantId,
            chatwootInstanceId: instanceId,
            contactInboxId: 301,
          },
          select: { resetAtMessageId: true },
        })
      ).resetAtMessageId;

      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, { semMessageId: true });

      // Every row, on both sides of any boundary that could have been invented: 820 is below
      // whatever the row carries, 99100 and 99101 are above it. A fallback of zero would spare all
      // three; reusing the previous command's mark would spare the two above.
      expect(
        await suDb.schedulerJob.count({
          where: {
            tenantId,
            kind: "INGEST_MESSAGE",
            dedupeKey: { startsWith: `ingest:${threadId}:` },
          },
        }),
      ).toBe(0);
      const depois = (
        await suDb.conversation.findFirstOrThrow({
          where: {
            tenantId,
            chatwootInstanceId: instanceId,
            contactInboxId: 301,
          },
          select: { resetAtMessageId: true },
        })
      ).resetAtMessageId;
      expect(depois).toBe(antes);
    });

    // The checkpoint is the one piece of the memory that a compaction can RECREATE. Deleted outside
    // the lock the rewrite holds, the order that loses is: reset deletes the thread, the claimed job
    // finishes its rewrite and writes the checkpoint back — with the memory head in it — and reset
    // then takes the lock and deletes rows that no longer describe what the agent can see. The
    // operator is told the memory was cleared and the agent keeps answering from it.
    //
    // Held from another connection, the lock proves the ordering directly: while it is held, nothing
    // of the memory may be gone.
    test("the checkpoint is deleted inside the critical section, not before it", async () => {
      const threadId = contactInboxThreadId(tenantId, instanceId, 301);
      const cp = await getCheckpointer();
      await buildThreadStateGraph(cp).updateState(
        { configurable: { thread_id: threadId } },
        { messages: [new HumanMessage("orçamento de R$ 250 aprovado")] },
        THREAD_STATE_NODE,
      );
      const read = () => cp.get({ configurable: { thread_id: threadId } });
      expect(await read()).toBeTruthy();
      await suDb.attendanceSummary.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 301,
          conversationId: 998,
          lastMessageId: "msg-lock",
          summary: "orçamento aprovado",
          messageCount: 2,
          attendanceAt: new Date(),
        },
      });

      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      const survived: boolean[] = [];
      let running: Promise<void> = Promise.resolve();
      let resetFailed: unknown;
      // NOTE: occupies the thread's critical section the way ingestion, a turn, the nudge and
      // compaction all do: the process-local queue. A `pg_advisory_xact_lock` would prove nothing,
      // since this family does not take it and the reset would delete the checkpoint straight past
      // it.
      await withKeyedQueue(`ingest:${threadId}`, async () => {
        // The memory step is the FIRST of the reset, so it blocks here almost immediately.
        running = sendReset().catch((err) => {
          resetFailed = err;
        });
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 50));
          survived.push(Boolean(await read()));
        }
      });
      await running;
      expect(resetFailed).toBeUndefined();

      expect(survived.every(Boolean)).toBe(true);
      expect(await read()).toBeUndefined();
      expect(
        await suDb.attendanceSummary.count({
          where: { tenantId, contactInboxId: 301 },
        }),
      ).toBe(0);
    });

    test("a failed step does not skip the independent ones that follow it", async () => {
      const cw = fakeChatwoot(/\/custom_attributes$/);
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(attributeCalls(cw.calls)).toHaveLength(1);
      // NOTE: labels, attributes and the kanban card are independent cleanups, each in its own try:
      // a shared one would let the first failure swallow the rest and leave the card with the
      // previous episode's dates.
      expect(
        cw.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels")),
      ).toBe(true);
      expect(
        cw.calls.some(
          (c) =>
            c.method === "PATCH" &&
            c.path.endsWith(`/kanban/tasks/${KANBAN_TASK_ID}`),
        ),
      ).toBe(true);
    });

    test("a failure on the last remote step still leaves the local cleanups done", async () => {
      await suDb.conversation.update({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_ID,
          },
        },
        data: {
          testNoticeSentAt: new Date(),
          lastFollowUpAt: new Date(),
          // NOTE: um eixo da cerca do silêncio. Entra aqui porque o /reset encerra o episódio
          // limpando as âncoras: sobrevivendo, ele sozinho faz a varredura passar e recriar o
          // follow-up cancelado, sem ninguém ter falado.
          lastRepliedAt: new Date(),
        },
      });
      const cw = fakeChatwoot(/\/kanban\/tasks\//);
      globalThis.fetch = cw.impl;
      await sendReset();

      // The kanban card is the last Chatwoot call, but the watermark clear comes after it. Unguarded,
      // its failure would throw past everything below, including the ack.
      const conv = await suDb.conversation.findUniqueOrThrow({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_ID,
          },
        },
        select: {
          testNoticeSentAt: true,
          lastFollowUpAt: true,
          lastRepliedAt: true,
        },
      });
      expect(conv.testNoticeSentAt).toBeNull();
      expect(conv.lastFollowUpAt).toBeNull();
      expect(conv.lastRepliedAt).toBeNull();
      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      expect(
        String((acks[0]?.body as { content?: unknown } | null)?.content ?? ""),
      ).toMatch(/kanban/i);
    });

    // NOTE: building the persona client reads the DB and resolves DNS through the SSRF guard, so it
    // can throw during an outage. It sits inside the best-effort boundary, or the reset would abort
    // after the memory was wiped, with no acknowledgement at all.
    test("a client that cannot even be built does not abandon the local cleanups", async () => {
      const other = await suDb.tenant.create({
        data: { name: "ResetBlocked", slug: `reset-blocked-${process.pid}` },
      });
      try {
        const { token, hash } = generateRouteToken();
        // http + loopback: refused by the SSRF guard before any request is attempted.
        const inst = await seedChatwootInstance(suDb, {
          tenantId: other.id,
          accountId: 1,
          baseUrl: "http://127.0.0.1:9",
          adminToken: encryptJson(ADMIN_TOKEN),
        });
        const agent = await suDb.agent.create({
          data: {
            tenantId: other.id,
            name: "Atendente",
            systemPrompt: "x",
            mode: "test",
            // NOTE: a runnable model configuration: the hand-back refuses an agent that cannot
            // answer, since it cannot be handed a conversation.
            modelConfig: {
              provider: "openai-compatible",
              model: "local",
              baseURL: "https://llm.example.invalid/v1",
            },
          },
        });
        const inbox = await suDb.inbox.create({
          data: {
            tenantId: other.id,
            chatwootInstanceId: inst.id,
            chatwootInboxId: INBOX_ID,
            name: "WhatsApp",
            agentId: agent.id,
          },
        });
        await suDb.chatwootAgentBot.create({
          data: {
            tenantId: other.id,
            chatwootInstanceId: inst.id,
            agentId: agent.id,
            chatwootAgentBotId: 9,
            accessToken: encryptJson(BOT_TOKEN),
            webhookSecret: encryptJson(SECRET),
            webhookRouteTokenHash: hash,
            name: "Atendente",
          },
        });
        await suDb.conversation.create({
          data: {
            tenantId: other.id,
            chatwootInstanceId: inst.id,
            inboxId: inbox.id,
            chatwootConversationId: CONV_ID,
            contactInboxId: 302,
            status: "pending",
            threadId: `${other.id}:${inst.id}:${CONV_ID}`,
            testActivatedAt: new Date(),
            testNoticeSentAt: new Date(),
            lastFollowUpAt: new Date(),
          },
        });

        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const body = JSON.stringify({
          event: "message_created",
          id: 9500,
          content: "/reset",
          message_type: "incoming",
          private: false,
          conversation: {
            id: CONV_ID,
            inbox_id: INBOX_ID,
            status: "pending",
            contact_inbox: { id: 302 },
            meta: { assignee_type: null, assignee: null },
          },
        });
        const r = await receiveChatwootWebhook({
          routeToken: token,
          rawBody: body,
          getHeader: (name: string) =>
            ({
              "x-chatwoot-signature": `sha256=${createHmac("sha256", SECRET)
                .update(`${nowSeconds}.${body}`)
                .digest("hex")}`,
              "x-chatwoot-timestamp": String(nowSeconds),
              "x-chatwoot-delivery": "reset-blocked",
            })[name.toLowerCase()] ?? null,
          nowSeconds,
          base: appDb,
        });
        await recordAndProcessChatwootDelivery({
          tenantId: other.id,
          instanceId: r.instanceId as bigint,
          deliveryId: r.deliveryId as string,
          agentBotId: r.agentBotId ?? null,
          normalized: r.normalized as NonNullable<typeof r.normalized>,
          base: appDb,
        });

        // Nothing could be sent (the ack shares the same blocked base URL), but the local slate is
        // still clean and the run reached the end instead of dying halfway.
        expect(cw.calls).toHaveLength(0);
        const conv = await suDb.conversation.findUniqueOrThrow({
          where: {
            tenantId_chatwootInstanceId_chatwootConversationId: {
              tenantId: other.id,
              chatwootInstanceId: inst.id,
              chatwootConversationId: CONV_ID,
            },
          },
          select: { testNoticeSentAt: true, lastFollowUpAt: true },
        });
        expect(conv.testNoticeSentAt).toBeNull();
        expect(conv.lastFollowUpAt).toBeNull();
      } finally {
        await suDb.tenant.delete({ where: { id: other.id } }).catch(() => {});
      }
    });

    // NOTE: the survivor that makes every other one moot. `shouldBotHandle` needs both `status ===
    // "pending"` and `assignee_type !== "User"`, so a reset that left a handoff in place would end
    // the test loop (activate with /teste, hand off, resolve, start over) with a conversation that
    // announces itself active and never answers, recoverable only through the console's "Devolver
    // para IA", behind a login the person testing often lacks.
    test("a conversation a human took over is returned to the agent", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });

      // One request: the bot assignment removes the person, names the bot and sets `pending` in one
      // locked write, so there is no partial in which the human is gone and the status is not.
      const owned = cw.calls.filter(
        (c) =>
          c.method === "POST" &&
          (c.path.endsWith(`/conversations/${CONV_ID}/assignments`) ||
            c.path.endsWith(`/conversations/${CONV_ID}/toggle_status`)),
      );
      expect(owned.map((c) => [c.path.split("/").pop(), c.body])).toEqual([
        ["assignments", { assignee_id: 9, assignee_type: "AgentBot" }],
      ]);
      // Admin token on both: the bot cannot reassign a conversation away from a human, and the
      // audit should show the operator rather than the persona.
      expect(owned.every((c) => c.token === ADMIN_TOKEN)).toBe(true);

      // And the mirror agrees, so the very next delivery passes the gate instead of waiting for a
      // Chatwoot event that may never come.
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { status: true, assigneeType: true, assigneeId: true },
      });
      expect(conv).toEqual({
        status: "pending",
        assigneeType: "AgentBot",
        assigneeId: 9,
      });

      // The acknowledgement reports what happened and nothing else: the conversation WAS handed
      // back, so the sentence that explains withholding it has no business here.
      const ack = ackCalls(cw.calls)
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      expect(ack).not.toContain("desativado");
      // Nor the takeover sentence: the agent HAS it back, and a sentence that fired on every
      // hand-back would pass the takeover tests without meaning anything.
      expect(ack).not.toContain("Alguém assumiu");
    });

    // NOTE: everything above is what the operator sees; this audit record is the only thing that
    // survives the conversation being deleted.
    test("the erase, and the hand-back inside it, are on the trail", async () => {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });

      const rows = await suDb.auditLog.findMany({
        where: { tenantId },
        orderBy: { id: "asc" },
      });
      // Two acts, two rows, and neither is the other: the hand-back is the state change a console
      // button also performs, and the reset is the erase that has no button at all.
      expect(rows.map((r) => r.action)).toEqual([
        "conversation.return",
        "conversation.reset",
      ]);
      // NOT `user`, which is what an unset actorType defaults to. /reset is only recognized on an
      // INCOMING message, so the person who typed it is the contact, who is nobody in `users`, and
      // a row reading `user` with a null id would say the platform could not identify an operator
      // rather than that there was none.
      expect(rows.every((r) => r.actorType === "system")).toBe(true);
      expect(rows.every((r) => r.actorId === null)).toBe(true);
      const reset = rows[1];
      expect(reset?.after).toEqual({
        complete: true,
        failed: [],
        handBack: "returned",
      });
    });

    // The hand-back has THREE outcomes and `undefined` is one of them: the conversation was already
    // the agent's, so nothing was attempted. Left as it came, Prisma drops the key on the way into
    // the jsonb column and the row simply lacks the field the other rows carry.
    test("a reset with nothing to hand back still says so", async () => {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const rows = await suDb.auditLog.findMany({
        where: { tenantId },
        orderBy: { id: "asc" },
      });
      expect(rows.map((r) => r.action)).toEqual(["conversation.reset"]);
      expect(rows[0]?.after).toEqual({
        complete: true,
        failed: [],
        handBack: "not-attempted",
      });
    });

    test("a partial erase names the steps that did not run", async () => {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      const cw = fakeChatwoot(/\/custom_attributes$/);
      globalThis.fetch = cw.impl;
      await sendReset();

      const [row, ...rest] = await suDb.auditLog.findMany({
        where: { tenantId, action: "conversation.reset" },
        orderBy: { id: "asc" },
      });
      expect(rest).toEqual([]);
      const after = row?.after as {
        complete: boolean;
        failed: string[];
        handBack: string | null;
      };
      expect(after.complete).toBe(false);
      expect(after.failed).toContain("clear custom attributes");
      // The steps that DID run are not in the list, which is what makes it readable as "what
      // survived" rather than as "the reset failed".
      expect(after.failed).not.toContain("clear labels");
    });

    // The other way the conversation can still be a human's when the reset ends: the assignment call
    // itself failed. The command has to name THAT — a partial reset — and not the switch, which is on.
    test("a failed hand-back is reported as a failure, not as a disabled agent", async () => {
      const cw = fakeChatwoot(/\/assignments$/);
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });

      const ack = ackCalls(cw.calls)
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      expect(ack).toContain("atribuição");
      expect(ack).not.toContain("desativado");
      // And not ALSO as a takeover. The conversation is still the human's, which is what the
      // takeover sentence reports too — saying both would read as two separate problems.
      expect(ack).not.toContain("Alguém assumiu");
    });

    // The window one step EARLIER, and the one the hand-back's own baseline opened: the command
    // checks the holder, agrees it is the same party it started with, and somebody takes over while
    // the hand-back loads its client and reads the conversation. Read there, that newcomer becomes
    // the baseline, the post-status read finds nothing changed, and the unassign takes the
    // conversation from the very person the guard exists to protect.
    test("a takeover between the holder check and the hand-back is left alone", async () => {
      const cw = fakeChatwoot(null, { type: "User", id: 888, fromRead: 3 });
      globalThis.fetch = cw.impl;
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { status: "open", assigneeType: "User", assigneeId: 77 },
      });
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
        });

        expect(
          cw.calls.some(
            (c) =>
              c.method === "POST" &&
              c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toBe(false);
        expect(
          ackCalls(cw.calls)
            .map((c) => (c.body as { content?: string })?.content ?? "")
            .join(" "),
        ).toContain("Alguém assumiu a conversa durante o reset");
      } finally {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { status: "pending", assigneeType: null, assigneeId: null },
        });
      }
    });

    // And the third way it ends with a human: somebody claimed the conversation by the hand-back's own
    // last read, past the guard's. Nothing throws — the hand-back deliberately leaves a takeover alone —
    // so the command would otherwise announce a clean slate over a conversation that is still theirs.
    test("a takeover during the hand-back is named in the acknowledgement", async () => {
      const cw = fakeChatwoot(null, { type: "User", id: 999, fromRead: 4 });
      globalThis.fetch = cw.impl;
      // The mirror has to agree with the payload's holder, or the guard that runs BEFORE the
      // hand-back sees a changed holder and stands the whole thing down — which is the other,
      // already-tested takeover, the one that lands earlier in the cleanup.
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { status: "open", assigneeType: "User", assigneeId: 77 },
      });
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
        });

        // The unassign was withheld, which is the behaviour this sentence has to explain.
        expect(
          cw.calls.some(
            (c) =>
              c.method === "POST" &&
              c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toBe(false);
        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).toContain("Alguém assumiu a conversa durante o reset");
        // Not a failure and not the disabled agent: both would send the operator somewhere else.
        expect(ack).not.toContain("atribuição");
        expect(ack).not.toContain("desativado");
      } finally {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { status: "pending", assigneeType: null, assigneeId: null },
        });
      }
    });

    // The bot assignment is the hand-back's one write, so its failure must not be followed by an
    // unassign that strips the conversation from the human and hands it to a gate that refuses it.
    test("a hand-back that fails halfway leaves the human holding it", async () => {
      const cw = fakeChatwoot(/\/assignments$/);
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });

      // Only the bot assignment was sent; no unassign followed it.
      expect(
        cw.calls
          .filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          )
          .map((c) => c.body),
      ).toEqual([{ assignee_id: 9, assignee_type: "AgentBot" }]);
      // And the operator is told which part did not happen.
      expect(
        ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" "),
      ).toContain("atribuição");
    });

    // NOTE: the hand-back undoes a handoff that was already there when the operator typed the
    // command. A human who takes over during the cleanup is a newer fact than the command, and
    // pulling the conversation back from them is the same harm pointing the other way. The Chatwoot
    // double is the rendezvous again: the takeover lands on the card call, mid-cleanup.
    test("a takeover that happens during the reset is not undone by it", async () => {
      const cw = fakeChatwoot();
      const inner = cw.impl;
      let tookOver = false;
      globalThis.fetch = (async (input, init) => {
        if (!tookOver && String(input).includes("/kanban/tasks/")) {
          tookOver = true;
          await suDb.conversation.updateMany({
            where: { tenantId, chatwootConversationId: CONV_ID },
            data: { status: "open", assigneeType: "User", assigneeId: 4242 },
          });
        }
        return inner(input, init);
      }) as typeof fetch;
      try {
        // Bot-owned when the command starts: there is nothing for it to undo.
        await sendReset();

        expect(tookOver).toBe(true);
        expect(
          cw.calls.filter(
            (c) =>
              c.path.endsWith(`/conversations/${CONV_ID}/assignments`) ||
              c.path.endsWith(`/conversations/${CONV_ID}/toggle_status`),
          ),
        ).toEqual([]);
        const conv = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV_ID },
          select: { assigneeType: true, assigneeId: true },
        });
        expect([conv.assigneeType, conv.assigneeId]).toEqual(["User", 4242]);
        // And the operator is told. Nothing was withheld here — the command never had a hand-back to
        // do — but the conversation still ends with a human, so a bare "cleared" would have them
        // waiting on an agent that is now gated out.
        expect(
          ackCalls(cw.calls)
            .map((c) => (c.body as { content?: string })?.content ?? "")
            .join(" "),
        ).toContain("Alguém assumiu a conversa durante o reset");
      } finally {
        globalThis.fetch = originalFetch;
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { status: "pending", assigneeType: null, assigneeId: null },
        });
      }
    });

    // The takeover the mirror has not heard about yet, the ordinary case: the cleanup is a
    // dozen calls long and the row learns of an assignment only from Chatwoot's webhook, so the
    // stale holder compared to itself would unassign the human who just took over. Chatwoot serves
    // the takeover; nothing writes it to the mirror. `seedHolder` sets the mirror's holder, since a
    // `message_created` delivery does not write the assignee columns (only conversation events do)
    // and a holder declared only in the payload would measure the seed rather than the takeover.
    const seedHolder = async (assigneeId: number): Promise<void> => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { status: "open", assigneeType: "User", assigneeId },
      });
    };

    const liveHolder = (
      cw: ReturnType<typeof fakeChatwoot>,
      holderId: () => number,
    ): typeof fetch => {
      const inner = cw.impl;
      return (async (input, init) => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        if (
          method === "GET" &&
          url.pathname.endsWith(`/conversations/${CONV_ID}`)
        ) {
          // Through the double first, so the call is recorded and the token check still runs.
          const passthrough = await inner(input, init);
          if (!passthrough.ok) return passthrough;
          return jsonResponse({
            id: CONV_ID,
            kanban_task: { id: KANBAN_TASK_ID },
            status: "open",
            // Ahead of the mirror's stored activity, or the reconcile's freshness guard refuses the
            // snapshot and the refresh silently buys nothing.
            last_activity_at: Math.floor(Date.now() / 1000) + 60,
            meta: {
              assignee_type: "User",
              assignee: { id: holderId(), name: "quem atende" },
            },
          });
        }
        return inner(input, init);
      }) as typeof fetch;
    };

    test("a takeover the mirror has not seen yet still blocks the hand-back", async () => {
      const cw = fakeChatwoot();
      let tookOver = false;
      const base = liveHolder(cw, () => (tookOver ? 222 : 111));
      globalThis.fetch = (async (input, init) => {
        if (!tookOver && String(input).includes("/kanban/tasks/")) {
          tookOver = true;
        }
        return base(input, init);
      }) as typeof fetch;
      try {
        await seedHolder(111);
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
          assigneeId: 111,
        });

        expect(tookOver).toBe(true);
        expect(
          cw.calls.filter(
            (c) =>
              c.method === "POST" &&
              (c.path.endsWith(`/conversations/${CONV_ID}/assignments`) ||
                c.path.endsWith(`/conversations/${CONV_ID}/toggle_status`)),
          ),
        ).toEqual([]);
        // And the refresh is why — the mirror now names the newer holder. Without this the test
        // would also pass on a GET that simply failed.
        const conv = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV_ID },
          select: { assigneeType: true, assigneeId: true },
        });
        expect([conv.assigneeType, conv.assigneeId]).toEqual(["User", 222]);
      } finally {
        globalThis.fetch = originalFetch;
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { status: "pending", assigneeType: null, assigneeId: null },
        });
      }
    });

    // The control the test above needs: the same live payload with NOBODY taking over still hands
    // the conversation back. Otherwise "no assignment call" would be satisfied by a refresh that
    // broke the command outright.
    test("the same refresh still hands back when the holder has not changed", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = liveHolder(cw, () => 111);
      try {
        await seedHolder(111);
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
          assigneeId: 111,
        });

        expect(
          cw.calls
            .filter(
              (c) =>
                c.method === "POST" &&
                (c.path.endsWith(`/conversations/${CONV_ID}/assignments`) ||
                  c.path.endsWith(`/conversations/${CONV_ID}/toggle_status`)),
            )
            .map((c) => c.path.split("/").pop()),
        ).toEqual(["assignments"]);
      } finally {
        globalThis.fetch = originalFetch;
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { status: "pending", assigneeType: null, assigneeId: null },
        });
      }
    });

    // And what an unreadable holder decides: nothing. The command already has an answer — the one it
    // was given when it started — and a transient failure must not be the thing that withdraws it.
    test("an unreadable holder leaves the hand-back on the answer it started with", async () => {
      const blind = appDb.$extends({
        query: {
          conversation: {
            findUnique({ args, query }) {
              const sel = (args.select ?? {}) as Record<string, unknown>;
              // The holder comparison asks for exactly these two columns; the ownership fence asks
              // for three.
              if (
                Object.keys(sel).length === 2 &&
                sel.assigneeType === true &&
                sel.assigneeId === true
              ) {
                return Promise.reject(new Error("connection reset"));
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
        base: blind,
      });

      expect(
        cw.calls
          .filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          )
          .map((c) => c.body),
      ).toEqual([{ assignee_id: 9, assignee_type: "AgentBot" }]);
    });

    // NOTE: the card's dates and its attributes are independent endpoints, so a failure on the
    // first must not silently end the card cleanup.
    test("the card's attributes are cleared even when its dates fail", async () => {
      const cw = fakeChatwoot();
      const inner = cw.impl;
      let firstCardCall = true;
      globalThis.fetch = (async (input, init) => {
        if (firstCardCall && String(input).includes("/kanban/tasks/")) {
          firstCardCall = false;
          return new Response("{}", { status: 500 });
        }
        return inner(input, init);
      }) as typeof fetch;
      try {
        await sendReset();

        const card = cw.calls.find(
          (c) =>
            c.method === "PATCH" &&
            c.path.endsWith(`/kanban/tasks/${KANBAN_TASK_ID}`) &&
            (c.body as { task?: { custom_attributes?: unknown } })?.task
              ?.custom_attributes !== undefined,
        );
        expect(card?.body).toEqual({ task: { custom_attributes: {} } });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // The same rule when the conversation was ALREADY a human's: if a DIFFERENT party claims it while
    // the cleanup runs, that claim is newer than the command too. The command undoes the handoff it
    // was asked about, not whichever one happens to be there when it finishes.
    test("a second human who takes over mid-reset keeps it", async () => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { status: "open", assigneeType: "User", assigneeId: 111 },
      });
      const cw = fakeChatwoot();
      const inner = cw.impl;
      let swapped = false;
      globalThis.fetch = (async (input, init) => {
        if (!swapped && String(input).includes("/kanban/tasks/")) {
          swapped = true;
          await suDb.conversation.updateMany({
            where: { tenantId, chatwootConversationId: CONV_ID },
            data: { assigneeId: 222 },
          });
        }
        return inner(input, init);
      }) as typeof fetch;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
          assigneeId: 111,
        });

        expect(swapped).toBe(true);
        expect(
          cw.calls.filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { status: "pending", assigneeType: null, assigneeId: null },
        });
      }
    });

    // The other half of the same rule: asked with `shouldBotHandle` so an ordinary reset does not
    // spend two admin calls undoing nothing. Without this the condition is unobservable — making the
    // return unconditional passes every other test in this file.
    test("a reset on a bot-owned conversation does not touch the assignment", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(
        cw.calls.filter(
          (c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`) ||
            c.path.endsWith(`/conversations/${CONV_ID}/toggle_status`),
        ),
      ).toEqual([]);
    });

    // WHEN the conversation goes back to the agent, which is a different question from whether it
    // does. Returning it is what makes the NEXT delivery actionable, so a customer message arriving
    // while the cleanup is still running would pass the gate and start a turn on the episode this
    // command is halfway through erasing. The assignment is therefore the LAST thing the reset
    // touches — everything before it runs while the human still holds the conversation.
    test("the conversation goes back to the agent only after the episode is cleared", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });

      const assignmentAt = cw.calls.findIndex((c) =>
        c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
      );
      expect(assignmentAt).toBeGreaterThan(-1);
      // Every cleanup call the command makes, by the endpoint it lands on. The acknowledgement is
      // excluded on purpose: it is the one thing that SHOULD come after the return.
      const cleanupAt = cw.calls
        .map((c, i) => [c, i] as const)
        .filter(
          ([c]) =>
            c.path.endsWith("/custom_attributes") ||
            c.path.endsWith("/labels") ||
            c.path.includes("/kanban/tasks/") ||
            (c.method === "PUT" && c.path.includes("/contacts/")),
        )
        .map(([, i]) => i);
      expect(cleanupAt.length).toBeGreaterThan(0);
      expect(Math.max(...cleanupAt)).toBeLessThan(assignmentAt);
    });

    // NOTE: the redirect gate's anchors are cleared with the three notice watermarks, same shape
    // and purpose: once the redirect has fired, `redirectCount` is at its cap and the cooldown
    // anchor is set, so keeping them would leave an operator who resets to run the funnel again
    // with a conversation that never redirects.
    test("the redirect watermarks are cleared, so the funnel can be run again", async () => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: {
          redirectSentAt: new Date(),
          redirectCount: 3,
          redirectLinkedAt: new Date(),
          redirectClosedAt: new Date(),
          lastError: "boom",
          lastErrorAt: new Date(),
          failureNoticeSentAt: new Date(),
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: {
          redirectSentAt: true,
          redirectCount: true,
          redirectLinkedAt: true,
          redirectClosedAt: true,
          lastError: true,
          lastErrorAt: true,
          failureNoticeSentAt: true,
        },
      });
      expect(conv).toEqual({
        redirectSentAt: null,
        // The count is a counter, not a timestamp: back to zero, not to null.
        redirectCount: 0,
        redirectLinkedAt: null,
        redirectClosedAt: null,
        // And the previous run's failure goes with it. `failureNoticeSentAt` is the coalescing
        // anchor for "a human has to take over", so after a reset a fresh failure has to be able to
        // announce itself again — the same reasoning that already clears testNoticeSentAt.
        lastError: null,
        lastErrorAt: null,
        failureNoticeSentAt: null,
      });
    });

    // NOTE: the pairing is NOT one of them. The four above are one-shot or cooldown watermarks,
    // cleared so the funnel can run again; the pairing is an observed fact (which WhatsApp
    // conversation this chat was opened from), and a reset does not un-click the link the lead
    // clicked. Clearing it is worse, not neutral: `episodeOriginQuery` would fall back to the
    // contact's most recently active entry conversation, a guess, on a consumer that messages and
    // resolves the conversation it picks. Nothing goes stale by keeping it: it only changes when a
    // new redirect is consumed, and the fork writes the new origin over it.
    test("the pairing survives, because a reset does not un-click the link", async () => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: {
          redirectOriginDisplayId: 4242,
          redirectLinkedAt: new Date(),
          redirectClosedAt: new Date(),
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: {
          redirectOriginDisplayId: true,
          redirectLinkedAt: true,
          redirectClosedAt: true,
        },
      });
      expect(conv).toEqual({
        // The episode can be run again...
        redirectLinkedAt: null,
        redirectClosedAt: null,
        // ...against the origin it actually came from.
        redirectOriginDisplayId: 4242,
      });
    });

    // NOTE: a verdict armed after the command belongs to the new episode. The cancel runs late in
    // the reset, past the memory clear and a dozen Chatwoot calls, so a customer message landing in
    // that stretch arms a burst the operator wants classified, which an unqualified prefix cancel
    // would mark DONE.
    test("a verdict armed after the command survives the reset", async () => {
      const threadId = `${tenantId}:${instanceId}:${CONV_ID}`;
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "OBSERVE" },
      });
      await suDb.schedulerJob.createMany({
        data: [
          {
            tenantId,
            kind: "OBSERVE",
            dedupeKey: `observe:${threadId}:7`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: {
              threadId,
              agentId: "7",
              reason: "burst",
              atMessageId: 1,
            },
          },
          {
            tenantId,
            kind: "OBSERVE",
            dedupeKey: `observe:${threadId}:9`,
            runAt: new Date(Date.now() + 3_600_000),
            // Above any id this suite's commands carry (`9000 + n`): the new episode's burst.
            payload: {
              threadId,
              agentId: "9",
              reason: "burst",
              atMessageId: 999_999,
            },
          },
          {
            tenantId,
            kind: "OBSERVE",
            dedupeKey: `observe:${threadId}:11`,
            runAt: new Date(Date.now() + 3_600_000),
            // A RESOLVE names no message, so it orders against nothing here and is left to the
            // tick's own reopen fence — the command is an incoming message, so the conversation the
            // verdict was armed for is no longer resolved.
            payload: { threadId, agentId: "11", reason: "resolved" },
          },
        ],
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const jobs = await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "OBSERVE" },
        select: { dedupeKey: true, status: true },
        orderBy: { dedupeKey: "asc" },
      });
      expect(
        jobs.map((j) => [j.dedupeKey.split(":").at(-1), j.status]),
      ).toEqual([
        ["11", "PENDING"],
        ["7", "DONE"],
        ["9", "PENDING"],
      ]);
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { resetAtMessageId: true },
      });
      // The boundary the cancel was fenced on is the command's own message id.
      expect(conv.resetAtMessageId).toBeGreaterThan(2);
      expect(conv.resetAtMessageId).toBeLessThan(999_999);
    });

    // NOTE: jobs the episode armed. /reset cancels these two alongside FOLLOWUP and MEMORY_COMPACT,
    // which carry the same argument.
    test("the jobs the episode armed are cancelled with it", async () => {
      const threadId = `${tenantId}:${instanceId}:${CONV_ID}`;
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "OBSERVE" },
      });
      await suDb.schedulerJob.createMany({
        data: [
          {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${threadId}`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: { widgetThreadId: threadId },
          },
          {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:evt-198:60",
            runAt: new Date(Date.now() + 3_600_000),
            payload: { threadId, eventId: "evt-198", calendarId: "c" },
          },
          // A queued TURN, not a message: the flush coalesces the burst that arrived before the
          // command and invokes the graph, recreating the thread this reset clears.
          {
            tenantId,
            kind: "DEBOUNCE",
            dedupeKey: `debounce:${threadId}`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: { threadId, agentBotId: 1, burstStartedAt: Date.now() },
          },
          // NOTE: a watcher's queued verdict reads the conversation from Chatwoot rather than from
          // memory, so left armed it would wake after this command and write back the labels the
          // reset cleared. Two, because the key carries the classifier and a conversation can have
          // two.
          {
            tenantId,
            kind: "OBSERVE",
            dedupeKey: `observe:${threadId}:7`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: {
              threadId,
              agentId: "7",
              reason: "burst",
              // NOTE: below the command's own id (the command arrives as message `9000 + n`), which
              // is what makes these the old episode's verdicts.
              atMessageId: 1,
            },
          },
          {
            tenantId,
            kind: "OBSERVE",
            dedupeKey: `observe:${threadId}:9`,
            runAt: new Date(Date.now() + 3_600_000),
            payload: {
              threadId,
              agentId: "9",
              reason: "burst",
              atMessageId: 2,
            },
          },
        ],
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const jobs = await suDb.schedulerJob.findMany({
        where: {
          tenantId,
          kind: {
            in: [
              "REDIRECT_FOLLOWUP",
              "APPOINTMENT_REMINDER",
              "DEBOUNCE",
              "OBSERVE",
            ],
          },
        },
        select: { kind: true, status: true, payload: true },
        orderBy: { kind: "asc" },
      });
      expect(
        jobs.filter((j) => j.kind === "OBSERVE").map((j) => j.status),
      ).toEqual(["DONE", "DONE"]);
      // Enum declaration order, which is what Prisma sorts an enum column by.
      expect(jobs.map((j) => [j.kind, j.status])).toEqual([
        ["DEBOUNCE", "DONE"],
        ["APPOINTMENT_REMINDER", "DONE"],
        ["REDIRECT_FOLLOWUP", "DONE"],
        ["OBSERVE", "DONE"],
        ["OBSERVE", "DONE"],
      ]);
      // Tombstoned too, and for the same reason as the reminder: a flush already CLAIMED is past
      // every cancel, so the stamp is the only thing its handler can see.
      const debounce = jobs.find((j) => j.kind === "DEBOUNCE");
      expect(
        (debounce?.payload as { cancelledAt?: unknown } | undefined)
          ?.cancelledAt,
      ).toBeTruthy();
      // Cancelling alone is not enough for the reminder: `loadAppointmentContext` re-reads these
      // rows on EVERY turn and cannot tell a cancelled job from a fired one, so without the
      // tombstone the appointment block stays in the prompt after the reset.
      const reminder = jobs.find((j) => j.kind === "APPOINTMENT_REMINDER");
      expect(
        (reminder?.payload as { cancelledAt?: string })?.cancelledAt,
      ).toBeString();
      await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    });

    // The redirect funnel spans a PAIR of conversations, and the four tests below are about naming
    // it. `withRedirectPair` configures the agent's entry/widget inboxes, seeds the widget-side
    // conversation of the same contact, and undoes both afterwards — the agent is shared by every
    // test in this file, so the config cannot leak.
    const withRedirectPair = async (
      run: (widgetConvId: number, widgetThread: string) => Promise<void>,
      enabled = true,
    ): Promise<void> => {
      const mine = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { contactId: true, inbox: { select: { agentId: true } } },
      });
      const agentId = mine.inbox?.agentId as bigint;
      const widgetInbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: WIDGET_INBOX_ID,
          name: "Site",
          agentId,
        },
      });
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            channelRedirect: {
              enabled,
              entryInboxId: INBOX_ID,
              widgetInboxId: WIDGET_INBOX_ID,
            },
          },
        },
      });
      const widgetThread = `${tenantId}:${instanceId}:44`;
      // What a real episode leaves behind: the entry side's redirect anchors and the widget
      // side's link watermark. Nothing here can derive which chat opened from which entry, so the
      // rows are not named as a pair and every test below acts on one conversation.
      const sentAt = new Date(Date.now() - 60_000);
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { redirectSentAt: sentAt },
      });
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: widgetInbox.id,
          contactId: mine.contactId,
          chatwootConversationId: 44,
          contactInboxId: 304,
          status: "pending",
          threadId: widgetThread,
          // Activated, because /reset only runs for a conversation a /teste turned on — and these
          // tests type the command HERE, on the thread the ladder is keyed by.
          testActivatedAt: new Date(),
          redirectLinkedAt: new Date(sentAt.getTime() + 1_000),
        },
      });
      try {
        await run(44, widgetThread);
      } finally {
        await suDb.schedulerJob.deleteMany({ where: { tenantId } });
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 44 },
        });
        await suDb.inbox.delete({ where: { id: widgetInbox.id } });
        await suDb.agent.update({
          where: { id: agentId },
          data: { settings: {} },
        });
      }
    };

    // NOTE: a cost fence, not a send gate: a test agent only pays for transcribing a late
    // attachment on a conversation explicitly activated. It has to ask the episode, not the row, or
    // an episode activated on WhatsApp gets no widget-side transcription and the agent later
    // answers a message it never heard.
    test("a late voice note is transcribed when the episode is activated on the other half", async () => {
      await withRedirectPair(async (_convId, _widgetThread) => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 44 },
          data: { testActivatedAt: null },
        });
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { testActivatedAt: new Date() },
        });
        // The fence only has an observable if STT is runnable at all: without it `resolveSttConfig`
        // answers null and nothing is downloaded whatever the fence decides.
        const mine = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV_ID },
          select: { inbox: { select: { agentId: true } } },
        });
        const agentId = mine.inbox?.agentId as bigint;
        const sttKey = await suDb.vaultEntry.create({
          data: {
            tenantId,
            name: `stt-key-${Date.now()}`,
            secret: encryptJson("sk-test"),
          },
          select: { id: true },
        });
        const withStt = await suDb.agent.findUniqueOrThrow({
          where: { id: agentId },
          select: { settings: true },
        });
        await suDb.agent.update({
          where: { id: agentId },
          data: {
            settings: {
              ...(withStt.settings as Record<string, unknown>),
              stt: {
                enabled: true,
                provider: "openai",
                model: "whisper-1",
                credentialRef: `vault:${sttKey.id}`,
              },
            },
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        const audioUrl = "https://203.0.113.9:9/late-note.ogg";
        await sendLateAudio(44, WIDGET_INBOX_ID, audioUrl);
        // NOTE: the fence's only observable is whether the analysis was paid for at all: eager
        // media downloads the attachment.
        expect(cw.calls.some((c) => c.path.endsWith("/late-note.ogg"))).toBe(
          true,
        );
      });
    });

    // NOTE: the same unit, one gate earlier: an ordinary message on the widget half of an activated
    // episode must not get the not-activated notice, which would tell an operator who activated the
    // agent one message ago, on the other channel, to go and activate it. The gate spells its
    // predicate inline (`ctx.mode === "test" && ctx.conv.testActivatedAt === null`) instead of
    // going through `isTestSilenced`, so a sweep for the shared predicate does not turn it up.
    test("an ordinary message is not met with the not-activated notice when the episode is activated", async () => {
      await withRedirectPair(async (_convId, _widgetThread) => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 44 },
          data: { testActivatedAt: null, testNoticeSentAt: null },
        });
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { testActivatedAt: new Date() },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("oi, ainda tá aí?", 44, { inboxId: WIDGET_INBOX_ID });
        const notices = ackCalls(cw.calls).filter((c) =>
          JSON.stringify(c.body ?? {}).includes("modo teste"),
        );
        // NOTE: no one-shot notice on an episode that is activated.
        expect(notices).toEqual([]);
      });
    });

    // NOTE: the activation is on the other half of the episode: `/teste` was typed on WhatsApp
    // after the link, so the entry row carries the stamp and the widget row, where this command is
    // typed, has none. Reading that row alone would answer false and fall through to the test-mode
    // gate, whose one-shot notice is already spent, so a typed command would get nothing at all: no
    // ack, no cleanup, no reason.
    test("/reset runs when the activation is on the episode's other half", async () => {
      await withRedirectPair(async (_convId, _widgetThread) => {
        // The mirror image of what the helper seeds: the widget unstamped, the entry activated.
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 44 },
          data: { testActivatedAt: null },
        });
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { testActivatedAt: new Date() },
        });
        // The one shot is already spent, which is what makes the silence total rather than merely
        // wrong: without this the gate would at least repeat the not-activated notice.
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 44 },
          data: { testNoticeSentAt: new Date() },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("/reset", 44, { inboxId: WIDGET_INBOX_ID });
        // NOTE: a typed command has to answer something.
        expect(ackCalls(cw.calls)).not.toEqual([]);
      });
    });

    // A ladder the worker had ALREADY picked up. Cancelling reaches PENDING rows only, so the row
    // survives — and this ladder's terminal stage posts a closing on both conversations and resolves
    // them, after the operator was told the episode was cleared. The stamp is what an in-flight
    // handler can see, and the row goes terminal with it so nothing is left wedged.
    test("a ladder already claimed is tombstoned, not just skipped", async () => {
      await withRedirectPair(async (_convId, widgetThread) => {
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${widgetThread}`,
            status: "CLAIMED",
            runAt: new Date(),
            payload: { stage: "closing", widgetThreadId: widgetThread },
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        // NOTE: typed on the widget conversation, because that thread is the ladder's key and this
        // command reaches the conversation it was typed on.
        await sendReset("/reset", 44, { inboxId: WIDGET_INBOX_ID });

        const job = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { status: true, payload: true },
        });
        // Terminal, not left CLAIMED: bumping the claim token alone would leave a row the in-flight
        // worker can no longer finish and no claim can pick up again, wedged until the stale sweep
        // records a failure that never happened.
        expect(job.status).toBe("DONE");
        expect(
          (job.payload as { cancelledAt?: string })?.cancelledAt,
        ).toBeString();
      });
    });

    // The jobs are retired BEFORE the anchors are cleared, and this is the gap that ordering closes:
    // a ladder already claimed passes its own fence while nothing has stamped it, runs to its
    // closing, and re-sets `redirectClosedAt` on the row the command just cleared — on a
    // conversation it also resolves.
    test("the jobs are retired before the anchors they could re-set", async () => {
      await withRedirectPair(async (_convId, widgetThread) => {
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${widgetThread}`,
            status: "CLAIMED",
            runAt: new Date(),
            payload: { stage: "closing", widgetThreadId: widgetThread },
          },
        });
        // Observed at the only instant that matters: when the command clears the anchors, is the
        // job already stamped? Asking afterwards proves nothing — both writes land either way.
        let stampedByThen: boolean | null = null;
        const stampedAtClear = () => stampedByThen;
        const watched = appDb.$extends({
          query: {
            $allOperations({ operation, args, query }) {
              const isAnchorClear =
                operation === "update" &&
                Object.hasOwn(
                  ((args as { data?: object }).data ?? {}) as object,
                  "redirectClosedAt",
                );
              if (!isAnchorClear) return query(args);
              return (async () => {
                const row = await suDb.schedulerJob.findFirst({
                  where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
                  select: { payload: true },
                });
                stampedByThen =
                  (row?.payload as { cancelledAt?: unknown } | null)
                    ?.cancelledAt != null;
                return query(args);
              })();
            },
          },
        }) as unknown as PrismaClient;
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("/reset", 44, {
          base: watched,
          inboxId: WIDGET_INBOX_ID,
        });

        expect(stampedAtClear()).toBe(true);
      });
    });

    // The other half of that ordering, and the reason the clear sits where it does rather than at the
    // end. On a conversation the agent still OWNS nothing closes the gate while the command runs (the
    // hand-back is what closes it, and there is nothing to hand back), so every Chatwoot round trip
    // in front of this update is time a customer message can arrive, run a turn, and have its
    // watermarks wiped by it. The order between retirement and clear is fixed the other way round, so
    // the clear cannot lead — what it can do is follow immediately, which is what this pins.
    test("the watermarks are cleared before the command starts calling Chatwoot", async () => {
      let callsByThen: string[] | null = null;
      const cw = fakeChatwoot();
      const watched = appDb.$extends({
        query: {
          $allOperations({ operation, args, query }) {
            const isAnchorClear =
              operation === "update" &&
              Object.hasOwn(
                ((args as { data?: object }).data ?? {}) as object,
                "redirectClosedAt",
              );
            if (isAnchorClear && callsByThen === null) {
              callsByThen = cw.calls.map((c) => c.path);
            }
            return query(args);
          },
        },
      }) as unknown as PrismaClient;
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, { status: "pending", base: watched });

      // It ran at all — a null here would make every assertion below vacuously true.
      expect(callsByThen).not.toBeNull();
      const seen = (callsByThen ?? []).join(" ");
      expect(seen).not.toContain("/custom_attributes");
      expect(seen).not.toContain("/labels");
      // And the same command DOES make those calls, so the assertions above are about ordering
      // rather than about a reset that never reached them.
      const all = cw.calls.map((c) => c.path).join(" ");
      expect(all).toContain("/custom_attributes");
    });

    // The conversation stays actionable while the command runs, so a customer message arriving in
    // that window runs a turn — and that turn can RESCHEDULE, which re-arms the very rows the reset
    // is about to reach. This is the case no age test can tell apart: enqueueJob upserts on
    // `reminder:<eventId>:<offset>`, so the re-armed row is the SAME row, with the same `created_at`.
    // What saves it is the ordering — the retirement runs before this cleanup, so the upsert lands
    // after the tombstone and revives its own row. The Chatwoot double is the rendezvous, and the
    // re-arm goes through the real enqueueJob because the `status: PENDING` it writes is the fact the
    // whole ordering rests on.
    test("a reschedule during the cleanup keeps its reminders", async () => {
      const threadId = `${tenantId}:${instanceId}:${CONV_ID}`;
      await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:evt-1:60",
        runAt: new Date(Date.now() + 3_600_000),
        payload: { threadId, eventId: "evt-1", calendarId: "c" },
        base: suDb,
      });
      const cw = fakeChatwoot();
      const inner = cw.impl;
      let rearmed = false;
      globalThis.fetch = (async (input, init) => {
        if (!rearmed && String(input).includes("/kanban/tasks/")) {
          rearmed = true;
          await enqueueJob({
            rearm: "same-work",
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:evt-1:60",
            runAt: new Date(Date.now() + 7_200_000),
            payload: { threadId, eventId: "evt-1", calendarId: "c" },
            base: suDb,
          });
        }
        return inner(input, init);
      }) as typeof fetch;
      try {
        await sendReset();

        expect(rearmed).toBe(true);
        const row = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, dedupeKey: "reminder:evt-1:60" },
          select: { status: true, payload: true },
        });
        // Live again, and the tombstone gone with the payload the upsert replaced: the handler that
        // eventually claims this row has nothing telling it to stand down.
        expect(row.status).toBe("PENDING");
        expect(
          (row.payload as { cancelledAt?: string })?.cancelledAt,
        ).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
        await suDb.schedulerJob.deleteMany({ where: { tenantId } });
      }
    });

    // The same window on the other kind. The ladder's row is permanent (one per widget thread), so a
    // widget message during the cleanup re-arms THE row the reset is about to retire.
    test("a redirect ladder re-armed during the cleanup survives", async () => {
      const threadId = `${tenantId}:${instanceId}:${CONV_ID}`;
      await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "REDIRECT_FOLLOWUP",
        dedupeKey: `redirect-followup:${threadId}`,
        runAt: new Date(Date.now() + 3_600_000),
        payload: { stage: "chat", widgetThreadId: threadId },
        base: suDb,
      });
      const cw = fakeChatwoot();
      const inner = cw.impl;
      let rearmed = false;
      globalThis.fetch = (async (input, init) => {
        if (!rearmed && String(input).includes("/kanban/tasks/")) {
          rearmed = true;
          await enqueueJob({
            rearm: "same-work",
            tenantId,
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${threadId}`,
            runAt: new Date(Date.now() + 7_200_000),
            payload: { stage: "chat", widgetThreadId: threadId },
            base: suDb,
          });
        }
        return inner(input, init);
      }) as typeof fetch;
      try {
        await sendReset();

        expect(rearmed).toBe(true);
        const row = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
          select: { status: true, payload: true },
        });
        expect(row.status).toBe("PENDING");
        expect(
          (row.payload as { cancelledAt?: string })?.cancelledAt,
        ).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
        await suDb.schedulerJob.deleteMany({ where: { tenantId } });
      }
    });

    // NOTE: a cancel reaches pending rows only, so the one inactivity follow-up that can still post
    // at the customer, the claimed one already inside its model call, needs the stamp. And the
    // hand-back below answers "the bot owns it" to that run's second ownership probe, so the nudge
    // would land right after the acknowledgement.
    test("a follow-up already claimed is tombstoned too", async () => {
      const dedupeKey = `followup:${tenantId}:${instanceId}:${CONV_ID}`;
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey,
          runAt: new Date(),
          status: "CLAIMED",
          payload: { threadId: `${tenantId}:${instanceId}:${CONV_ID}` },
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl as typeof fetch;
      try {
        await sendReset();

        const row = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "FOLLOWUP", dedupeKey },
          select: { payload: true, claimSeq: true },
        });
        expect(
          (row.payload as { cancelledAt?: string })?.cancelledAt,
        ).toBeString();
        // The token moved too, so a sweep re-arming this key cannot bring the stopped run back.
        expect(row.claimSeq).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
        await suDb.schedulerJob.deleteMany({ where: { tenantId } });
      }
    });

    // The one writer this step's lock does not hold back: a turn already inside `graph.invoke`. It
    // saves what it LOADED plus its own messages, so a clear landing mid-invoke is undone the moment
    // it finishes — and the half that is NOT undone is the summary rows and the marker, which nothing
    // restores. So the command refuses the step and says so, instead of confirming a clean slate over
    // memory that is coming back.
    test("a turn still invoking makes the memory step fail rather than half-clear", async () => {
      // The same key the reset locks on: the conversation's contact-inbox, seeded as 301.
      const graphThreadId = contactInboxThreadId(tenantId, instanceId, 301);
      markTurnInFlight(graphThreadId);
      // ANTES, porque a conversa é compartilhada pelo arquivo e um `/reset` bem-sucedido de outro
      // teste já pode ter carimbado a coluna: o que este teste afirma é que a recusa não a MOVE.
      const antes = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { memoryClearedAtMessageId: true },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl as typeof fetch;
      try {
        await sendReset();

        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).toContain("memória");
        // O carimbo da limpeza volta com a recusa: ele é escrito na transação deste passo,
        // antes de `clearContactMemory`, justamente para ser desfeito quando o passo recusa. A
        // cerca da ingestão o lê como prova de que a memória foi esvaziada, e uma prova que
        // sobrevive à recusa descartaria a resposta de um colega de uma memória intacta. O carimbo
        // do COMANDO, escrito por um statement anterior e independente, fica.
        const conv = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV_ID },
          select: { resetAtMessageId: true, memoryClearedAtMessageId: true },
        });
        expect(conv.memoryClearedAtMessageId).toBe(
          antes.memoryClearedAtMessageId,
        );
        // Enquanto o carimbo do COMANDO, escrito por um statement anterior e independente, avançou.
        expect(conv.resetAtMessageId).toBeGreaterThan(
          antes.memoryClearedAtMessageId ?? 0,
        );
      } finally {
        clearTurnInFlight(graphThreadId);
        globalThis.fetch = originalFetch;
      }
    });

    // The control, and the reason the test above is not satisfied by a command that simply always
    // reports a failure: with no turn in flight the same reset clears cleanly.
    test("with no turn in flight the memory step clears", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl as typeof fetch;
      try {
        await sendReset();

        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).not.toContain("memória");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // No status filter on the retirement, and that is deliberate: a row a worker has ALREADY claimed
    // is precisely the in-flight reminder the tombstone exists to stop. Only the stamp reaches it —
    // the handler re-reads it mid-run — so a retirement that skipped CLAIMED rows would let the one
    // reminder that is actively on its way to the customer walk away from the reset.
    test("a reminder already claimed is tombstoned too", async () => {
      const threadId = `${tenantId}:${instanceId}:${CONV_ID}`;
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "APPOINTMENT_REMINDER",
          dedupeKey: "reminder:evt-claimed:60",
          runAt: new Date(Date.now() + 3_600_000),
          status: "CLAIMED",
          payload: { threadId, eventId: "evt-claimed", calendarId: "c" },
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl as typeof fetch;
      try {
        await sendReset();

        const row = await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, dedupeKey: "reminder:evt-claimed:60" },
          select: { payload: true },
        });
        expect(
          (row.payload as { cancelledAt?: string })?.cancelledAt,
        ).toBeString();
      } finally {
        globalThis.fetch = originalFetch;
        await suDb.schedulerJob.deleteMany({ where: { tenantId } });
      }
    });

    // And the opposite fence on the reminders. They are keyed `reminder:<eventId>:<offset>`, so the
    // command has to find them by the thread their payload carries — but going from that thread back
    // to the EVENT and cancelling the whole prefix reaches outside the conversation that typed the
    // command: a reschedule re-arms the surviving offsets with whichever conversation asked for it,
    // while already-fired rows keep the old thread. One reset would then retire a live reminder
    // belonging to a conversation nobody touched.
    test("the reminder cancellation stops at this conversation's thread", async () => {
      const mine = `${tenantId}:${instanceId}:${CONV_ID}`;
      const theirs = `${tenantId}:${instanceId}:45`;
      await suDb.schedulerJob.createMany({
        data: [
          {
            // Fired here, still carrying this thread: the row that names the event.
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:evt-shared:1440",
            status: "DONE",
            runAt: new Date(Date.now() - 3_600_000),
            payload: { threadId: mine, eventId: "evt-shared", calendarId: "c" },
          },
          {
            // Same event, re-armed from ANOTHER conversation after a reschedule.
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:evt-shared:60",
            runAt: new Date(Date.now() + 3_600_000),
            payload: {
              threadId: theirs,
              eventId: "evt-shared",
              calendarId: "c",
            },
          },
        ],
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const rows = await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "APPOINTMENT_REMINDER" },
        select: { dedupeKey: true, status: true, payload: true },
        orderBy: { dedupeKey: "asc" },
      });
      expect(
        rows.map((r) => [
          r.dedupeKey,
          r.status,
          (r.payload as { cancelledAt?: string })?.cancelledAt !== undefined,
        ]),
      ).toEqual([
        // Ours: tombstoned even though it had already fired, because the appointment block is
        // rendered from these rows and cannot tell "cancelled" from "fired".
        ["reminder:evt-shared:1440", "DONE", true],
        // Theirs: untouched, still armed.
        ["reminder:evt-shared:60", "PENDING", false],
      ]);
      await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    });

    // NOTE: the line between what this command owns and what it merely has a token for. The card
    // belongs to this conversation; the contact's Chatwoot attributes are the account's, shared
    // with every conversation of every agent with no record of who wrote a key, so clearing them
    // would delete an operator's CRM field because someone typed /reset in a test conversation.
    test("the contact's Chatwoot attributes are not this command's to delete", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(
        cw.calls.filter(
          (c) =>
            c.method === "PUT" && c.path.endsWith(`/contacts/${CONTACT_CW_ID}`),
        ),
      ).toEqual([]);

      // What the command DOES own on the contact: our own column, written only by our own tool.
      const contact = await suDb.contact.findFirstOrThrow({
        where: { tenantId, chatwootContactId: CONTACT_CW_ID },
        select: { voiceReply: true },
      });
      expect(contact.voiceReply).toBeNull();

      // And the card's attributes, which have no such tension: the card belongs to this conversation.
      const card = cw.calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.path.endsWith(`/kanban/tasks/${KANBAN_TASK_ID}`) &&
          (c.body as { task?: { custom_attributes?: unknown } })?.task
            ?.custom_attributes !== undefined,
      );
      expect(card?.body).toEqual({ task: { custom_attributes: {} } });
    });

    // NOTE: /teste lifts the test-mode silence and nothing else, so on a conversation a human is
    // holding it activates and the agent still says nothing: the acknowledgement must not send the
    // operator there.
    test("the acknowledgement stops telling the operator to send a command that will not help", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/teste", CONV_ID, {
        status: "open",
        assigneeType: "User",
      });
      // The acknowledgement lands as a PRIVATE note here, not a public message: `postPublicMessage`
      // withholds anything the bot no longer owns, which is right for the agent's own output and
      // would silently drop the one sentence explaining the silence.
      const ack = ackCalls(cw.calls)
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      // Names no holder: a human, another persona's bot and a conversation left `open` all reach
      // here, and only "not with this agent" is true of all three.
      expect(ack).toContain("não está com este agente");
      expect(ack).toContain("/reset");
      expect(
        ackCalls(cw.calls).every(
          (c) => (c.body as { private?: boolean })?.private === true,
        ),
      ).toBe(true);

      const cw2 = fakeChatwoot();
      globalThis.fetch = cw2.impl;
      await sendReset("/teste");
      const ack2 = ackCalls(cw2.calls)
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      // Bot-owned: unchanged, and it must NOT name a command with nothing to undo.
      expect(ack2).toBe("🧪 Modo teste ativado para esta conversa.");
    });

    // A SECOND persona bound to the same instance, holding this conversation. Both ownership tests
    // below need the same three rows, and the shape is the load-bearing part: the conversation is
    // `pending` (shouldBotHandle rejects any other status BEFORE it compares bot ids, so an `open`
    // one answers "not ours" for a reason that has nothing to do with which bot is being asked
    // about), and the assignment lives in the MIRROR rather than in the payload, which is the
    // fallback a degraded event takes.
    const seedOtherPersonaHoldingIt = async (): Promise<{
      token: string;
      agentId: bigint;
    }> => {
      const { token, hash } = generateRouteToken();
      const otherAgent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Outra persona",
          systemPrompt: "x",
          mode: "test",
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: otherAgent.id,
          chatwootAgentBotId: 77,
          accessToken: encryptJson(BOT_TOKEN),
          webhookSecret: encryptJson(SECRET),
          webhookRouteTokenHash: hash,
          name: "Outra persona",
        },
      });
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { status: "pending", assigneeType: "AgentBot", assigneeId: 77 },
      });
      return { token, agentId: otherAgent.id };
    };

    // NOTE: which route runs the command. Chatwoot dispatches an incoming message to the
    // conversation's assigned agent bot and to the inbox's, as two deliveries with two ids, and
    // commands are not gated on ownership, so both routes would run the same /reset: two
    // acknowledgements, the second clearing state the first had just rebuilt.
    test("a command delivered on another bot's route is left to the inbox's persona", async () => {
      const { token: otherToken, agentId: otherAgentId } =
        await seedOtherPersonaHoldingIt();
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      // Assigned to bot 77, delivered on bot 77's route, while the inbox's persona is bot 9.
      await sendReset("/reset", CONV_ID, {
        status: "pending",
        silentMeta: true,
        routeToken: otherToken,
      });

      // Consumed and dropped: no reset, and no acknowledgement either — the run belongs to the other
      // delivery. Returning false here instead would hand "/reset" to this bot's agent as customer
      // text.
      expect(cw.calls).toEqual([]);
      await suDb.agent.delete({ where: { id: otherAgentId } });
    });

    // NOTE: when the inbox's persona has no bot at all it cannot answer anywhere (every bot-token
    // call goes out empty and comes back 401), so reading "no id" as "this route is ours" would let
    // a command on another persona's route unassign that working bot and hand the conversation to
    // one that cannot speak.
    test("an inbox with no bot of its own authorizes no route", async () => {
      const { token: otherToken, agentId: otherAgentId } =
        await seedOtherPersonaHoldingIt();
      const ourBot = await suDb.chatwootAgentBot.findFirstOrThrow({
        where: { tenantId, chatwootAgentBotId: 9 },
        select: { id: true, agentId: true, webhookRouteTokenHash: true },
      });
      await suDb.chatwootAgentBot.delete({ where: { id: ourBot.id } });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "pending",
          silentMeta: true,
          routeToken: otherToken,
        });
        expect(cw.calls).toEqual([]);
      } finally {
        await suDb.chatwootAgentBot.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            agentId: ourBot.agentId,
            chatwootAgentBotId: 9,
            accessToken: encryptJson(BOT_TOKEN),
            webhookSecret: encryptJson(SECRET),
            webhookRouteTokenHash: ourBot.webhookRouteTokenHash,
            name: "Atendente",
          },
        });
        await suDb.agent.delete({ where: { id: otherAgentId } });
      }
    });

    // The other half: the inbox's own route DOES run it, on the very conversation the other bot
    // holds. Without this the fence above could be passing by refusing every route.
    test("the inbox's own route runs the command on a conversation another bot holds", async () => {
      const { agentId: otherAgentId } = await seedOtherPersonaHoldingIt();
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "pending",
        silentMeta: true,
      });

      expect(
        cw.calls
          .filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          )
          .map((c) => c.body),
      ).toEqual([{ assignee_id: 9, assignee_type: "AgentBot" }]);
      await suDb.agent.delete({ where: { id: otherAgentId } });
    });

    // NOTE: the mirror wrong in the direction that does nothing. A sparse payload says nothing
    // about ownership, so a missed or delayed assignment webhook leaves the row reading "the bot
    // owns this" about a conversation a human is holding, and every decision this command makes
    // reads that row: the reset would find nothing to undo and acknowledge a clean slate while the
    // human still holds it.
    test("a mirror that missed the assignment does not silence the hand-back", async () => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { status: "pending", assigneeType: null, assigneeId: null },
      });
      // Chatwoot's answer from the FIRST live read on: the human was already there when the operator
      // typed the command, which is what makes this a hand-back and not a takeover.
      const cw = fakeChatwoot(null, { type: "User", id: 77, fromRead: 1 });
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "pending",
        silentMeta: true,
      });

      expect(
        cw.calls
          .filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          )
          .map((c) => c.body),
      ).toEqual([{ assignee_id: 9, assignee_type: "AgentBot" }]);
      // And the acknowledgement does not report a takeover: nobody arrived during the reset, the
      // mirror was simply behind.
      const ack = ackCalls(cw.calls)
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      expect(ack).not.toContain("Alguém assumiu");
    });

    // NOTE: the second thing one in-flight turn breaks, in the opposite direction from the memory
    // step. That turn carries a reply composed before the operator asked for a clean slate, and the
    // human takeover is what keeps it quiet: its ownership recheck (src/graph/runtime.ts) reads the
    // mirror for `pending` and no assignee, exactly what a hand-back writes, so returning the
    // conversation would post the stale reply over the person who claimed it. The test above is the
    // control: same takeover, no turn in flight, and the unassign goes out.
    test("a turn still invoking holds the hand-back back, and says so", async () => {
      const graphThreadId = contactInboxThreadId(tenantId, instanceId, 301);
      markTurnInFlight(graphThreadId);
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { status: "pending", assigneeType: null, assigneeId: null },
      });
      const cw = fakeChatwoot(null, { type: "User", id: 77, fromRead: 1 });
      globalThis.fetch = cw.impl;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "pending",
          silentMeta: true,
        });

        // The operator is told WHY, and what to do about it: this is a retry, not a loss.
        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).toContain("ainda está sendo gerada");
        expect(ack).toContain("/reset de novo");
        // And it is NOT reported as somebody arriving mid-reset: the conversation is with the same
        // person it started with.
        expect(ack).not.toContain("Alguém assumiu");
        // The conversation stayed where the operator found it.
        expect(
          cw.calls.filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toEqual([]);
      } finally {
        clearTurnInFlight(graphThreadId);
        globalThis.fetch = originalFetch;
      }
    });

    // The OTHER marker, and the reason one of them is not the question. A turn claims the
    // per-conversation key at its very first step and the graph key only later, inside the ingest
    // lock — so a turn caught between the two is invoking, and posting into this conversation, while
    // the graph key still reads free. A follow-up nudge never claims the conversation key at all and
    // still posts, which is the same gap from the other side.
    test("a turn that has claimed only the conversation still holds the hand-back back", async () => {
      const convThreadId = chatwootThreadId(tenantId, instanceId, CONV_ID);
      markTurnInFlight(convThreadId);
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_ID },
        data: { status: "pending", assigneeType: null, assigneeId: null },
      });
      const cw = fakeChatwoot(null, { type: "User", id: 77, fromRead: 1 });
      globalThis.fetch = cw.impl;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "pending",
          silentMeta: true,
        });

        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).toContain("ainda está sendo gerada");
        expect(
          cw.calls.filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toEqual([]);
      } finally {
        clearTurnInFlight(convThreadId);
        globalThis.fetch = originalFetch;
      }
    });

    // NOTE: nobody is not a new holder. The fence before the hand-back refuses when somebody
    // arrived meanwhile, but a holder who lets go during the cleanup changes that comparison too,
    // and refusing there would leave `open` with no assignee, the state the agent cannot answer in,
    // while skipping the half that puts the conversation back to `pending`. Its own Chatwoot
    // double, because the shared one always renders an assignee; the release lands on the kanban
    // call, mid-cleanup, the same rendezvous the switch test above uses.
    test("a holder who lets go during the cleanup still gets the conversation back", async () => {
      const cw = fakeChatwoot();
      const inner = cw.impl;
      let released = false;
      globalThis.fetch = (async (input, init) => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        if (!released && url.pathname.includes("/kanban/tasks/")) {
          released = true;
          await suDb.conversation.updateMany({
            where: { tenantId, chatwootConversationId: CONV_ID },
            data: { assigneeType: null, assigneeId: null },
          });
        }
        if (
          method === "GET" &&
          url.pathname.endsWith(`/conversations/${CONV_ID}`)
        ) {
          return new Response(
            JSON.stringify({
              id: CONV_ID,
              kanban_task: { id: KANBAN_TASK_ID },
              status: "open",
              // Before the release a person is holding it; after it, nobody is — which the fork
              // renders by omitting `assignee_type` entirely.
              meta: released
                ? {}
                : { assignee_type: "User", assignee: { id: 77, type: "User" } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return inner(input, init);
      }) as typeof fetch;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
        });

        // The rendezvous really fired, so this is not passing on a cleanup that never got there.
        expect(released).toBe(true);
        // The hand-back RAN: the conversation is handed to the bot, which also puts it back to
        // `pending`, and that is the whole point.
        expect(
          cw.calls
            .filter((c) =>
              c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
            )
            .map((c) => c.body),
        ).toContainEqual({ assignee_id: 9, assignee_type: "AgentBot" });
        // And nobody is blamed for a takeover that did not happen.
        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).not.toContain("Alguém assumiu");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // The agent switched off, restored afterwards: it is shared by every test in this file, so the
    // flag cannot leak.
    const withDisabledAgent = async (
      run: () => Promise<void>,
    ): Promise<void> => {
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { agentId: true },
      });
      const agentId = inbox.agentId as bigint;
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: false },
      });
      try {
        await run();
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { enabled: true },
        });
      }
    };

    // The switch is read the same way ownership is: FRESH, at the moment the hand-back is decided.
    // /reset asks after its cleanup, which is a dozen network calls long, so pairing a fresh
    // ownership read with the agent's state from the top of the function is exactly how the
    // conversation would still be handed to an agent an operator turned off while the command ran.
    // The Chatwoot double doubles as the rendezvous: the switch flips on the card call, mid-cleanup.
    test("the switch is re-read when the hand-back is decided, not before", async () => {
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { agentId: true },
      });
      const agentId = inbox.agentId as bigint;
      const cw = fakeChatwoot();
      const inner = cw.impl;
      let flipped = false;
      globalThis.fetch = (async (input, init) => {
        if (!flipped && String(input).includes("/kanban/tasks/")) {
          flipped = true;
          await suDb.agent.update({
            where: { id: agentId },
            data: { enabled: false },
          });
        }
        return inner(input, init);
      }) as typeof fetch;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
        });

        expect(flipped).toBe(true);
        expect(
          cw.calls.filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { enabled: true },
        });
      }
    });

    // And what a FAILED re-read decides: nothing. The fallback is the value the command already had,
    // because a transient database failure is not evidence that the operator turned the agent on.
    // The mutation this kills is the tempting one — a catch that answers "enabled" — which would hand
    // a human's conversation to a switched-off agent on a blip.
    test("a failed re-read of the switch does not answer for it", async () => {
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { agentId: true },
      });
      const agentId = inbox.agentId as bigint;
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: false },
      });
      // Keyed on the SELECTION, not on a call count: the handler reads the agent twice before this
      // one (the inbox runtime and the command's own context lookup), both of which have to succeed
      // for the command to run at all, and both select more than one column. The re-read under test
      // is the only one that asks for `enabled` alone.
      let reads = 0;
      const flaky = appDb.$extends({
        query: {
          agent: {
            findUnique({ args, query }) {
              const sel = (args.select ?? {}) as Record<string, unknown>;
              if (Object.keys(sel).length === 1 && sel.enabled === true) {
                reads += 1;
                throw new Error("connection reset");
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
          base: flaky,
        });

        expect(reads).toBeGreaterThan(0);
        // Started disabled, the re-read failed, so the answer stays "disabled" and the human keeps
        // the conversation.
        expect(
          cw.calls.filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { enabled: true },
        });
      }
    });

    // The ownership read is asked after the cleanup has already run, so a rejection there would lose
    // the acknowledgement for work that DID happen and leave the delivery mid-flight. Unknown
    // ownership answers `none`: the irreversible half (taking the conversation off a human) is the
    // one that must not fire on a guess.
    test("an ownership read that fails does not strand the command", async () => {
      let fenceReads = 0;
      const blind = appDb.$extends({
        query: {
          conversation: {
            findUnique({ args, query }) {
              if (isOwnershipRead(args.select)) {
                fenceReads += 1;
                return Promise.reject(new Error("connection reset"));
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
        base: blind,
      });

      // Guards the guard: a fence that stopped selecting these columns would make this test pass by
      // injecting nothing at all.
      expect(fenceReads).toBeGreaterThan(0);
      // The command still reports what it did — including the sentence about the hand-back, whose
      // own ownership read is the second place this could have thrown after the cleanup.
      expect(ackCalls(cw.calls).length).toBeGreaterThan(0);
      // ...and did not take the conversation from the human on an answer it does not have.
      expect(
        cw.calls.filter((c) =>
          c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
        ),
      ).toEqual([]);
    });

    // NOTE: the third late read. The turn half of the fence is a row read, so it can fail, and it
    // sits after the cleanup, outside every step: a rejection reaching the command would lose the
    // acknowledgement for work that did happen and leave the delivery to retry. Driven by rejecting
    // the claim query alone, matched on the column only it selects, so the cleanup's own reads of
    // the same table are untouched.
    test("a claim read that fails does not strand the command", async () => {
      let refused = 0;
      const blind = appDb.$extends({
        query: {
          async $allOperations({ operation, args, query }) {
            if (operation === "$queryRaw") {
              const sql = ((args as { strings?: string[] }).strings ?? []).join(
                " ",
              );
              // NOTE: the claim read (`readTurnClaimOn`), matched by the projection only it has.
              // Matched on the SQL because faking a broken read is the whole point of this fixture.
              if (sql.includes("AS holders")) {
                refused += 1;
                throw new Error("connection reset");
              }
            }
            return query(args);
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
        base: blind,
      });

      // The read the test is about actually ran; without this the assertions below would pass on a
      // command that never reached it.
      expect(refused).toBeGreaterThan(0);
      expect(ackCalls(cw.calls).length).toBeGreaterThan(0);
      // And an unreadable claim reads as a turn still running, so the conversation stays with the
      // human rather than being taken from them on an answer nobody has.
      expect(
        cw.calls.filter((c) =>
          c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
        ),
      ).toEqual([]);
    });

    // The same guard on the OTHER late ownership read: the sentence that explains a withheld
    // hand-back asks the question again, after everything has run. It reaches that line only while
    // the agent is disabled, which is why the failure has to be driven with the switch off.
    test("a disabled agent still acknowledges when ownership cannot be read", async () => {
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { agentId: true },
      });
      const agentId = inbox.agentId as bigint;
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: false },
      });
      let fenceReads = 0;
      const blind = appDb.$extends({
        query: {
          conversation: {
            findUnique({ args, query }) {
              if (isOwnershipRead(args.select)) {
                fenceReads += 1;
                return Promise.reject(new Error("connection reset"));
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      try {
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
          base: blind,
        });

        expect(fenceReads).toBeGreaterThan(0);
        expect(ackCalls(cw.calls).length).toBeGreaterThan(0);
        expect(
          cw.calls.filter((c) =>
            c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
          ),
        ).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { enabled: true },
        });
      }
    });

    // And the row being GONE, which is the other thing a re-read can find. Deleting the agent while
    // the command runs is narrow, but the answer has to be the same one the loud case gets: nothing
    // can answer here, so the human keeps the conversation.
    test("an agent that no longer exists does not get the conversation either", async () => {
      const vanished = appDb.$extends({
        query: {
          agent: {
            findUnique({ args, query }) {
              const sel = (args.select ?? {}) as Record<string, unknown>;
              // Promise.resolve, not a bare null: Prisma awaits whatever the hook returns, and a
              // plain null makes it throw — which would land in the catch and prove the wrong branch.
              if (Object.keys(sel).length === 1 && sel.enabled === true)
                return Promise.resolve(null);
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset("/reset", CONV_ID, {
        status: "open",
        assigneeType: "User",
        base: vanished,
      });

      expect(
        cw.calls.filter((c) =>
          c.path.endsWith(`/conversations/${CONV_ID}/assignments`),
        ),
      ).toEqual([]);
    });

    test("a disabled agent does not get a conversation a human is holding", async () => {
      await withDisabledAgent(async () => {
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("/reset", CONV_ID, {
          status: "open",
          assigneeType: "User",
        });

        expect(
          cw.calls.filter(
            (c) =>
              c.path.endsWith(`/conversations/${CONV_ID}/assignments`) ||
              c.path.endsWith(`/conversations/${CONV_ID}/toggle_status`),
          ),
        ).toEqual([]);
        // The memory clear still ran — this is a reset, not a refusal.
        expect(
          cw.calls.some((c) => c.path.endsWith("/custom_attributes")),
        ).toBe(true);
        // And the operator is told, because the assignment is the one part they can see not happening.
        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).toContain("desativado");
        expect(ack).toContain("continua com quem a atendia");
      });
    });

    // The half the ownership question hides. On a conversation the agent already owns there is
    // nobody to hand it back to, so every guard above is quiet and the reset reads as clean — while
    // the operator who typed it is about to watch the agent answer nothing. Ownership is set to the
    // bot explicitly, for the reason the /teste version of this test states: with it absent the two
    // reasons agree and the assertion proves nothing about which one is asked.
    test("a disabled agent is named even on a conversation it still owns", async () => {
      await withDisabledAgent(async () => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { status: "pending", assigneeType: null, assigneeId: null },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("/reset", CONV_ID, { status: "pending" });

        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).toContain("desativado");
        // And not the ownership half of it: there is no "quem a atendia" here, so that clause would
        // be a sentence about a person who does not exist.
        expect(ack).not.toContain("continua com quem a atendia");
        expect(ack).not.toContain("Alguém assumiu");
      });
    });

    // NOTE: the same question in the two texts that answer it. Naming /reset to an operator whose
    // agent is switched off sends them to a command that runs and still cannot help.
    test("a disabled agent names no command it cannot honour", async () => {
      await withDisabledAgent(async () => {
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("/teste", CONV_ID, {
          status: "open",
          assigneeType: "User",
        });
        const ack = ackCalls(cw.calls)
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(ack).toContain("desativado");
        expect(ack).not.toContain("/reset");

        // NOTE: on a conversation the agent does own, the switch still decides: "Modo teste
        // ativado" alone would imply activation is enough to answer, and here nothing can.
        // Ownership is set explicitly, because with it absent the two reasons agree and the test
        // would prove nothing about which one is asked first.
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: CONV_ID },
          data: { status: "pending", assigneeType: null, assigneeId: null },
        });
        const cw2 = fakeChatwoot();
        globalThis.fetch = cw2.impl;
        await sendReset("/teste");
        expect(
          ackCalls(cw2.calls)
            .map((c) => (c.body as { content?: string })?.content ?? "")
            .join(" "),
        ).toContain("desativado");
      });
    });

    // And the third text that answers it: the one-shot note on a conversation nobody ever activated.
    // It has one shot, so naming the wrong reason there costs the operator every later chance.
    test("the un-activated notice names the switch, not the assignment", async () => {
      await withDisabledAgent(async () => {
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            inboxId: (
              await suDb.inbox.findFirstOrThrow({
                where: { tenantId, chatwootInboxId: INBOX_ID },
                select: { id: true },
              })
            ).id,
            chatwootConversationId: 50,
            contactInboxId: 310,
            status: "open",
            threadId: `${tenantId}:${instanceId}:50`,
            testActivatedAt: null,
          },
        });
        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        await sendReset("/reset", 50, { status: "open", assigneeType: "User" });

        const notes = cw.calls
          .filter((c) => c.method === "POST" && c.path.endsWith("/messages"))
          .map((c) => (c.body as { content?: string })?.content ?? "")
          .join(" ");
        expect(notes).toContain("desativado");
        expect(notes).not.toContain("/reset");
        await suDb.conversation.deleteMany({
          where: { tenantId, chatwootConversationId: 50 },
        });
      });
    });

    // The notice fires only while the conversation was NEVER activated, and /reset needs
    // `testActivatedAt` to run at all — so naming /reset alone would send the operator down the same
    // no-op path, and the one-shot watermark would then suppress any second chance to tell them.
    test("the un-activated notice names both commands, in the order that works", async () => {
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: (
            await suDb.inbox.findFirstOrThrow({
              where: { tenantId, chatwootInboxId: INBOX_ID },
              select: { id: true },
            })
          ).id,
          chatwootConversationId: 43,
          contactInboxId: 303,
          status: "open",
          threadId: `${tenantId}:${instanceId}:43`,
          // Never activated: this is the state the notice speaks in.
          testActivatedAt: null,
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      // A /reset typed here: it cannot run (no testActivatedAt) and falls through to the notice,
      // which is exactly the path whose wording this asserts.
      await sendReset("/reset", 43, { status: "open", assigneeType: "User" });

      const notes = cw.calls
        .filter((c) => c.method === "POST" && c.path.endsWith("/messages"))
        .map((c) => (c.body as { content?: string })?.content ?? "")
        .join(" ");
      expect(notes).toContain("/teste");
      expect(notes).toContain("/reset");
      // NOTE: the order matters: /reset before /teste would be a no-op here.
      expect(notes.indexOf("/teste")).toBeLessThan(notes.indexOf("/reset"));
      await suDb.conversation.deleteMany({
        where: { tenantId, chatwootConversationId: 43 },
      });
    });

    // NOTE: `reset_at_message_id` is the id of the command's own message and the cleanup that
    // follows is a dozen un-serialized calls, so every row the command wrote carries a higher id
    // and looks like the erased episode's history to the next reader. The acknowledgement is posted
    // once every step has run, so its id marks the end of that stretch, if it is findable, which is
    // what this name is for (src/modules/chatwoot/constants.ts).
    test("the acknowledgement carries the name that says where the cleanup ended", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      const body = acks[0]?.body as {
        content_attributes?: { fazer_ai_send_id?: unknown };
      } | null;
      expect(body?.content_attributes?.fazer_ai_send_id).toBe(
        `reset-ack:${9000 + deliverySeq}`,
      );
    });

    // NOTE: the name above answers an order question, but the label-change activity is written by
    // `Conversations::ActivityMessageJob.perform_later` and can land after the acknowledgement on a
    // backed-up queue. So the command records the set it removed: a removal line whose titles are
    // all in that set is the reset's own, at any id. It lives on our row, not in the
    // acknowledgement's `content_attributes`: the widget renders that bag verbatim to the contact
    // (`api/v1/widget/messages/index.json.jbuilder`) and `Message#push_event_data` ships it whole,
    // so internal label names would reach the customer on a website inbox.
    test("the reset records the labels it took off, on the conversation row", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { resetClearedLabels: true, resetAtMessageId: true },
      });
      expect(conv.resetClearedLabels).toEqual([...LIVE_LABELS]);
      // Paired with the boundary of the command that removed them: read apart, a second reset
      // landing between the two queries would hand the observer one reset's boundary and the
      // other's set.
      expect(conv.resetAtMessageId).toBe(9000 + deliverySeq);
      // And the set is the one this very write replaced: read inside the label queue, before the
      // POST that empties it.
      expect(
        cw.calls.filter((c) => c.path.endsWith("/labels")).map((c) => c.method),
      ).toEqual(["GET", "POST"]);
      // THE PUBLIC MESSAGE SAYS NOTHING ABOUT THE ACCOUNT'S OWN STATE. Its bag carries the name of
      // the send and nothing else, which is what keeps the contact out of this.
      const bag = (
        ackCalls(cw.calls)[0]?.body as {
          content_attributes?: Record<string, unknown>;
        } | null
      )?.content_attributes;
      expect(Object.keys(bag ?? {})).toEqual(["fazer_ai_send_id"]);
    });

    // A clear that never returned removed nothing this side can name, and NULL says exactly that:
    // the labels are still standing, so their activity lines are still true and must not be hidden.
    test("a clear that failed records no set instead of claiming one", async () => {
      // After a healthy reset, which is the arrangement that matters: the boundary moves on
      // every command and the set is written only when the clear succeeds, so a column left alone
      // here would pair this reset's boundary with the previous reset's set, and the observer would
      // hide genuine removals instead of falling back to the order cut. Nulling the column by hand
      // first would mask exactly that.
      const healthy = fakeChatwoot();
      globalThis.fetch = healthy.impl;
      await sendReset();
      expect(
        (
          await suDb.conversation.findFirstOrThrow({
            where: { tenantId, chatwootConversationId: CONV_ID },
            select: { resetClearedLabels: true },
          })
        ).resetClearedLabels,
      ).toEqual([...LIVE_LABELS]);

      const cw = fakeChatwoot(/\/labels$/);
      globalThis.fetch = cw.impl;
      await sendReset();

      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { resetClearedLabels: true },
      });
      expect(conv.resetClearedLabels).toBeNull();
      expect(
        String((ackCalls(cw.calls)[0]?.body as { content?: unknown })?.content),
      ).toMatch(/etiquetas/i);
    });

    // NOTE: the snapshot is not the step. Reading the labels is bookkeeping for a later reader;
    // clearing them is what the operator asked for, so a failed read must not abort the clear and
    // leave the labels on the conversation while the POST endpoint works.
    test("a snapshot that failed does not stop the clear", async () => {
      await suDb.$executeRaw`
        UPDATE conversations SET reset_cleared_labels = NULL
         WHERE tenant_id = ${tenantId} AND chatwoot_conversation_id = ${CONV_ID}`;
      const cw = fakeChatwoot(
        (method, path) => method === "GET" && path.endsWith("/labels"),
      );
      globalThis.fetch = cw.impl;
      await sendReset();

      // The clear went out anyway, with an empty set, which is the command's whole job here.
      const post = cw.calls.find(
        (c) => c.method === "POST" && c.path.endsWith("/labels"),
      );
      expect(post).toBeDefined();
      expect((post?.body as { labels?: unknown })?.labels).toEqual([]);
      // No claim: the observer falls back to the order cut rather than to a set nobody read. Asked
      // as SQL, because the two nulls of a jsonb column are not the same thing: a written `'null'`
      // reads back as `null` through the client and answers FALSE to `IS NULL`, so every later
      // query about "no claim" would disagree with this assertion.
      expect(
        await suDb.$queryRaw<{ sql_null: boolean }[]>`
          SELECT reset_cleared_labels IS NULL AS sql_null
            FROM conversations
           WHERE tenant_id = ${tenantId}
             AND chatwoot_conversation_id = ${CONV_ID}`,
      ).toEqual([{ sql_null: true }]);
      // And the operator is not told the labels survived, because they did not.
      expect(
        String((ackCalls(cw.calls)[0]?.body as { content?: unknown })?.content),
      ).not.toMatch(/Reset parcial/);
    });

    // A SECOND RESET DOES NOT INHERIT THE FIRST ONE'S SET. `reset_at_message_id` only moves forward
    // (GREATEST), and two deliveries are dispatched detached, so the write is fenced on owning the
    // current boundary: an older command finishing last must not pair a newer boundary with its own
    // set.
    test("the set belongs to the reset that owns the boundary", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();
      const first = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { resetAtMessageId: true },
      });
      // The boundary jumps ahead of the next command's own message id, the way a newer reset would
      // have left it, and then the reset runs with nothing standing on the conversation.
      await suDb.$executeRaw`
        UPDATE conversations SET reset_at_message_id = ${(first.resetAtMessageId ?? 0) + 10_000}
         WHERE tenant_id = ${tenantId} AND chatwoot_conversation_id = ${CONV_ID}`;
      await suDb.$executeRaw`
        UPDATE conversations SET reset_cleared_labels = '["de-antes"]'::jsonb
         WHERE tenant_id = ${tenantId} AND chatwoot_conversation_id = ${CONV_ID}`;
      await sendReset();

      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: CONV_ID },
        select: { resetClearedLabels: true },
      });
      expect(conv.resetClearedLabels).toEqual(["de-antes"]);
    });

    test("a partial reset is not announced as a full one", async () => {
      const cw = fakeChatwoot(/\/custom_attributes$/);
      globalThis.fetch = cw.impl;
      await sendReset();

      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      const text = String(
        (acks[0]?.body as { content?: unknown } | null)?.content ?? "",
      );
      expect(text).not.toBe(
        "🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos.",
      );
      expect(text).toMatch(/atributos/i);
    });

    // The test-mode gate's private note carries a one-shot watermark, and the note is the only thing
    // that tells whoever watches the inbox WHY the bot is silent and how to activate it. A note the
    // API refused was never delivered, so stamping it would spend that one shot on nothing.
    test("a test-mode notice the API refused does not spend its one shot", async () => {
      const convId = 43;
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { id: true },
      });
      const row = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: inbox.id,
          chatwootConversationId: convId,
          contactInboxId: 302,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${convId}`,
        },
        select: { id: true },
      });

      const failing = fakeChatwoot(/\/messages$/);
      globalThis.fetch = failing.impl;
      await sendReset("oi, tem alguém?", convId);
      expect(
        (
          await suDb.conversation.findUniqueOrThrow({
            where: { id: row.id },
            select: { testNoticeSentAt: true },
          })
        ).testNoticeSentAt,
      ).toBeNull();

      // Still owed: the next message delivers it, and only then is the shot spent.
      const healthy = fakeChatwoot();
      globalThis.fetch = healthy.impl;
      await sendReset("alguém aí?", convId);
      expect(
        (
          await suDb.conversation.findUniqueOrThrow({
            where: { id: row.id },
            select: { testNoticeSentAt: true },
          })
        ).testNoticeSentAt,
      ).not.toBeNull();
      expect(
        healthy.calls.filter(
          (c) => c.method === "POST" && c.path.endsWith("/messages"),
        ),
      ).toHaveLength(1);
    });

    test("a clean reset still announces the full success", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      expect(
        String((acks[0]?.body as { content?: unknown } | null)?.content ?? ""),
      ).toBe(
        "🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos.",
      );
    });
  },
);
