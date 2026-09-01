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
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type ToolMessage,
} from "@langchain/core/messages";
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
// The authorization endpoint the pre-turn gate calls. TEST-NET-3 on the discard port, like the
// instance URL: nothing is dialed, `globalThis.fetch` is the double.
const AUTH_URL = "https://203.0.113.11:9/authorize";

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

function fakeChatwoot(
  // Called when the contact-authorization endpoint is hit. The pre-turn gate is the seam this suite
  // parks a delivery in: it sits before the turn's own reads, and it reaches the network.
  onAuthorize?: () => Promise<void>,
  // Called on the command's live conversation read, which is how a test parks the /RESET itself
  // mid-flight and lands a customer message inside it. It fires on the command's FIRST live read,
  // which happens before the episode boundary is written — see `onAfterBoundary` for the other side.
  onLiveRead?: () => Promise<void>,
  // Called when anything posts a message. The one test that uses it arms it only once the TURN is
  // parked in its model call, so the first post that reaches it is the command's acknowledgement —
  // its last act inside the gate, with the boundary already written and its own watermark advance
  // still to come.
  onAfterBoundary?: () => Promise<void>,
): { calls: CwCall[]; impl: typeof fetch } {
  const calls: CwCall[] = [];
  const impl = (async (input, init) => {
    const url = new URL(String(input));
    if (String(input).startsWith(AUTH_URL)) {
      await onAuthorize?.();
      return jsonResponse({ authorized: true });
    }
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
    if (method === "POST" && url.pathname.endsWith("/messages")) {
      await onAfterBoundary?.();
      return jsonResponse({ id: 1 });
    }
    if (
      method === "GET" &&
      url.pathname.endsWith(`/conversations/${CONV_ID}`)
    ) {
      await onLiveRead?.();
      return jsonResponse({
        id: CONV_ID,
        status: "pending",
        meta: { assignee_type: null, assignee: null },
      });
    }
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
        // The authorization gate has nothing to ask about without one, and answers `no_identity`
        // before it ever reaches the endpoint this suite parks in.
        phone: "+5511955554444",
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

  // The window the round-1 review named, and the one the turn's OWN read cannot cover: the command
  // overtakes the delivery before it ever loads a config. The mark then already carries the
  // operator's write, so a baseline captured there would be compared against itself and every later
  // ask would pass — the model runs and the tools fire, with only the final reply superseded.
  //
  // Parked in the contact-authorization call, which is a real pre-turn gate that reaches the network
  // (docs/contact-auth.md). What makes it the right seam is not the endpoint but the position: it
  // runs after the mirror write, which is where the delivery reads the mark it carries.
  test("stands down even when the command overtook it before the turn loaded anything", async () => {
    await suDb.agent.updateMany({
      where: { tenantId },
      data: {
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          contactAuth: { enabled: true, url: AUTH_URL, mode: "perMessage" },
        },
      },
    });
    const inGate = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let gated = false;
    const cw = fakeChatwoot(async () => {
      if (gated) return;
      gated = true;
      inGate.resolve();
      await held.promise;
    });
    globalThis.fetch = cw.impl;

    const model = new SetAttributeThenReplyModel();
    const turn = deliver("dá pra parcelar?", {
      makeModel: () => model as unknown as BaseChatModel,
    });
    try {
      await Promise.race([
        inGate.promise,
        Bun.sleep(10_000).then(() => {
          throw new Error("the delivery never reached the authorization gate");
        }),
      ]);
      await deliver("/reset");
      const afterReset = cw.calls.length;
      held.resolve();
      await turn;

      expect(attributeWrites(cw.calls.slice(afterReset))).toEqual([]);
      expect(model.calls).toBe(0);
    } finally {
      // The gate is this test's alone: left on, it refuses every turn the tests below drive.
      held.resolve();
      await suDb.agent.updateMany({
        where: { tenantId },
        data: {
          settings: { debounce: { enabled: false }, split: { enabled: false } },
        },
      });
    }
  }, 30000);

  // THE BOUNDARY OF THIS FENCE, measured rather than asserted. Once the turn holds the durable claim
  // the model call is in flight, and the asks that guard it have all been answered. What the command
  // does THERE is refuse its own memory step, on the claim, and say so in the acknowledgement — so
  // the operator is told the conversation was not fully cleared and /reset is a command they can
  // type again, which is what makes this window a different defect from the one #428 closed (there
  // the command completes and says nothing). The tools of that same turn are stopped by the fence
  // the two tests below measure (issue #449), which is a seam of its own inside the invoke.
  test("a command landing mid-invoke is refused, and says so", async () => {
    const inModel = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const cw = fakeChatwoot();
    globalThis.fetch = cw.impl;
    const model = new SetAttributeThenReplyModel();
    const parked = {
      invoke: model.invoke.bind(model),
      bindTools: (tools: unknown) => {
        const bound = model.bindTools(tools);
        return {
          invoke: async () => {
            inModel.resolve();
            await held.promise;
            return bound.invoke();
          },
        };
      },
    };
    const turn = deliver("consegue ver meu pedido?", {
      makeModel: () => parked as unknown as BaseChatModel,
    });
    await Promise.race([
      inModel.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("the turn never reached the model call");
      }),
    ]);
    await deliver("/reset");
    held.resolve();
    await turn;

    const ack = cw.calls
      .filter((c) => c.method === "POST" && c.path.endsWith("/messages"))
      .map((c) => String((c.body as { content?: string })?.content ?? ""))
      .find((t) => t.includes("🔄") || t.includes("memória"));
    // The command reports the step it could not do, instead of confirming a clean slate.
    expect(ack ?? "").toContain("memória");
  }, 30000);

  // A TOOL-CALL ID OF THIS TEST'S OWN, and it is not hygiene. The stub above hardcodes `call_attr`
  // and every test in this file writes to the SAME thread, so a second call under that id is
  // REPLACED IN PLACE by the messages reducer instead of appended: the tool result lands back at the
  // earlier test's position, the model's next round sees an assistant turn nothing answered, and the
  // tool never writes. Measured — with the shared id the two tests below pass on the code they exist
  // to fail against, and the Chatwoot double records no attribute write at all.
  const parkedModel = (
    callId: string,
  ): {
    model: SetAttributeThenReplyModel;
    parked: BaseChatModel;
    turnCalls: () => number;
    reached: Promise<void>;
    release: () => void;
  } => {
    const inModel = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const model = new SetAttributeThenReplyModel();
    // Counted HERE and not off `model.calls`, which any model the delivery builds increments — the
    // output guardrail and the compaction summary share this `makeModel`. This counts the TURN's.
    let turnCalls = 0;
    const parked = {
      invoke: model.invoke.bind(model),
      bindTools: (tools: unknown) => {
        const bound = model.bindTools(tools);
        return {
          invoke: async () => {
            turnCalls += 1;
            inModel.resolve();
            await held.promise;
            const out = await bound.invoke();
            const call = out.tool_calls?.[0];
            if (call) call.id = callId;
            return out;
          },
        };
      },
    } as unknown as BaseChatModel;
    return {
      model,
      parked,
      turnCalls: () => turnCalls,
      reached: Promise.race([
        inModel.promise,
        Bun.sleep(10_000).then(() => {
          throw new Error("the turn never reached the model call");
        }),
      ]),
      release: () => held.resolve(),
    };
  };

  // ISSUE #449, the other half of the window the test above measures. The command IS refused on its
  // memory step and says so — and the turn's tools then act on the very conversation the operator
  // was just told about: `set_custom_attribute` writes the attribute back. The acknowledgement's
  // failure list names the memory step alone, so nothing anywhere says it came back.
  //
  // Counted from AFTER the command's own calls, so what is asserted is what the STALE TURN did.
  test("a tool call started before the command lands does not write after it", async () => {
    const cw = fakeChatwoot();
    globalThis.fetch = cw.impl;
    const m = parkedModel("call_attr_449_write");
    const turn = deliver("dá para marcar como qualificado?", {
      makeModel: () => m.parked,
    });
    await m.reached;
    await deliver("/reset");
    const afterReset = cw.calls.length;
    m.release();
    await turn;

    const after = cw.calls.slice(afterReset);
    expect(attributeWrites(after)).toEqual([]);
    // And nothing was said to the customer either. The refusal answers the MODEL, not the
    // conversation, so a refusal that ends the turn must not arrive as the text that gets posted —
    // the runtime posts the LAST message of the result whatever its type.
    expect(
      after.filter((c) => c.method === "POST" && c.path.endsWith("/messages")),
    ).toEqual([]);
    // The positive control: without it this passes on a turn that stood down before its tool call,
    // which is the scenario of the tests above and not this one.
    expect(m.turnCalls()).toBeGreaterThan(0);
  }, 30000);

  // TWO REQUIREMENTS, NOT ONE, and each fails differently. An `AIMessage` carrying `tool_calls` with
  // no `ToolMessage` answering them is what most providers reject on the NEXT turn, so refusing by
  // routing away would trade a write on a cleared conversation for a thread nothing can resume. And
  // answering "refused" back INTO the model invites it to call the same tool again, to the recursion
  // limit, on a conversation the operator has already cleared — so the refusal ends the turn.
  test("the refused call is answered, and the turn does not go back to the model", async () => {
    const cw = fakeChatwoot();
    globalThis.fetch = cw.impl;
    const m = parkedModel("call_attr_449_seq");
    const turn = deliver("marca como qualificado, por favor", {
      makeModel: () => m.parked,
    });
    await m.reached;
    await deliver("/reset");
    m.release();
    await turn;

    const state = await buildThreadStateGraph(await getCheckpointer()).getState(
      {
        configurable: {
          thread_id: contactInboxThreadId(
            tenantId,
            instanceId,
            CONTACT_INBOX_ID,
          ),
        },
      },
    );
    const msgs = (state.values as { messages?: BaseMessage[] }).messages ?? [];
    // This turn's slice of a thread the whole suite writes to: everything after the last human
    // message is what this invoke appended.
    const tail = msgs.slice(
      msgs.map((mm) => mm.getType()).lastIndexOf("human") + 1,
    );
    const calls = tail
      .filter((mm) => mm.getType() === "ai")
      .flatMap((mm) => (mm as AIMessage).tool_calls ?? [])
      .map((c) => String(c.id));
    const answered = tail
      .filter((mm) => mm.getType() === "tool")
      .map((mm) => String((mm as ToolMessage).tool_call_id));
    expect(calls.length).toBeGreaterThan(0);
    expect([...answered].sort()).toEqual([...calls].sort());
    // ONE model call. On the code this closes it is two: the tool runs, its result routes back, and
    // the model answers over the conversation that was cleared.
    expect(m.turnCalls()).toBe(1);
  }, 30000);

  // THE LEDGER AND THE WATERMARK HAVE TO AGREE. A stale turn's delivery is settled as CONSUMED, so
  // nothing is coming for that message — and if the watermark still sits below it, the first flush
  // after debounce is enabled re-answers it (issue #8). The command's own advance does not cover it:
  // /reset writes the boundary in its FIRST step and advances the watermark in its LAST, so this
  // asserts the state while the command is still parked between the two, which is also what a
  // process dying in that stretch leaves behind.
  test("the message it withdrew is under the watermark before the command finishes", async () => {
    const inCommand = Promise.withResolvers<void>();
    const commandHeld = Promise.withResolvers<void>();
    // Armed only once the TURN is parked, because the turn reads the conversation too and would
    // otherwise spend the one park this hook has.
    let armed = false;
    let parked = false;
    const cw = fakeChatwoot(undefined, undefined, async () => {
      if (!armed || parked) return;
      parked = true;
      inCommand.resolve();
      await commandHeld.promise;
    });
    globalThis.fetch = cw.impl;

    const inModel = Promise.withResolvers<void>();
    const modelHeld = Promise.withResolvers<void>();
    const model = new SetAttributeThenReplyModel();
    const triggerId = 7000 + seq + 1;
    const turn = deliver("tem cor azul?", {
      makeModel: () =>
        ({
          invoke: model.invoke.bind(model),
          bindTools: (tools: unknown) => {
            const bound = model.bindTools(tools);
            return {
              invoke: async () => {
                inModel.resolve();
                await modelHeld.promise;
                return bound.invoke();
              },
            };
          },
        }) as unknown as BaseChatModel,
    });
    await Promise.race([
      inModel.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("the turn never reached the model call");
      }),
    ]);
    armed = true;
    const reset = deliver("/reset");
    await Promise.race([
      inCommand.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("the command never posted its acknowledgement");
      }),
    ]);
    // The boundary is written by now; the command's own watermark advance is not.
    modelHeld.resolve();
    await turn;

    const wm = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: CONV_ID },
      select: { lastHandledMessageId: true },
    });
    expect(wm.lastHandledMessageId ?? 0).toBeGreaterThanOrEqual(triggerId);

    commandHeld.resolve();
    await reset;
  }, 30000);

  // THE OTHER DIRECTION, and it is the one a boundary written at the wrong moment breaks. The
  // command is not instant: it refreshes the conversation live, retires six kinds of scheduled job
  // and makes a dozen Chatwoot calls. A customer message landing in that stretch arrived AFTER the
  // operator asked for a clean slate, so it is a message they want ANSWERED — and a mark stamped
  // when the cleanup finally writes would read it as older than the reset and stand its turn down,
  // settling it as consumed. That is a swallowed message on the way to fixing swallowed messages,
  // which is why the boundary is the command's own `receivedAt`.
  test("a message that arrives while the command is still running is answered", async () => {
    const inCommand = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let parked = false;
    const cw = fakeChatwoot(undefined, async () => {
      if (parked) return;
      parked = true;
      inCommand.resolve();
      await held.promise;
    });
    globalThis.fetch = cw.impl;

    const reset = deliver("/reset");
    await Promise.race([
      inCommand.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("the command never reached its live read");
      }),
    ]);

    // The turn has to still be RUNNING when the command writes its mark, or the fence reads a
    // conversation that has not been reset yet and the question never gets asked. Parked in the
    // model call, which is where a real turn spends its seconds.
    const inModel = Promise.withResolvers<void>();
    const modelHeld = Promise.withResolvers<void>();
    const model = new SetAttributeThenReplyModel();
    const turn = deliver("bom dia, tudo bem?", {
      makeModel: () =>
        ({
          invoke: model.invoke.bind(model),
          bindTools: (tools: unknown) => {
            const bound = model.bindTools(tools);
            return {
              invoke: async () => {
                inModel.resolve();
                await modelHeld.promise;
                return bound.invoke();
              },
            };
          },
        }) as unknown as BaseChatModel,
    });
    await Promise.race([
      inModel.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("the turn never reached the model call");
      }),
    ]);
    // The command finishes — and stamps — with the turn still in flight.
    held.resolve();
    await reset;
    modelHeld.resolve();
    await turn;

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

  // The boundary never moves BACKWARDS. Two `/reset` deliveries are dispatched detached and nothing
  // serializes them, so the older one can finish last — and assigned rather than merged, its write
  // would move the boundary back and let a turn from between the two commands run on a conversation
  // the newer one cleared.
  test("an older command finishing last does not move the boundary back", async () => {
    const inFirst = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let parked = false;
    const cw = fakeChatwoot(undefined, async () => {
      if (parked) return;
      parked = true;
      inFirst.resolve();
      await held.promise;
    });
    globalThis.fetch = cw.impl;

    const older = deliver("/reset");
    await Promise.race([
      inFirst.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("the first command never reached its live read");
      }),
    ]);
    // The NEWER command arrives and finishes while the older one is still parked.
    await deliver("/reset");
    const newest = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: CONV_ID },
      select: { resetAtMessageId: true },
    });
    held.resolve();
    await older;

    expect(
      (
        await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV_ID },
          select: { resetAtMessageId: true },
        })
      ).resetAtMessageId,
    ).toEqual(newest.resetAtMessageId);
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
