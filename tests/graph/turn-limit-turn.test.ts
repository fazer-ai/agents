import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// The per-conversation turn limit, end to end through the real turn: a conversation whose agent
// already answered `limit` times in the last hour is handed to a person instead of answered, with a
// private note and an `error` line, and the count starts again after that hand-over. The Chatwoot
// double records what the turn asked of it, so "not answered" is read where the customer would see
// it: no `sendMessage`.

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
let limitedAgentId = 0n;
let messageId = 9000;

const LIMIT = 3;
const LIMITED_INBOX = 7;
const UNLIMITED_INBOX = 8;
const REPLY = "Claro, já verifico.";

class StubModel {
  constructor(private readonly text: string) {}
  async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
    return new AIMessage(this.text);
  }
  bindTools(_tools: unknown) {
    return { invoke: (m: BaseMessage[]) => this.invoke(m) };
  }
}

interface Calls {
  sent: string[];
  notes: string[];
  status: string[];
}

// Every method the turn may call answers like Chatwoot would, and the three that matter here are
// recorded. A create returns an id, as the real one does, so the turn's own send ledger fills.
function chatwootDouble(
  calls: Calls,
  onToggle?: () => Promise<void>,
): () => Promise<ChatwootClient> {
  let nextId = 1;
  const client = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        return async (...args: unknown[]) => {
          if (prop === "sendMessage") calls.sent.push(String(args[1]));
          if (prop === "sendPrivateNote") calls.notes.push(String(args[1]));
          if (prop === "toggleStatus") {
            calls.status.push(String(args[1]));
            await onToggle?.();
          }
          // NOTE: Reads (labels, attributes) answer an empty list; creates answer an id.
          return String(prop).startsWith("send") ? { id: nextId++ } : [];
        };
      },
    },
  ) as unknown as ChatwootClient;
  return async () => client;
}

const incoming = (
  conversationId: number,
  inboxId: number,
  contactInboxId: number | null = null,
): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId,
  inboxId,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId,
  message: {
    id: ++messageId,
    content: "oi, tudo bem?",
    messageType: "incoming",
    private: false,
  },
});

async function seedConversation(
  convId: number,
  contactInboxId: number | null = null,
): Promise<bigint> {
  const row = await suDb.conversation.create({
    data: {
      tenantId,
      contactInboxId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

async function seedDeliveries(convDbId: bigint, at: Date[]): Promise<void> {
  for (const deliveredAt of at) {
    await suDb.agentTurnDelivery.create({
      data: { tenantId, conversationId: convDbId, deliveredAt },
    });
  }
}

const deliveries = (convDbId: bigint) =>
  suDb.agentTurnDelivery.count({ where: { conversationId: convDbId } });

async function turn(
  convId: number,
  calls: Calls,
  opts: {
    inbox?: number;
    reply?: string;
    base?: PrismaClient;
    contactInboxId?: number;
    onToggle?: () => Promise<void>;
  } = {},
) {
  return runAgentTurn({
    tenantId,
    instanceId,
    agentBotId: 9,
    event: incoming(
      convId,
      opts.inbox ?? LIMITED_INBOX,
      opts.contactInboxId ?? null,
    ),
    base: opts.base ?? appDb,
    deps: {
      makeModel: () =>
        new StubModel(opts.reply ?? REPLY) as unknown as BaseChatModel,
      makeClient: chatwootDouble(calls, opts.onToggle),
      checkpointer: new MemorySaver(),
    },
  });
}

const newCalls = (): Calls => ({ sent: [], notes: [], status: [] });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe.skipIf(!dbUp)("the per-conversation turn limit", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TL", slug: `tl-${process.pid}` },
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
    const agent = async (name: string, limits: { maxTurnsPerHour: number }) =>
      suDb.agent.create({
        data: {
          tenantId,
          name,
          systemPrompt: "Você é uma secretária prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-5.4-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: { split: { enabled: false }, limits },
        },
      });
    const limited = await agent("Limitado", { maxTurnsPerHour: LIMIT });
    const unlimited = await agent("Sem limite", { maxTurnsPerHour: 0 });
    limitedAgentId = limited.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: limited.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `tl-route-${process.pid}`,
        name: "Limitado",
      },
    });
    for (const [chatwootInboxId, a] of [
      [LIMITED_INBOX, limited],
      [UNLIMITED_INBOX, unlimited],
    ] as const) {
      await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId,
          name: `Inbox ${chatwootInboxId}`,
          agentId: a.id,
        },
      });
    }
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "agent_turn_deliveries",
        "message_reply_claims",
        "agent_threads",
        "conversations",
        "contacts",
        "inboxes",
        "chatwoot_agent_bots",
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

  test("the limit-th turn is answered, the next one goes to a person with a note and an error line", async () => {
    const convId = 8201;
    const convDbId = await seedConversation(convId);

    for (let i = 1; i <= LIMIT; i++) {
      const calls = newCalls();
      expect(await turn(convId, calls)).toBe("posted");
      expect(calls.sent).toEqual([REPLY]);
      expect(calls.status).toEqual([]);
      expect(await deliveries(convDbId)).toBe(i);
    }

    const calls = newCalls();
    expect(await turn(convId, calls)).toBe("blocked");
    // NOTE: Nothing reached the customer: the turn over the limit is never answered.
    expect(calls.sent).toEqual([]);
    expect(calls.status).toEqual(["open"]);
    expect(calls.notes).toHaveLength(1);
    const note = calls.notes[0] as string;
    expect(note).toContain(`respondeu ${LIMIT} vezes`);
    expect(note).toContain(`limite: ${LIMIT}`);
    expect(note).toContain("é seguro devolvê-la ao agente");
    expect(note).toContain(
      `/agents/${limitedAgentId}/behavior?focus=limits&switchTenant=${tenantId}`,
    );
    expect(await deliveries(convDbId)).toBe(LIMIT);
    const row = await suDb.conversation.findUnique({
      where: { id: convDbId },
      select: { turnLimitTrippedAt: true },
    });
    expect(row?.turnLimitTrippedAt).not.toBeNull();

    const lines = await flowLogRows(suDb, {
      where: { tenantId, stage: "turn_limit", conversationId: convDbId },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    expect(lines[0]?.detail).toMatchObject({
      outcome: "handed_off",
      limit: LIMIT,
      count: LIMIT,
    });
    expect(lines[0]?.errorMessage).toContain(`limit ${LIMIT}`);
  });

  // Two messages back to back: the second turn waits on the first's claim, and when that claim is
  // released the first turn's delivery must already be counted. The insert is slowed so the window
  // between the release and the write, if there is one, is wide enough to be seen.
  test("a turn waiting on the previous one sees its delivery", async () => {
    const convId = 8207;
    // A contact-inbox thread, the one whose turns take the durable claim and wait on it.
    const convDbId = await seedConversation(convId, 7207);
    await seedDeliveries(convDbId, [minutesAgo(10), minutesAgo(5)]);
    const slow = appDb.$extends({
      query: {
        agentTurnDelivery: {
          async create({ args, query }) {
            await Bun.sleep(400);
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const first = newCalls();
    const second = newCalls();
    const outcomes = await Promise.all([
      turn(convId, first, { base: slow, contactInboxId: 7207 }),
      Bun.sleep(50).then(() =>
        turn(convId, second, { base: slow, contactInboxId: 7207 }),
      ),
    ]);
    expect(outcomes).toEqual(["posted", "blocked"]);
    expect(second.sent).toEqual([]);
  });

  // A /reset that lands while the conversation is being handed over gives it back to the agent, so
  // the note announcing the hand-over would be false and is not posted.
  test("a /reset during the hand-over leaves no note", async () => {
    const convId = 8208;
    const convDbId = await seedConversation(convId);
    await seedDeliveries(convDbId, [
      minutesAgo(30),
      minutesAgo(20),
      minutesAgo(10),
    ]);

    const calls = newCalls();
    const outcome = await turn(convId, calls, {
      onToggle: async () => {
        await suDb.conversation.update({
          where: { id: convDbId },
          data: { resetAtMessageId: messageId + 1 },
        });
      },
    });
    expect(outcome).toBe("stale");
    expect(calls.sent).toEqual([]);
    expect(calls.status).toEqual(["open"]);
    expect(calls.notes).toEqual([]);
  });

  test("a delivery older than an hour has left the window", async () => {
    const convId = 8202;
    const convDbId = await seedConversation(convId);
    await seedDeliveries(convDbId, [
      minutesAgo(61),
      minutesAgo(30),
      minutesAgo(5),
    ]);

    const calls = newCalls();
    expect(await turn(convId, calls)).toBe("posted");
    expect(calls.sent).toEqual([REPLY]);
  });

  test("deliveries inside the hour reach the limit", async () => {
    const convId = 8203;
    const convDbId = await seedConversation(convId);
    await seedDeliveries(convDbId, [
      minutesAgo(59),
      minutesAgo(30),
      minutesAgo(5),
    ]);

    const calls = newCalls();
    expect(await turn(convId, calls)).toBe("blocked");
    expect(calls.sent).toEqual([]);
  });

  test("a conversation handed back after a trip counts from zero", async () => {
    const convId = 8204;
    const convDbId = await seedConversation(convId);
    await seedDeliveries(convDbId, [
      minutesAgo(20),
      minutesAgo(15),
      minutesAgo(10),
    ]);
    await suDb.conversation.update({
      where: { id: convDbId },
      data: { turnLimitTrippedAt: minutesAgo(8) },
    });

    const calls = newCalls();
    expect(await turn(convId, calls)).toBe("posted");
    expect(calls.sent).toEqual([REPLY]);
  });

  test("a stored 0 is no limit", async () => {
    const convId = 8205;
    const convDbId = await seedConversation(convId);
    await seedDeliveries(
      convDbId,
      Array.from({ length: 10 }, (_, i) => minutesAgo(i + 1)),
    );

    const calls = newCalls();
    expect(await turn(convId, calls, { inbox: UNLIMITED_INBOX })).toBe(
      "posted",
    );
    expect(calls.notes).toEqual([]);
    expect(await deliveries(convDbId)).toBe(11);
  });

  test("a turn that put nothing in front of the customer is not counted", async () => {
    const convId = 8206;
    const convDbId = await seedConversation(convId);

    const calls = newCalls();
    await turn(convId, calls, { reply: "" });
    expect(calls.sent).toEqual([]);
    expect(await deliveries(convDbId)).toBe(0);
  });
});
