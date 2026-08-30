import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId, getCheckpointer } from "@/graph/checkpointer";
import { memoryHeadMessage } from "@/graph/markers";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { createChatwootClient } from "@/modules/chatwoot/client";
import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";
import {
  receiveChatwootWebhook,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { seedChatwootInstance } from "../utils/chatwoot";

const BOT_TOKEN = "BOT-TOKEN";
const ADMIN_TOKEN = "ADMIN-TOKEN";
const SECRET = "stale-turn-secret";
const CONV_ID = 71;
const INBOX_ID = 7;
const CONTACT_CW_ID = 909;
const CONTACT_INBOX_ID = 371;
const REPLY = "RESPOSTA-DO-TURNO-DE-ANTES";
const ATTR_KEY = "qualificado";

// The model of the turn that is already running when the operator types /reset: it calls a tool
// that WRITES to Chatwoot and then answers. Both halves matter and they fail differently — the
// answer is stopped by the supersede gate (the /reset message advances the handled watermark past
// this turn's trigger), the tool call is stopped by nothing at all.
class SetAttributeThenReplyModel {
  calls = 0;
  async invoke(): Promise<AIMessage> {
    this.calls += 1;
    return new AIMessage(REPLY);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        self.calls += 1;
        n++;
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "set_custom_attribute",
                  args: { key: ATTR_KEY, value: "sim" },
                  id: "call_attr",
                },
              ],
            })
          : new AIMessage(REPLY);
      },
    };
  }
}

interface CwCall {
  method: string;
  path: string;
  token: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeChatwoot(): { calls: CwCall[]; impl: typeof fetch } {
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
    if (token.trim() === "")
      return jsonResponse({ error: "Invalid Access Token" }, 401);
    if (method === "GET" && url.pathname.endsWith(`/conversations/${CONV_ID}`))
      return jsonResponse({
        id: CONV_ID,
        status: "pending",
        meta: { assignee_type: null, assignee: null },
      });
    if (method === "GET" && url.pathname.endsWith("/messages"))
      return jsonResponse({ payload: [] });
    if (
      method === "GET" &&
      url.pathname.endsWith("/custom_attribute_definitions")
    )
      return jsonResponse([]);
    if (method === "GET" && url.pathname.endsWith(`/contacts/${CONTACT_CW_ID}`))
      return jsonResponse({
        payload: { id: CONTACT_CW_ID, custom_attributes: {} },
      });
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

let tenantId = 0n;
let instanceId = 0n;
let routeToken = "";
let seq = 0;
const originalFetch = globalThis.fetch;

async function deliver(
  content: string,
  deps?: Parameters<typeof recordAndProcessChatwootDelivery>[0]["deps"],
): Promise<void> {
  seq += 1;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: "message_created",
    id: 7000 + seq,
    content,
    message_type: "incoming",
    private: false,
    conversation: {
      id: CONV_ID,
      inbox_id: INBOX_ID,
      status: "pending",
      contact_inbox: { id: CONTACT_INBOX_ID },
      meta: {
        assignee_type: null,
        assignee: null,
        sender: { id: CONTACT_CW_ID, name: "Cliente" },
      },
      channel: "Channel::Api",
      last_activity_at: nowSeconds,
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
        "x-chatwoot-delivery": `stale-${seq}`,
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
    deps,
  });
}

const attributeWrites = (calls: CwCall[]) =>
  calls.filter(
    (c) =>
      c.method !== "GET" &&
      JSON.stringify(c.body ?? {}).includes(`"${ATTR_KEY}"`),
  );

describe.skipIf(!dbUp)("a turn already running when /reset lands", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Stale", slug: `stale-${process.pid}` },
    });
    tenantId = t.id;
    const { token, hash } = generateRouteToken();
    routeToken = token;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://203.0.113.10:9",
      adminToken: encryptJson(ADMIN_TOKEN),
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
        systemPrompt: "x",
        mode: "test",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        // Debounce OFF is what makes this the DIRECT path: a debounced flush is a queued turn, and
        // /reset retires its job. The direct turn has no job, which is the whole subject here.
        settings: { debounce: { enabled: false }, split: { enabled: false } },
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
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        contactId: contact.id,
        chatwootConversationId: CONV_ID,
        contactInboxId: CONTACT_INBOX_ID,
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

  test("does not act on the conversation the operator just cleared", async () => {
    const threadId = contactInboxThreadId(
      tenantId,
      instanceId,
      CONTACT_INBOX_ID,
    );
    const cp = await getCheckpointer();
    const graph = buildThreadStateGraph(cp);
    const cfg = { configurable: { thread_id: threadId } };
    await graph.updateState(
      cfg,
      { messages: [memoryHeadMessage("MEMÓRIA DE ATENDIMENTOS ANTERIORES")] },
      THREAD_STATE_NODE,
    );
    await graph.updateState(
      cfg,
      { messages: [new HumanMessage("orçamento de R$ 250 aprovado")] },
      THREAD_STATE_NODE,
    );
    await suDb.agentThread.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId: CONTACT_INBOX_ID,
        threadId,
        lastConversationId: CONV_ID,
      },
    });

    const cw = fakeChatwoot();
    globalThis.fetch = cw.impl;

    const model = new SetAttributeThenReplyModel();
    // The stretch no fence covers: the delivery path's own client build, before the turn takes its
    // durable claim. Held open so the /reset lands squarely inside it and completes.
    const inStretch = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let builds = 0;
    const turn = deliver("e o desconto, sai?", {
      makeModel: () => model as unknown as BaseChatModel,
      makeClient: async (cfgIn) => {
        builds += 1;
        if (builds === 1) {
          inStretch.resolve();
          await held.promise;
        }
        return createChatwootClient(cfgIn);
      },
    });

    await Promise.race([
      inStretch.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("the turn never reached its client build");
      }),
    ]);
    await deliver("/reset");
    const afterReset = cw.calls.length;
    held.resolve();
    await turn;

    // The erasure, undone: the tool wrote the attribute back on a conversation the operator was
    // just told had been cleared. Counted AFTER the reset's own calls, so the assertion is about
    // what the stale turn did, not about what the command did.
    expect(attributeWrites(cw.calls.slice(afterReset))).toEqual([]);
    // And the model was asked at all, which is the billed call the reset should have stood down.
    expect(model.calls).toBe(0);
    // The thread the reset cleared stays cleared.
    const msgs =
      ((await graph.getState(cfg)).values as { messages?: unknown[] })
        .messages ?? [];
    expect(msgs).toEqual([]);
    expect(
      await suDb.agentThread.findFirst({
        where: { tenantId, contactInboxId: CONTACT_INBOX_ID },
        select: { lastConversationId: true },
      }),
    ).toBeNull();
  }, 30000);

  // The question the source fence in tests/modules/delivery-sweep.test.ts was holding open: with a
  // run that CAN be called off, does this path still settle on every outcome, or does it need the
  // exception the debounce flush has (which keeps "stale" open, because there the withdrawal means
  // nothing ever answered the burst)?
  //
  // It settles, and the reason is what a replay would do. The row is only left open so the sweep can
  // run the delivery path again — into the conversation the operator just cleared, with the message
  // from before it. That is the defect this whole change closes, arriving thirty minutes later
  // through the recovery instead of immediately through the turn. "Consumed" is also the honest
  // word: a command withdrew the episode, which is the same thing the gate's own consumed rows say.
  test("settles the message it withdrew, instead of leaving it for the sweep to replay", async () => {
    const messageId = 7000 + seq + 1;
    // A sibling row for the SAME message, already reported as a loss — the shape the settle exists
    // for, since a delivery's own row reaches PROCESSED through its CAS either way.
    const sibling = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `sibling-${process.pid}-${messageId}`,
        event: "message_created",
        status: "DEAD",
        conversationId: CONV_ID,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });

    const cw = fakeChatwoot();
    globalThis.fetch = cw.impl;
    const inStretch = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let builds = 0;
    const turn = deliver("e aí, respondeu?", {
      makeModel: () =>
        new SetAttributeThenReplyModel() as unknown as BaseChatModel,
      makeClient: async (cfgIn) => {
        builds += 1;
        if (builds === 1) {
          inStretch.resolve();
          await held.promise;
        }
        return createChatwootClient(cfgIn);
      },
    });
    await Promise.race([
      inStretch.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("the turn never reached its client build");
      }),
    ]);
    await deliver("/reset");
    held.resolve();
    await turn;

    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: sibling.id },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSED");
  }, 30000);

  // The control, and it is what says the fence reads the EPISODE rather than "a reset ever
  // happened": the conversation above carries a `resetAt` now, and a turn that starts after it
  // answers normally.
  test("a turn that starts after the reset answers as usual", async () => {
    const cw = fakeChatwoot();
    globalThis.fetch = cw.impl;
    const model = new SetAttributeThenReplyModel();
    await deliver("bom dia", { makeModel: () => model as never });

    expect(model.calls).toBeGreaterThan(0);
    expect(
      cw.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path.endsWith("/messages") &&
          String((c.body as { content?: string })?.content ?? "").includes(
            REPLY,
          ),
      ),
    ).toBe(true);
  }, 30000);
});
