import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { buildAgentGraph } from "@/graph/graph";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import {
  type IngestRole,
  ingestedMessages,
  ingestMessageIntoThread,
} from "@/graph/ingest";
import { INGEST_ID_WINDOW } from "@/graph/ingest-dedup";
import {
  CONVERSATION_DIVIDER,
  HUMAN_AGENT_NOTE,
  isConversationDivider,
  isHumanAgentTurn,
  stampedConversationId,
} from "@/graph/markers";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { selectClosedPrefix } from "@/modules/memory/cut";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

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

// Records the history the graph actually hands the model, which is the only way to assert what the
// agent READS as opposed to what the thread stores.
class CapturingModel extends BaseChatModel {
  seen: BaseMessage[][] = [];
  constructor() {
    super({});
  }
  _llmType() {
    return "fake-capture";
  }
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    return { generations: [{ text: "ok", message: new AIMessage("ok") }] };
  }
}

// The pure half: WHO said it times WHETHER the attendance boundary asked for a divider. No database
// here on purpose: this is the decision, and a wrong answer for a human agent's reply is a permanent
// memory with the operator's words in it.
describe("ingestedMessages", () => {
  const CONV = 77;

  test("a customer message, no boundary: one stamped human turn, verbatim", () => {
    const [msg, ...rest] = ingestedMessages(
      "customer",
      "quanto custa?",
      CONV,
      false,
    );
    expect(rest.length).toBe(0);
    expect(String(msg?.content)).toBe("quanto custa?");
    expect(msg && stampedConversationId(msg)).toBe(CONV);
    expect(msg && isConversationDivider(msg)).toBe(false);
    expect(msg && isHumanAgentTurn(msg)).toBe(false);
  });

  test("a customer message opening an attendance: the divider folds into their own turn", () => {
    const msgs = ingestedMessages("customer", "voltei", CONV, true);
    expect(msgs.length).toBe(1);
    expect(msgs[0] && isConversationDivider(msgs[0])).toBe(true);
    expect(String(msgs[0]?.content)).toContain("voltei");
  });

  test("a human agent's reply is marked as the attendant's and carries the note", () => {
    const [msg, ...rest] = ingestedMessages(
      "human_agent",
      "fecho por R$ 1.200",
      CONV,
      false,
    );
    expect(rest.length).toBe(0);
    expect(msg && isHumanAgentTurn(msg)).toBe(true);
    expect(msg && isConversationDivider(msg)).toBe(false);
    expect(msg && stampedConversationId(msg)).toBe(CONV);
    expect(String(msg?.content)).toContain(HUMAN_AGENT_NOTE);
    expect(String(msg?.content)).toContain("fecho por R$ 1.200");
  });

  // The split exists because a message carries ONE marker. Folding the attendant's words into the
  // divider (the shape the customer path uses) would store them in a message that reads as the
  // CONTACT's.
  test("a human agent opening an attendance: the divider is its OWN message and holds no words", () => {
    const msgs = ingestedMessages(
      "human_agent",
      "oi, sou a Ana do financeiro",
      CONV,
      true,
    );
    expect(msgs.length).toBe(2);
    const [divider, reply] = msgs;
    expect(divider && isConversationDivider(divider)).toBe(true);
    expect(String(divider?.content)).toBe(CONVERSATION_DIVIDER);
    expect(String(divider?.content)).not.toContain("sou a Ana");
    expect(reply && isHumanAgentTurn(reply)).toBe(true);
    expect(String(reply?.content)).toContain("sou a Ana do financeiro");
  });

  // The stamp is what the compaction cut reads (src/modules/memory/cut.ts). A message written
  // without one is invisible to the boundary, and the attendance it belongs to never closes.
  // The append and the row that records it are not one atomic write, and ingestion is a retried job,
  // so a failure between them comes back. Ids derived from the Chatwoot message make that retry a
  // no-op rewrite: the reducer replaces a same-id message in place.
  test("the same message ingested twice is one message, not two", () => {
    const first = ingestedMessages("customer", "oi", 10, false, 77);
    const again = ingestedMessages("customer", "oi", 10, false, 77);
    expect(first[0]?.id).toBe("ingest:77");
    expect(again[0]?.id).toBe(first[0]?.id);
    // A divider written with its message needs an id of its own, or it would replace the message.
    const withDivider = ingestedMessages("human_agent", "oi", 10, true, 77);
    const ids = withDivider.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every message written here carries the conversation stamp", () => {
    for (const role of ["customer", "human_agent"] as const) {
      for (const writeDivider of [false, true]) {
        for (const m of ingestedMessages(role, "texto", CONV, writeDivider)) {
          expect(stampedConversationId(m)).toBe(CONV);
        }
      }
    }
  });
});

describe.skipIf(!dbUp)("ingestMessageIntoThread", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "IN", slug: `in-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of ["agent_threads", "chatwoot_instances"]) {
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

  // An append the window no longer reaches is refused with SUCCESS: the job completes and the row
  // is deleted as DONE, so this report is the only thing saying the words did not land. The
  // recoverer asks the same question before arming, but its read is minutes older and does not cover
  // the window moving in between. UNDECIDABLE rather than lost: eviction is not absence, and a reply
  // that landed 64 messages ago reads exactly like one that never did.
  test("an append the window has moved past is reported from inside the claim", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12441;
    const convId = 896;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        threadId: `chatwoot:${tenantId}:${instanceId}:${convId}`,
        lastEventAt: new Date(),
        contactInboxId,
      },
      select: { id: true },
    });
    // A janela CHEIA e toda acima do id perdido, que é a forma que 64 respostas de atendente na
    // mesma thread deixam.
    await suDb.agentThread.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId,
        threadId: graphThreadId,
        recentAgentMessageIds: Array.from(
          { length: INGEST_ID_WINDOW },
          (_, i) => 5000 + i,
        ),
      },
    });

    expect(
      await ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: convId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        role: "human_agent" as const,
        messageId: 4000,
        text: "a resposta que a janela já não alcança",
      }),
    ).toBe("skipped");

    const linhas = await flowLogRows(suDb, {
      where: { tenantId, conversationId: conv.id, stage: "memory" },
      select: { level: true, detail: true },
    });
    expect(
      linhas.map((l) => ({
        level: l.level,
        reason: (l.detail as { reason?: string } | null)?.reason ?? null,
        role: (l.detail as { role?: string } | null)?.role ?? null,
      })),
    ).toEqual([
      {
        level: "error",
        reason: "ingest_append_undecidable",
        role: "human_agent",
      },
    ]);

    // NOTE: The customer direction reports the same way. The customer messages that REACH this append
    // are, by construction, the ones no turn covers: silenced by a gate (off hours, the authorization
    // gate) or not handled by the bot (a human holds the conversation, or it is not pending). In all of
    // them "customer without a reply" is the expected state, so the loss list shows nothing, and the
    // delivery settled PROCESSED when the ARM succeeded, so the delivery ledger does not either. The
    // case is the customer writing three times during a human attendance.
    await suDb.agentThread.updateMany({
      where: { tenantId, contactInboxId },
      data: {
        recentSyncedMessageIds: Array.from(
          { length: INGEST_ID_WINDOW },
          (_, i) => 5000 + i,
        ),
      },
    });
    expect(
      await ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: convId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        role: "customer" as const,
        messageId: 4001,
        text: "a mensagem do cliente que a janela já não alcança",
      }),
    ).toBe("skipped");
    expect(
      (
        await flowLogRows(suDb, {
          where: { tenantId, conversationId: conv.id, stage: "memory" },
          select: { detail: true },
        })
      ).map((l) => (l.detail as { role?: string } | null)?.role ?? null),
    ).toEqual(["human_agent", "customer"]);

    await suDb.conversation.deleteMany({
      where: { tenantId, chatwootConversationId: convId },
    });
  });

  // A MESSAGE FROM BEFORE `/reset` DOES NOT RETURN TO THE MEMORY THE COMMAND CLEARED. The command
  // revokes every `INGEST_MESSAGE` of the thread inside its critical section, but not a job armed
  // AFTER the revocation: the receiver's own arm, which runs alongside the command, and the recovery
  // of a stranded reply, which decides minutes earlier and crosses a Chatwoot round trip. Both read
  // the boundary where it goes stale; here it does not, because the command waits on the same claim
  // this append holds.
  test("a message from before a /reset is not folded back into the cleared thread", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12422;
    const convId = 899;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingest = (messageId: number, text: string) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: convId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        role: "human_agent" as const,
        messageId,
        text,
      });

    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        threadId: `chatwoot:${tenantId}:${instanceId}:${convId}`,
        lastEventAt: new Date(),
        contactInboxId,
        // O comando foi digitado na mensagem 500 E a limpeza deu certo: tudo em ou abaixo dela é do
        // episódio anterior. As duas colunas, porque é isso que um `/reset` que limpou deixa — a
        // cerca lê a segunda, e o teste logo abaixo é o que prova a diferença.
        resetAtMessageId: 500,
        memoryClearedAtMessageId: 500,
      },
    });

    // Antes da fronteira: recusado, e recusado em silêncio para quem chamou — `skipped` é o que o
    // job de ingestão trata como sucesso, porque não há nada a retentar.
    expect(await ingest(499, "texto de antes do reset")).toBe("skipped");
    // A PRÓPRIA mensagem do comando também: ela carrega a fronteira.
    expect(await ingest(500, "/reset")).toBe("skipped");
    // Acima dela: o episódio novo, que entra normalmente.
    expect(await ingest(501, "texto do episódio novo")).toBe("ingested");

    const row = await suDb.agentThread.findFirstOrThrow({
      where: { tenantId, chatwootInstanceId: instanceId, contactInboxId },
      select: { recentAgentMessageIds: true },
    });
    expect(row.recentAgentMessageIds).toEqual([501]);

    await suDb.conversation.deleteMany({
      where: { tenantId, chatwootConversationId: convId },
    });
  });

  // A COMMAND THAT COULD NOT CLEAR CLOSES NOTHING. `reset_at_message_id` says the operator TYPED
  // `/reset`: it is committed by an earlier, independent statement, and the step that clears memory
  // refuses by design when a turn is already writing the thread (the ack names what it did not clear
  // and the stamp stays). A fence resting on it would drop a colleague's reply from a memory nobody
  // emptied; the column the clearing transaction writes is the one that counts.
  test("a boundary from a /reset whose memory step failed does not fence the append", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12451;
    const convId = 895;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        threadId: `chatwoot:${tenantId}:${instanceId}:${convId}`,
        lastEventAt: new Date(),
        contactInboxId,
        // O comando foi digitado, a limpeza recusou: só o primeiro carimbo existe.
        resetAtMessageId: 700,
      },
    });

    expect(
      await ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: convId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        role: "human_agent" as const,
        messageId: 699,
        text: "a resposta que ninguém apagou",
      }),
    ).toBe("ingested");

    await suDb.conversation.deleteMany({
      where: { tenantId, chatwootConversationId: convId },
    });
  });

  // THE SAME COMMAND, TYPED IN THE SIBLING CONVERSATION. `/reset` clears memory per contact-inbox
  // and stamps `reset_at_message_id` only on the conversation it was typed in, so two conversations
  // of one contact share a thread and only one carries the boundary. Asking the message's own
  // conversation would read null and restore pre-reset text into a thread whose dedup was cleared
  // with it, so nothing downstream would catch the duplicate.
  test("a message from before a /reset typed in a sibling conversation is refused too", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12431;
    const convId = 897;
    const siblingId = 898;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingest = (messageId: number, text: string) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: convId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        role: "human_agent" as const,
        messageId,
        text,
      });

    for (const [id, resetAt] of [
      [convId, null],
      // A irmã: o mesmo contact-inbox, e é nela que o operador digitou o comando.
      [siblingId, 600],
    ] as const) {
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: id,
          status: "open",
          threadId: `chatwoot:${tenantId}:${instanceId}:${id}`,
          lastEventAt: new Date(),
          contactInboxId,
          ...(resetAt === null
            ? {}
            : {
                resetAtMessageId: resetAt,
                memoryClearedAtMessageId: resetAt,
              }),
        },
      });
    }

    // A conversa desta mensagem NÃO tem carimbo nenhum: a fronteira é a da thread.
    expect(await ingest(599, "texto de antes da limpeza")).toBe("skipped");
    expect(await ingest(601, "texto do episódio novo")).toBe("ingested");

    const row = await suDb.agentThread.findFirstOrThrow({
      where: { tenantId, chatwootInstanceId: instanceId, contactInboxId },
      select: { recentAgentMessageIds: true },
    });
    expect(row.recentAgentMessageIds).toEqual([601]);

    await suDb.conversation.deleteMany({
      where: {
        tenantId,
        chatwootConversationId: { in: [convId, siblingId] },
      },
    });
  });

  // A conversation can be REOPENED after another has already run on this thread: an operator picking
  // an old one back up, a human agent replying in it. A divider probe asking "does this conversation
  // appear ANYWHERE in the thread" would answer yes from the earlier run, and the first turn of the
  // resumed attendance would reach the model as a continuation of the conversation in between. The
  // stamp is inert to the model; the divider is the only part of this it reads.
  test("a conversation reopened after another one still opens a new attendance", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12377;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingest = (conversationId: number, messageId: number, text: string) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        role: "customer" as const,
        messageId,
        text,
      });

    // Conversation 880, then 881 — an ordinary boundary — then 880 again.
    expect(await ingest(880, 1, "primeira dúvida")).toBe("ingested");
    expect(await ingest(881, 2, "outro assunto")).toBe("ingested");
    expect(await ingest(880, 3, "voltei naquele assunto")).toBe("ingested");

    const cp = await saver.get({ configurable: { thread_id: graphThreadId } });
    const messages = ((cp?.channel_values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    const dividers = messages.filter((m) => isConversationDivider(m));
    // NOTE: One for 881, one for the reopened 880; the second is the one a whole-thread probe skips.
    expect(dividers.length).toBe(2);
    expect(String(dividers.at(-1)?.content)).toContain(
      "voltei naquele assunto",
    );
  });

  test("appends to the same thread a real turn uses; the next turn sees the ingested messages", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12345;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingest = (over: {
      messageId: number;
      text: string;
      conversationId?: number;
    }) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: over.conversationId ?? 900,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        role: "customer" as const,
        ...over,
      });

    // 1. A real turn seeds the thread (the bot answered "resposta-1" to "oi").
    const model = new FakeListChatModel({
      responses: ["resposta-1", "resposta-2"],
    });
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model,
      systemPrompt: "Você é prestativa.",
      checkpointer: saver,
      tools: [],
    });
    await graph.invoke(
      { messages: [new HumanMessage("oi")] },
      { configurable: { thread_id: graphThreadId } },
    );

    // 2. While the bot is silent, ingest a customer message.
    expect(await ingest({ messageId: 11, text: "obrigado!" })).toBe("ingested");

    // NOTE: 3. Idempotency is membership, not a comparison. The same id is a re-delivery and is skipped;
    //    a LOWER id that was never folded in is ingested, where a high-water mark would read it as
    //    handled and lose the customer's words for good. What still refuses a low id is a window
    //    that has forgotten that far back, which ../../src/graph/ingest-dedup.ts decides and tests as a table.
    expect(await ingest({ messageId: 11, text: "DUP" })).toBe("skipped");
    expect(await ingest({ messageId: 5, text: "OLD" })).toBe("ingested");

    // 4. The next real turn loads the thread (incl. the ingested messages) and runs without error.
    const result = await graph.invoke(
      { messages: [new HumanMessage("e agora?")] },
      { configurable: { thread_id: graphThreadId } },
    );
    const contents = result.messages.map((m) => String(m.content));
    // The customer message the bot stayed silent on is in history.
    expect(contents.some((c) => c === "obrigado!")).toBe(true);
    // The de-duplicated text never made it in.
    expect(contents.some((c) => c === "DUP")).toBe(false);

    // 5. The scalar stays the HIGHEST id folded in, so ingesting 5 after 11 does not walk it back.
    const at = await suDb.agentThread.findUniqueOrThrow({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { lastSyncedMessageId: true },
    });
    expect(at.lastSyncedMessageId).toBe(11);
  });

  // An agent who opens the conversation sends its FIRST message. Detecting the transition only on
  // customer messages would leave that message inside the previous attendance, so the boundary would
  // land after it and the agent's opener would be summarized away with the attendance that ended.
  // The cut reads a stamp instead of the divider because the divider is one message, and an invoke
  // that started earlier saves the channel it loaded and erases it; the boundary lives on the
  // messages themselves.
  test("the boundary survives losing the divider", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 23458;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingest = (conversationId: number, messageId: number, text: string) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
        graphThreadId,
        messageId,
        text,
        base: appDb,
        checkpointer: saver,
        role: "customer" as const,
      });

    await ingest(820, 1, "atendimento antigo");
    await ingest(821, 2, "oi, voltei");
    await ingest(821, 3, "queria remarcar");

    const read = async () => {
      const cp = await saver.get({
        configurable: { thread_id: graphThreadId },
      });
      return ((cp?.channel_values as { messages?: BaseMessage[] } | undefined)
        ?.messages ?? []) as BaseMessage[];
    };
    const withDivider = await read();
    expect(
      selectClosedPrefix(withDivider, { currentAttendanceClosed: false })
        .closed,
    ).toHaveLength(1);

    // An older invoke finishing mid-attendance takes the divider with it.
    const divider = withDivider.find(isConversationDivider);
    expect(divider).toBeDefined();
    await buildThreadStateGraph(saver).updateState(
      { configurable: { thread_id: graphThreadId } },
      { messages: [new RemoveMessage({ id: divider?.id as string })] },
      THREAD_STATE_NODE,
    );

    const without = await read();
    expect(without.some(isConversationDivider)).toBe(false);
    const cut = selectClosedPrefix(without, { currentAttendanceClosed: false });
    expect(cut.closed).toHaveLength(1);
    expect(String(cut.closed[0]?.content)).toBe("atendimento antigo");
    expect(cut.open.map((m) => String(m.content))).toEqual(["queria remarcar"]);
  });

  // A monotonic watermark only guards at-most-once while ids arrive in order, and the two writers do
  // not share a latency: the customer's path waits on the eager media pass (STT/vision) and an
  // agent's reply waits on nothing, so an attendant answering a voice note is folded in FIRST and
  // would skip the customer's message for good on one shared column. Accepting an out-of-order id
  // means a message can land whose attendance is OVER (a delayed media webhook from A after B has
  // opened); through the normal boundary it would write a divider for A, walk the marker back to A,
  // and arm compaction for B, summarising the conversation still being served.
  test("a delayed message from an older conversation does not move the attendance", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12406;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const closed: number[] = [];
    const ingest = (conversationId: number, messageId: number, text: string) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        messageId,
        text,
        role: "customer",
        onAttendanceClosed: (prev) => {
          closed.push(prev);
        },
      });

    expect(await ingest(800, 900, "primeiro atendimento")).toBe("ingested");
    // B opens: this one legitimately closes A.
    expect(await ingest(801, 902, "segundo atendimento")).toBe("ingested");
    expect(closed).toEqual([800]);

    // The voice note from A, still transcribing when B started.
    expect(await ingest(800, 901, "<audio> do primeiro")).toBe("ingested");

    // It is in the thread, so nothing is lost.
    const cp = await saver.get({ configurable: { thread_id: graphThreadId } });
    const contents = (
      ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
        []) as BaseMessage[]
    ).map((m) => String(m.content));
    expect(contents.some((c) => c.includes("<audio> do primeiro"))).toBe(true);
    // NOTE: And it changed nothing else: no second boundary armed for B, and the thread still says B.
    expect(closed).toEqual([800]);
    const at = await suDb.agentThread.findUniqueOrThrow({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { lastConversationId: true, lastSyncedMessageId: true },
    });
    expect(at.lastConversationId).toBe(801);
    // The high-water mark does not walk backwards either.
    expect(at.lastSyncedMessageId).toBe(902);
    // Exactly one divider, for B. A late arrival never writes one.
    expect(
      contents.filter((c) => c.includes(CONVERSATION_DIVIDER)).length,
    ).toBe(1);
  });

  // The half of the late-arrival rule a marker check cannot reach. ../../src/modules/memory/cut.ts
  // decides which attendance is OPEN by reading the last stamp in the channel and walking back over
  // its run, so a late message stamped with its own conversation would redefine the open attendance
  // from the END of the thread: everything above it, the live conversation included, becomes the
  // closed prefix and compaction summarises a conversation still being served. Asserted through the
  // real consumer rather than by reading kwargs: the stamp only matters because of what the cut does.
  test("a late arrival does not put the live conversation in the closed prefix", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12409;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingest = (conversationId: number, messageId: number, text: string) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        messageId,
        text,
        role: "customer",
      });

    expect(await ingest(840, 960, "primeiro atendimento")).toBe("ingested");
    expect(await ingest(841, 962, "segundo atendimento, em andamento")).toBe(
      "ingested",
    );
    // The delayed voice note from the attendance that already ended.
    expect(await ingest(840, 961, "<audio> do primeiro")).toBe("ingested");

    const cp = await saver.get({ configurable: { thread_id: graphThreadId } });
    const messages = ((cp?.channel_values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    const cut = selectClosedPrefix(messages, {
      currentAttendanceClosed: false,
    });
    const open = cut.open.map((m) => String(m.content));
    const closed = cut.closed.map((m) => String(m.content));
    // 841 is still being served, so it is OPEN — not swept into a summary of a finished attendance.
    expect(open.some((c) => c.includes("segundo atendimento"))).toBe(true);
    expect(closed.some((c) => c.includes("segundo atendimento"))).toBe(false);
    // NOTE: The late message is in the thread, and it travels with the open attendance because it
    // never claimed one.
    expect(open.some((c) => c.includes("<audio> do primeiro"))).toBe(true);
    expect(
      stampedConversationId(messages[messages.length - 1] as BaseMessage),
    ).toBe(null);
  });

  // The same hazard reached through the OTHER writer. Reading the frontier from the arriving
  // message's own role would count a delayed customer message as current whenever a human agent
  // opened the new attendance, which is the ordinary shape: the bot qualifies, a person takes over,
  // and the takeover opens the next conversation. The customer's own mark is still in the old
  // attendance, so the delayed note would read as newest, close the LIVE conversation and walk the
  // marker backwards.
  test("a delayed message is late even when the newer one came from the other writer", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12408;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const closed: number[] = [];
    const ingest = (
      conversationId: number,
      messageId: number,
      text: string,
      role: IngestRole,
    ) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        messageId,
        text,
        role,
        onAttendanceClosed: (prev) => {
          closed.push(prev);
        },
      });

    expect(await ingest(820, 940, "posso remarcar?", "customer")).toBe(
      "ingested",
    );
    // B opens, and it is the ATTENDANT who opens it. Nothing on the customer's side moves.
    expect(await ingest(821, 942, "oi, assumindo daqui", "human_agent")).toBe(
      "ingested",
    );
    expect(closed).toEqual([820]);

    // The voice note from A, still transcribing when the attendant took over.
    expect(await ingest(820, 941, "<audio> do primeiro", "customer")).toBe(
      "ingested",
    );

    const cp = await saver.get({ configurable: { thread_id: graphThreadId } });
    const contents = (
      ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
        []) as BaseMessage[]
    ).map((m) => String(m.content));
    expect(contents.some((c) => c.includes("<audio> do primeiro"))).toBe(true);
    // B is still open: it must not have been armed for compaction, and the marker must not have
    // walked back to A.
    expect(closed).toEqual([820]);
    const at = await suDb.agentThread.findUniqueOrThrow({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { lastConversationId: true, lastSyncedMessageId: true },
    });
    expect(at.lastConversationId).toBe(821);
    expect(at.lastSyncedMessageId).toBe(941);
    expect(
      contents.filter((c) => c.includes(CONVERSATION_DIVIDER)).length,
    ).toBe(1);
  });

  // The repair of a half-done attempt must not rewrite the message. The append and the row
  // recording it are not atomic, so attempt 2 can find attempt 1's message already in the channel —
  // and by then the boundary claim sees this conversation's stamp and says the divider is not owed,
  // so a plain replacement would erase the attendance boundary the first attempt wrote. Simulated
  // the way it actually happens: the append lands, the row write does not.
  test("a retry does not strip the divider off its own earlier append", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12405;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingestOn = (
      conversationId: number,
      messageId: number,
      text: string,
    ) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        messageId,
        text,
        role: "customer",
      });
    const ingest = () =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: 990,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        messageId: 700,
        text: "bom dia, voltei",
        role: "customer",
      });
    const contents = async () => {
      const cp = await saver.get({
        configurable: { thread_id: graphThreadId },
      });
      return (
        ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
          []) as BaseMessage[]
      ).map((m) => String(m.content));
    };

    // An earlier attendance on this same thread, so message 700 opens a NEW one and is owed the
    // divider. Without a previous conversation there is no boundary to erase.
    expect(await ingestOn(989, 699, "obrigado")).toBe("ingested");
    expect(await ingest()).toBe("ingested");
    const first = (await contents()).slice(1);
    expect(first.length).toBe(1);
    expect(first[0]).toContain(CONVERSATION_DIVIDER);

    // The row write rolled back: the thread has no record of the message, but the channel does.
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_threads WHERE tenant_id = ${tenantId} AND contact_inbox_id = ${contactInboxId}`,
    );

    expect(await ingest()).toBe("ingested");
    const after = (await contents()).slice(1);
    expect(after.length).toBe(1);
    // The divider survives, which is the whole point: without the guard the reducer replaces the
    // divider-bearing message with a plain one and the attendance boundary is gone for good.
    expect(after[0]).toContain(CONVERSATION_DIVIDER);
  });

  test("an attendant's reply does not suppress a customer message ingested after it", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12399;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingest = (
      messageId: number,
      text: string,
      role: "customer" | "human_agent",
    ) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: 960,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        messageId,
        text,
        role,
      });

    // The attendant answers the voice note while its transcription is still running, so the REPLY
    // (id 101) is folded in before the customer's message (id 100).
    expect(
      await ingest(101, "Já te respondo sobre o áudio", "human_agent"),
    ).toBe("ingested");
    expect(await ingest(100, "<audio> quanto custa o plano?", "customer")).toBe(
      "ingested",
    );

    const cp = await saver.get({ configurable: { thread_id: graphThreadId } });
    const contents = (
      ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
        []) as BaseMessage[]
    ).map((m) => String(m.content));
    expect(contents.some((c) => c.includes("quanto custa o plano?"))).toBe(
      true,
    );
    expect(contents.some((c) => c.includes("Já te respondo"))).toBe(true);

    // Each direction still guards its OWN re-delivery.
    expect(await ingest(101, "DUP-ATENDENTE", "human_agent")).toBe("skipped");
    expect(await ingest(100, "DUP-CLIENTE", "customer")).toBe("skipped");

    const at = await suDb.agentThread.findUniqueOrThrow({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { lastSyncedMessageId: true, lastAgentMessageId: true },
    });
    expect(at.lastSyncedMessageId).toBe(100);
    expect(at.lastAgentMessageId).toBe(101);
  });

  // Why the watermark is not a high-water mark. Two customer messages do NOT share a latency: one
  // with media waits on the eager pass (STT/vision) before reaching ingestion, the other waits on
  // nothing. The LATER one can be folded in first, and a monotonic watermark would then read the
  // earlier one as handled. It would not be late but ABSENT: nothing re-delivers or restores it.
  // Asserted on the CHANNEL rather than the return value alone, because "ingested" is a proxy for
  // the customer's words being in the thread the agent reads.
  test("a customer message that arrives after a higher id is still folded in", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12401;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingest = (messageId: number, text: string) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: 970,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        messageId,
        text,
        role: "customer",
      });

    // The text message (id 200) overtakes the voice note (id 100) that is still transcribing.
    expect(await ingest(200, "consegue me ligar?")).toBe("ingested");
    expect(await ingest(100, "<audio> quanto custa o plano?")).toBe("ingested");

    const cp = await saver.get({ configurable: { thread_id: graphThreadId } });
    const contents = (
      ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
        []) as BaseMessage[]
    ).map((m) => String(m.content));
    expect(contents.some((c) => c.includes("quanto custa o plano?"))).toBe(
      true,
    );
    expect(contents.some((c) => c.includes("consegue me ligar?"))).toBe(true);

    // NOTE: Dedup still holds for a genuine re-delivery of either id: the property a high-water mark
    // gives, and the one the window must keep.
    expect(await ingest(200, "DUP-ALTO")).toBe("skipped");
    expect(await ingest(100, "DUP-BAIXO")).toBe("skipped");
  });

  // A human agent's reply is visible to the TURN, explicitly, not only to the summarizer. An agent
  // resuming after a handoff without knowing what its own team promised would quote a price nobody
  // agreed to. The note travels with it so the model can tell who spoke; stored bare, the words would
  // read as the customer's here too.
  test("the turn that resumes reads what the team promised, attributed", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12388;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const ingest = (
      messageId: number,
      text: string,
      role: "customer" | "human_agent",
    ) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: 950,
        contactInboxId,
        graphThreadId,
        base: appDb,
        checkpointer: saver,
        messageId,
        text,
        role,
      });

    expect(await ingest(1, "quanto fica o plano anual?", "customer")).toBe(
      "ingested",
    );
    expect(await ingest(2, "Fecho o anual por R$ 1.200.", "human_agent")).toBe(
      "ingested",
    );

    const model = new CapturingModel();
    await buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model,
      systemPrompt: "Você é prestativa.",
      checkpointer: saver,
      tools: [],
    }).invoke(
      { messages: [new HumanMessage("e o prazo de entrega?")] },
      { configurable: { thread_id: graphThreadId } },
    );

    const seen = (model.seen[0] ?? []).map((m) => String(m.content));
    const attendant = seen.find((c) => c.includes("R$ 1.200"));
    expect(attendant).toBeDefined();
    expect(attendant).toContain(HUMAN_AGENT_NOTE);
  });

  test("a customer message starting a NEW conversation on the thread gets the fresh-attendance divider", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 23456;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    // First conversation on this thread → no divider.
    await ingestMessageIntoThread({
      tenantId,
      instanceId,
      conversationId: 800,
      contactInboxId,
      graphThreadId,
      messageId: 1,
      text: "primeira",
      role: "customer",
      base: appDb,
      checkpointer: saver,
    });
    // A different conversation reusing the thread → divider on the first message.
    await ingestMessageIntoThread({
      tenantId,
      instanceId,
      conversationId: 801,
      contactInboxId,
      graphThreadId,
      messageId: 2,
      text: "segunda",
      role: "customer",
      base: appDb,
      checkpointer: saver,
    });
    const cp = await saver.get({
      configurable: { thread_id: graphThreadId },
    });
    const messages = ((
      cp?.channel_values as { messages?: Array<{ content: unknown }> }
    )?.messages ?? []) as Array<{ content: unknown }>;
    expect(String(messages[0]?.content)).toBe("primeira");
    expect(String(messages[1]?.content)).toContain("nova conversa");
    expect(String(messages[1]?.content)).toContain("segunda");
    // And it is a boundary the CUT can find. This path folds the marker into the customer's own
    // message, so the text alone cannot say whether the customer wrote it — recognition is by
    // metadata, and a divider written without it leaves the first attendance uncompactable forever.
    const cut = selectClosedPrefix(messages as unknown as BaseMessage[], {
      currentAttendanceClosed: false,
    });
    expect(cut.closed).toHaveLength(1);
    expect(cut.open).toHaveLength(1);
  });

  test("a boundary crossed while a turn owns the thread is armed but not consumed", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 23459;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const closed: number[] = [];
    const ingest = (conversationId: number, messageId: number, text: string) =>
      ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
        graphThreadId,
        messageId,
        text,
        base: appDb,
        checkpointer: saver,
        role: "customer" as const,
        onAttendanceClosed: (prev) => {
          closed.push(prev);
        },
      });
    await ingest(810, 1, "primeira");

    // An older turn is still invoking on this thread. Its save will restore the channel it loaded,
    // so a divider written now would be erased while the marker advanced for good.
    markTurnInFlight(graphThreadId);
    await ingest(811, 2, "segunda");
    clearTurnInFlight(graphThreadId);

    const mid = await saver.get({ configurable: { thread_id: graphThreadId } });
    const midMessages = ((mid?.channel_values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    // No divider: the message went in raw. It still carries its conversation, which is what the cut
    // reads, so the attendance stays compactable either way.
    expect(midMessages.map((m) => isConversationDivider(m))).toEqual([
      false,
      false,
    ]);
    expect(stampedConversationId(midMessages[1] as BaseMessage)).toBe(811);
    // Armed all the same: attendance 810 is compactable right now.
    expect(closed).toEqual([810]);
    // And the marker did NOT move, so the boundary is still owed.
    const row = await suDb.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { lastConversationId: true, lastSyncedMessageId: true },
    });
    expect(row?.lastConversationId).toBe(810);
    // The synced watermark advances regardless: it guards at-most-once append.
    expect(row?.lastSyncedMessageId).toBe(2);

    // The next message of the SAME conversation does NOT get the divider, even with the thread free
    // and the marker still owing the boundary. This attendance has already started, so a divider
    // here would sit in the middle of it and tell the model that the messages before it — messages of
    // the conversation it is answering right now — are a past attendance. A hint in the wrong place
    // is worse than no hint.
    await ingest(811, 3, "terceira");
    const after = await saver.get({
      configurable: { thread_id: graphThreadId },
    });
    const messages = ((after?.channel_values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(messages.map((m) => isConversationDivider(m))).toEqual([
      false,
      false,
      false,
    ]);
    // The boundary is on the messages either way, which is the whole reason losing the divider is
    // survivable: the cut still ends the old attendance in the right place.
    expect(messages.map(stampedConversationId)).toEqual([810, 811, 811]);
    const cut = selectClosedPrefix(messages, {
      currentAttendanceClosed: false,
    });
    expect(cut.closed.map((m) => String(m.content))).toEqual(["primeira"]);
  });

  // The row is READ at the top of the section and WRITTEN at the end, with checkpointer round-trips in
  // between, and the queue that orders them is process-local. Another replica writing in that window
  // must survive: recomputing the mark and the dedupe ledger from what was read BEFORE it landed
  // would erase it. The other replica is personified by writing the row from inside `stillWanted`,
  // which is called exactly in that window and for an unrelated reason. Nothing else here reaches it.
  test("a concurrent write in the read-to-write window is not walked backwards", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 7301;
    const key = {
      tenantId_chatwootInstanceId_contactInboxId: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId,
      },
    };
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await suDb.agentThread.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId,
        threadId: graphThreadId,
        lastSyncedMessageId: 100,
        recentSyncedMessageIds: [100],
      },
    });

    const outcome = await ingestMessageIntoThread({
      tenantId,
      instanceId,
      conversationId: 5,
      contactInboxId,
      graphThreadId,
      messageId: 300,
      text: "a minha",
      base: appDb,
      checkpointer: saver,
      role: "customer" as const,
      deferIfTurnInFlight: true,
      stillWanted: async () => {
        // The other replica folds in a HIGHER id and finishes first.
        await suDb.agentThread.update({
          where: key,
          data: {
            lastSyncedMessageId: 900,
            recentSyncedMessageIds: [100, 900],
          },
        });
        return true;
      },
    });
    expect(outcome).toBe("ingested");

    const row = await suDb.agentThread.findUniqueOrThrow({
      where: key,
      select: { lastSyncedMessageId: true, recentSyncedMessageIds: true },
    });
    // The scalar is the highest id ANY writer folded in, never this call's stale idea of it.
    expect(row.lastSyncedMessageId).toBe(900);
    // And the other replica's id is still in the ledger. Losing it is not cosmetic: membership is
    // what recognises a re-delivery, so a dropped id is a message this thread would append twice.
    expect(row.recentSyncedMessageIds).toEqual([100, 900, 300]);
  });
});
