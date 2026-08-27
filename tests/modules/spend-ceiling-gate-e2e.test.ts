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
import { runAgentNudge } from "@/graph/nudge";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import { clearSpendCeilingFlights } from "@/modules/spend-ceiling/notice";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// The spend ceiling, wired end to end through processChatwootDelivery (issue #146). The rule is
// pinned without a database in ./spend-ceiling-decide.test.ts; what these pin is that it reaches the
// process boundary: over the ceiling the MODEL IS NEVER INVOKED, the configured sentence leaves as
// the persona, the conversation opens for humans, and the operator gets a note that names the
// numbers. Under it, the turn runs exactly as before.

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

const BOT_TOKEN = "SC-BOT-TOKEN";
const INBOX = 781;
const OVER_COPY = "Estamos com o atendimento automático pausado agora.";

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let instance2Id = 0n;
let inbox2DbId = 0n;
let agentId = 0n;

interface Sent {
  conversationId: number;
  content: string;
  private: boolean;
  token: string;
}

function stubChatwoot() {
  const sent: Sent[] = [];
  const statusToggles: Array<[number, string]> = [];
  let token = "";
  const client = {
    sendMessage: async (c: number, content: string) => {
      sent.push({ conversationId: c, content, private: false, token });
      return {};
    },
    sendPrivateNote: async (c: number, content: string) => {
      sent.push({ conversationId: c, content, private: true, token });
      return {};
    },
    toggleStatus: async (c: number, status: string) => {
      statusToggles.push([c, status]);
      return {};
    },
    assignTeam: async () => ({}),
    toggleTyping: async () => ({}),
    getMessages: async () => ({ payload: [] }),
  } as unknown as ChatwootClient;
  return {
    sent,
    statusToggles,
    makeClient: async (cfg: { botToken: string }) => {
      token = cfg.botToken;
      return client;
    },
    publicOn: (c: number) =>
      sent.filter((s) => s.conversationId === c && !s.private),
    notesOn: (c: number) =>
      sent.filter((s) => s.conversationId === c && s.private),
  };
}

async function setCeiling(
  patch: Record<string, string | number | boolean | null>,
) {
  await suDb.tenant.update({
    where: { id: tenantId },
    data: { settings: { spendCeiling: patch } },
  });
}

async function spend(source: string, prompt: number, completion = 0) {
  await suDb.llmUsage.create({
    data: {
      tenantId,
      model: "gpt-4o-mini",
      source,
      promptTokens: prompt,
      completionTokens: completion,
    },
  });
}

async function seedConversation(convId: number, onSecond = false) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: onSecond ? instance2Id : instanceId,
      inboxId: onSecond ? inbox2DbId : inboxDbId,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${onSecond ? instance2Id : instanceId}:${convId}`,
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
    },
  });
}

let seq = 0;
async function deliverCustomerMessage(params: {
  convId: number;
  makeClient: (cfg: { botToken: string }) => Promise<ChatwootClient>;
  // Absent means the strongest assertion this file can make: a turn that runs at all fails the test.
  allowModel?: boolean;
  // The Chatwoot message id, when the caller needs TWO deliveries of ONE message: that is the shape
  // Chatwoot produces on its own, dispatching an incoming message to the conversation's assigned
  // agent bot and to the inbox's. The delivery row stays unique either way, because its id is the
  // sequence and not the message.
  messageId?: number;
  // Deliver on the tenant's SECOND Chatwoot account instead of the first. Only the multi-instance
  // tests pass it; every other caller keeps the single-account shape it always had.
  onSecond?: boolean;
  // The message body. Blank (with no attachment) is a message that renders to nothing for the agent,
  // which the turn skips before any billed call.
  content?: string;
  // A Prisma client that misbehaves in a named way, for the tests about what a gate does when a read
  // it depends on cannot answer.
  base?: PrismaClient;
}): Promise<void> {
  seq += 1;
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: params.messageId ?? 8000 + seq,
    content: params.content ?? "oi, preciso de ajuda",
    message_type: "incoming",
    private: false,
    conversation: {
      id: params.convId,
      inbox_id: INBOX,
      status: "pending",
      contact_inbox: { id: 92_000 + params.convId },
      meta: {
        assignee_type: null,
        assignee: null,
        sender: {
          id: 5000 + params.convId,
          name: "Cliente",
          phone_number: "+5511955554444",
        },
      },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
  if (!n) throw new Error("unreachable: the fixture is a valid event");
  const inst = params.onSecond ? instance2Id : instanceId;
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: inst,
      deliveryId: `sc-${process.pid}-${params.convId}-${seq}`,
      event: "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId: inst,
    deliveryRowId: delivery.id,
    agentBotId: params.onSecond ? 41 : 31,
    normalized: n,
    base: params.base ?? appDb,
    deps: {
      makeClient: params.makeClient as never,
      makeModel: params.allowModel
        ? () => new FakeListChatModel({ responses: ["Claro, posso ajudar."] })
        : () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    },
  });
}

// The gate's line. `emitFlowEvent` returns before its row exists, so the write is SETTLED rather
// than polled for (#375): a poll would answer the "is it there" cases and spend its whole timeout
// on the one case that asserts a line is ABSENT, which is the assertion below that matters most.
async function ceilingRows(convId: number, onSecond = false) {
  await settleFlowEvents();
  const threadId = `${tenantId}:${onSecond ? instance2Id : instanceId}:${convId}`;
  return flowLogRows(suDb, {
    where: { tenantId, threadId, stage: "spend_ceiling" },
    select: { level: true, status: true, detail: true },
    orderBy: { id: "asc" },
  });
}

describe.skipIf(!dbUp)("the spend ceiling (webhook e2e)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SCG", slug: `scg-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 51,
      baseUrl: "https://203.0.113.31:9",
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
        name: "Com teto",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: { debounce: { enabled: false }, split: { enabled: false } },
      },
      select: { id: true },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: 31,
        accessToken: encryptJson(BOT_TOKEN),
        webhookSecret: encryptJson("SECRET"),
        webhookRouteTokenHash: `scg-${process.pid}-31`,
        name: "bot",
      },
    });
    const ib = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX,
        name: "Com teto",
        agentId,
      },
      select: { id: true },
    });
    inboxDbId = ib.id;

    // A SECOND CHATWOOT ACCOUNT for the same tenant, which is an ordinary shape (one operator, two
    // Chatwoot deployments) and the one that makes account-local ids collide: conversation and
    // message numbers restart per account, so the SAME numbers exist on both sides.
    const inst2 = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 61,
      baseUrl: "https://203.0.113.31:19",
      adminToken: encryptJson("ADMIN"),
    });
    instance2Id = inst2.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instance2Id,
        agentId,
        chatwootAgentBotId: 41,
        accessToken: encryptJson(BOT_TOKEN),
        webhookSecret: encryptJson("SECRET"),
        webhookRouteTokenHash: `scg-${process.pid}-41`,
        name: "bot2",
      },
    });
    const ib2 = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instance2Id,
        // The same inbox NUMBER on purpose: it is account-local too, and the unique key is
        // (tenant, instance, inbox), so this is what a real second account looks like.
        chatwootInboxId: INBOX,
        name: "Com teto 2",
        agentId,
      },
      select: { id: true },
    });
    inbox2DbId = ib2.id;
  });

  beforeEach(async () => {
    clearContactAuthState();
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    if (!dbUp || tenantId === 0n) return;
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
    await clearFlowLog(suDb, { tenantId });
    await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  // THE DEFECT: a tenant past its month's tokens still ran the turn, and the operator learned about
  // it on the invoice. `makeModel` throws here, so a turn that runs at all fails this test.
  test("over the ceiling the model is never invoked", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 1000,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 1200);
    await seedConversation(9401);
    const s = stubChatwoot();
    await deliverCustomerMessage({ convId: 9401, makeClient: s.makeClient });

    // The customer is answered, by the operator's sentence rather than by silence...
    expect(s.publicOn(9401).map((m) => m.content)).toEqual([OVER_COPY]);
    // ...as the PERSONA, not as a token-less client a real Chatwoot would refuse.
    expect(s.publicOn(9401)[0]?.token).toBe(BOT_TOKEN);
    // ...the conversation goes to the human queue...
    expect(s.statusToggles).toContainEqual([9401, "open"]);
    // ...and the operator is told why, with the numbers.
    const note = s.notesOn(9401)[0]?.content ?? "";
    expect(note).toContain("1.200");
    expect(note).toContain("1.000");
  });

  // ONE LINE PER REFUSED OCCASION, and for a proactive nudge the occasion is the JOB, not the
  // attempt. `over-ceiling` is a repairable refusal, so its caller reschedules it every fifteen
  // minutes for two hours (`nudge-retry.ts`): announcing per attempt paged the alert channels eight
  // times for one follow-up that could not go out, multiplied by every pending job the tenant had.
  test("a nudge refused by the ceiling is announced once, however often it is retried", async () => {
    await setCeiling({ enabled: true, monthlyInboxTokens: 1000 });
    await spend("inbox", 1200);
    await seedConversation(9410);
    await seedConversation(9411);
    const s = stubChatwoot();
    const nudge = (convId: number) =>
      runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:${convId}`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        base: appDb,
        deps: {
          makeClient: s.makeClient as never,
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          checkpointer: new MemorySaver(),
          persistUsage: async () => {},
        },
      });

    // The ladder, as the scheduler walks it: same job, same wall, three attempts.
    expect(await nudge(9410)).toBe("over-ceiling");
    expect(await nudge(9410)).toBe("over-ceiling");
    expect(await nudge(9410)).toBe("over-ceiling");
    expect(await ceilingRows(9410)).toHaveLength(1);

    // A DIFFERENT conversation is a different occasion, so the window that quiets the retries above
    // must not quiet it. Without this, a key that dropped the conversation would pass the assertion
    // before it while silencing the whole tenant.
    expect(await nudge(9411)).toBe("over-ceiling");
    expect(await ceilingRows(9411)).toHaveLength(1);

    // ...and so is a DIFFERENT JOB on the SAME conversation. An appointment reminder scheduled an
    // hour after an inactivity follow-up is an independent occasion that happens to share a
    // conversation, and a key that carried only the conversation would swallow it.
    expect(
      await runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:9410`,
        nudge: {
          source: "appointment_reminder",
          kind: "reminder",
          refs: { event_id: "evt-1", calendar_id: "cal-1" },
        },
        base: appDb,
        deps: {
          makeClient: s.makeClient as never,
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          checkpointer: new MemorySaver(),
          persistUsage: async () => {},
        },
      }),
    ).toBe("over-ceiling");
    expect(await ceilingRows(9410)).toHaveLength(2);
  });

  // THE COMMAND, LANDING BETWEEN THE GATE AND THE LINE. `stillWanted` is asked before any model
  // spend, but the ceiling verdict underneath it is two database reads deep, and a `/reset` retiring
  // the job inside that window leaves the nudge announcing a refusal about work that will not
  // happen: `over` is `error` severity, so the line pages the alert channels, and the announcement
  // claims the occasion window as it decides — swallowing the one a later, real refusal needs.
  //
  // Driven through the injected ask, which is exactly the seam the scheduler uses: yes to the first
  // question (there was work to do), no to the one after the verdict (the command landed in
  // between). Counting the asks is what makes this measure the SECOND one rather than the first.
  test("a nudge retired while the ceiling was being read announces nothing", async () => {
    await setCeiling({ enabled: true, monthlyInboxTokens: 1000 });
    await spend("inbox", 1200);
    await seedConversation(9415);
    const s = stubChatwoot();
    let asks = 0;
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9415`,
      nudge: { source: "followup", kind: "inactivity", step: 1 },
      base: appDb,
      stillWanted: async () => {
        asks += 1;
        return asks === 1;
      },
      deps: {
        makeClient: s.makeClient as never,
        makeModel: () => {
          throw new Error("the model must not be invoked over the ceiling");
        },
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    });

    // Withdrawn, not refused: the job is gone, so this is not an `over-ceiling` the caller should
    // reschedule against a wall.
    expect(outcome).toBe("stale");
    expect(asks).toBe(2);
    expect(await ceilingRows(9415)).toEqual([]);
    expect(s.publicOn(9415)).toEqual([]);
  });

  // A BUDGET CAN ONLY BE WHAT SILENCED AN AGENT THAT COULD OTHERWISE HAVE SPOKEN. `agent.enabled`
  // is the operator's switch and not the whole question: `loadAgentConfig` also answers null when
  // the model `credentialRef` no longer resolves, and the turn then returns `agent-unavailable`
  // before a model is built. The same message under a ceiling with room is already unanswered, so a
  // refusal here would tell the customer and the operator that a budget did it, and send them to
  // raise a number that changes nothing.
  test("an agent that cannot run is not silenced by the budget", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 500);
    await seedConversation(9417);
    const saved = await suDb.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { modelConfig: true },
    });
    const s = stubChatwoot();
    try {
      // A credential that does not resolve: the ref is well-formed and points at nothing, which is
      // what a deleted vault entry leaves behind.
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          modelConfig: {
            ...(saved.modelConfig as object),
            credentialRef: "vault:999999999",
          },
        },
      });
      await deliverCustomerMessage({ convId: 9417, makeClient: s.makeClient });
      expect(s.publicOn(9417)).toEqual([]);
      expect(s.statusToggles.filter(([c]) => c === 9417)).toEqual([]);
      expect(s.notesOn(9417)).toEqual([]);
      expect(await ceilingRows(9417)).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { modelConfig: saved.modelConfig as object },
      });
    }
    // The control, on the SAME blown ceiling with the credential restored: this one IS refused, so
    // the silence above measures the agent and not a gate that stopped running.
    await seedConversation(9418);
    const ok = stubChatwoot();
    await deliverCustomerMessage({ convId: 9418, makeClient: ok.makeClient });
    expect(ok.publicOn(9418).map((m) => m.content)).toEqual([OVER_COPY]);
    expect(await ceilingRows(9418)).toHaveLength(1);
  });

  // A MESSAGE THE AGENT WOULD NEVER HAVE READ IS NOT A MESSAGE THE BUDGET SILENCED. Blank content
  // with no attachment renders to nothing, and `runAgentTurn` returns `skipped` before any billed
  // call — so under a ceiling with room this customer is already met with silence. Refusing it would
  // send the operator's sentence, queue the conversation for a human and write an `error` line about
  // a message no model was ever going to see.
  test("a message that renders to nothing is not refused", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 500);
    await seedConversation(9419);
    const s = stubChatwoot();
    await deliverCustomerMessage({
      convId: 9419,
      makeClient: s.makeClient,
      content: "   ",
    });
    expect(s.publicOn(9419)).toEqual([]);
    expect(s.statusToggles.filter(([c]) => c === 9419)).toEqual([]);
    expect(s.notesOn(9419)).toEqual([]);
    expect(await ceilingRows(9419)).toEqual([]);
  });

  // A PROBE THAT COULD NOT ANSWER IS NOT AN AGENT THAT CANNOT RUN. The ceiling fails OPEN when the
  // CEILING is unreadable, so a customer is never silenced by our own database hiccup — but here the
  // verdict is read and says `over`, and the runnable probe is only the escape hatch from it. An
  // unreadable escape hatch must not open, or a pool timeout would let the turn spend past a budget
  // the operator capped, which is the one outcome this gate exists to prevent.
  //
  // The probe is told apart from every other agent read by its SELECT: it is the only one that asks
  // for `modelConfig`, and the context load above it asks for `mode`. Without that discrimination
  // the fixture would break the load instead, and the gate under test would never run.
  test("a runnable probe that cannot be read leaves the refusal standing", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 500);
    await seedConversation(9420);
    let probes = 0;
    const blind = appDb.$extends({
      query: {
        agent: {
          async findUnique({ args, query }) {
            if ((args.select as { modelConfig?: boolean })?.modelConfig) {
              probes += 1;
              throw new Error("connection reset");
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const s = stubChatwoot();
    await deliverCustomerMessage({
      convId: 9420,
      makeClient: s.makeClient,
      base: blind,
    });
    // The read the test is about actually ran; without this the assertion below would pass on a path
    // that never reached it.
    expect(probes).toBeGreaterThan(0);
    // ...and the customer is refused anyway, which is the ceiling standing.
    expect(s.publicOn(9420).map((m) => m.content)).toEqual([OVER_COPY]);
    expect(await ceilingRows(9420)).toHaveLength(1);
  });

  // TWO ACCOUNTS, TWO MESSAGES THAT HAPPEN TO SHARE A NUMBER. Chatwoot ids are account-local, so a
  // tenant running two Chatwoot deployments has message 8801 on each, and they are two different
  // customers. A refusal key without the instance handed the second one the first's window: one
  // customer refused, with no row on the Logs page and no alert, which is the exact invariant the
  // key exists to keep.
  test("two accounts' messages that share a number are two refusals", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 500);
    await seedConversation(9416);
    await seedConversation(9416, true);
    const s = stubChatwoot();
    await deliverCustomerMessage({
      convId: 9416,
      makeClient: s.makeClient,
      messageId: 8801,
    });
    await deliverCustomerMessage({
      convId: 9416,
      makeClient: s.makeClient,
      messageId: 8801,
      onSecond: true,
    });
    expect(await ceilingRows(9416)).toHaveLength(1);
    expect(await ceilingRows(9416, true)).toHaveLength(1);
  });

  // ONE REFUSED MESSAGE, ONE LINE, and the count of refusals is the number an operator reads off the
  // Logs page. Chatwoot fans an incoming message to the conversation's assigned agent bot AND to the
  // inbox's, so the two deliveries arrive under two ids at the same moment and neither knows about
  // the other.
  test("one message fanned out to two routes is refused once on the record", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 500);
    await seedConversation(9412);
    const warmUp = stubChatwoot();
    // One delivery first, and it is not decoration: the mirror UPSERTS the contact, and two
    // concurrent inserts of a contact that does not exist yet race to a unique violation that has
    // nothing to do with this gate. Measured as a 2-in-5 flake before this line existed. With the
    // row already there both deliveries take the update path, and what is left racing is the thing
    // under test.
    await deliverCustomerMessage({
      convId: 9412,
      makeClient: warmUp.makeClient,
      messageId: 8799,
    });
    // ...so the counts below belong to the fan-out and not to the warm-up.
    await clearFlowLog(suDb, { tenantId });
    clearContactAuthState();
    clearSpendCeilingFlights();

    const s = stubChatwoot();
    await Promise.all([
      deliverCustomerMessage({
        convId: 9412,
        makeClient: s.makeClient,
        messageId: 8800,
      }),
      deliverCustomerMessage({
        convId: 9412,
        makeClient: s.makeClient,
        messageId: 8800,
      }),
    ]);
    expect(await ceilingRows(9412)).toHaveLength(1);
    // ...and the customer hears it once, which is the sequence's own single flight rather than this
    // key. Both are asserted because they are two different fences over one fan-out.
    expect(s.publicOn(9412).map((m) => m.content)).toEqual([OVER_COPY]);
  });

  // A MESSAGE THAT WAS ALREADY ANSWERED IS NOT A MESSAGE TO REFUSE. The fan-out sends one message
  // down two routes, and the two read the ledger at different instants: the first can be under the
  // ceiling, answer, and commit the usage that puts the tenant over before the second gets here.
  // Told as the second route sees it, with the watermark already advanced past the message — which
  // is what `runAgentTurn` leaves behind when it posts.
  test("a message the other route already answered is neither refused nor reported", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 500);
    await seedConversation(9413);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 9413 },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id: conv.id },
      data: { lastHandledMessageId: 8900 },
    });
    const s = stubChatwoot();
    await deliverCustomerMessage({
      convId: 9413,
      makeClient: s.makeClient,
      messageId: 8900,
    });
    // Nothing said to the customer, nothing reopened...
    expect(s.publicOn(9413)).toEqual([]);
    expect(s.statusToggles.filter(([c]) => c === 9413)).toEqual([]);
    expect(s.notesOn(9413)).toEqual([]);
    // ...and no `error` line claiming a turn was skipped for budget, because none was.
    expect(await ceilingRows(9413)).toHaveLength(0);
  });

  // The control, and it is the half that makes the test above about the WATERMARK rather than about
  // the conversation: the very next message is past it, and that one IS refused.
  test("the message after the watermark is still refused", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 500);
    await seedConversation(9414);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 9414 },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id: conv.id },
      data: { lastHandledMessageId: 8900 },
    });
    const s = stubChatwoot();
    await deliverCustomerMessage({
      convId: 9414,
      makeClient: s.makeClient,
      messageId: 8901,
    });
    expect(s.publicOn(9414).map((m) => m.content)).toEqual([OVER_COPY]);
    expect(await ceilingRows(9414)).toHaveLength(1);
  });

  test("the refusal is on the record, at error level", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 500);
    await seedConversation(9402);
    const s = stubChatwoot();
    await deliverCustomerMessage({ convId: 9402, makeClient: s.makeClient });
    const rows = await ceilingRows(9402);
    expect(rows[0]?.level).toBe("error");
    expect(rows[0]?.status).toBe("skipped");
    expect((rows[0]?.detail as { usedTokens?: number })?.usedTokens).toBe(500);
  });

  // The other side of the same gate: nothing changes for a tenant under its ceiling, and the turn
  // runs. Without this the test above would pass just as well on a build that refuses everything.
  test("under the ceiling the turn runs as before", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 1_000_000,
      overCeilingMessage: OVER_COPY,
    });
    await spend("inbox", 1200);
    await seedConversation(9403);
    const s = stubChatwoot();
    await deliverCustomerMessage({
      convId: 9403,
      makeClient: s.makeClient,
      allowModel: true,
    });
    const publics = s.publicOn(9403).map((m) => m.content);
    expect(publics).not.toContain(OVER_COPY);
    expect(publics.length).toBeGreaterThan(0);
  });

  // The playground's own spending must not be able to silence customers, which is the entire reason
  // the ceiling is two numbers instead of one.
  test("a playground overrun does not close the inbox", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 1_000_000,
      monthlyPlaygroundTokens: 10,
      overCeilingMessage: OVER_COPY,
    });
    await spend("playground", 5000);
    await seedConversation(9404);
    const s = stubChatwoot();
    await deliverCustomerMessage({
      convId: 9404,
      makeClient: s.makeClient,
      allowModel: true,
    });
    expect(s.publicOn(9404).map((m) => m.content)).not.toContain(OVER_COPY);
  });

  // The verdict is evaluated on every message; the COPY is not. Ten people writing in after the
  // month is spent must not be answered with the same sentence ten times.
  test("a second message inside the window is refused without repeating the copy", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      overCeilingMessage: OVER_COPY,
      noticeCooldownSeconds: 300,
    });
    await spend("inbox", 500);
    await seedConversation(9405);
    const s = stubChatwoot();
    await deliverCustomerMessage({ convId: 9405, makeClient: s.makeClient });
    await deliverCustomerMessage({ convId: 9405, makeClient: s.makeClient });
    // Said once...
    expect(s.publicOn(9405).map((m) => m.content)).toEqual([OVER_COPY]);
    // ...and the second turn was still refused: the model was never built, or the delivery above
    // would have thrown.
    expect(s.statusToggles.filter(([c]) => c === 9405).length).toBeGreaterThan(
      0,
    );
    // TWO lines, though, because these are two DIFFERENT customers left unanswered and the count of
    // refusals is what an operator reads off the Logs page. The copy's window quiets the SENTENCE,
    // never the record — and the de-duplication that keeps one fanned-out message to one line has to
    // carry the message id, or it would swallow this second one too.
    expect(await ceilingRows(9405)).toHaveLength(2);
  });

  // A ceiling switched off is the state every existing install is in, and it must cost nothing and
  // change nothing.
  test("a tenant with the block switched off is untouched", async () => {
    await setCeiling({ enabled: false, monthlyInboxTokens: 1 });
    await spend("inbox", 999_999);
    await seedConversation(9406);
    const s = stubChatwoot();
    await deliverCustomerMessage({
      convId: 9406,
      makeClient: s.makeClient,
      allowModel: true,
    });
    expect(s.publicOn(9406).map((m) => m.content)).not.toContain(OVER_COPY);
    expect(s.notesOn(9406)).toEqual([]);
  });
});
