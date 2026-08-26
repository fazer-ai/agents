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
// here on purpose — this is the decision, and the cell that used to be missing (a human agent's
// reply) is one whose wrong answer is a permanent memory with the operator's words in it.
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
  // divider — the shape the customer path uses — would store them in a message that reads as the
  // CONTACT's, which is the bug this whole change is about, reintroduced by an optimization.
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
  // The append and the row that records it are not one atomic write, and since ingestion became a
  // retried job a failure between them comes back. Ids derived from the Chatwoot message are what
  // makes that retry a no-op rewrite: the reducer replaces a same-id message in place.
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

  // A conversation can be REOPENED after another has already run on this thread — an operator picking
  // an old one back up, a human agent replying in it. The probe that decides whether to write the
  // divider used to ask "does this conversation appear ANYWHERE in the thread", and the earlier run
  // answered yes: no divider, so the first turn of the resumed attendance reached the model as a
  // continuation of the conversation that ran in between. The stamp is inert to the model; the
  // divider is the only part of this it reads.
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
    // One for 881, one for the reopened 880 — the second is the one that used to be missing.
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

    // 3. Idempotency is membership, not a comparison. The same id is a re-delivery and is skipped;
    //    a LOWER id that was never folded in is ingested, and that reversal is the point of #194 —
    //    under the old high-water mark it read as handled and the customer's words were lost for
    //    good. What still refuses a low id is a window that has forgotten that far back, which
    //    ./ingest-dedup.ts decides and tests as a table.
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
  // customer messages left that message inside the previous attendance, so when the customer finally
  // replied the boundary landed after it — and the agent's opener was summarized and removed with the
  // attendance that had already ended.
  // The whole reason the cut reads a stamp instead of the divider: the divider is one message, and an
  // invoke that started earlier saves the channel it loaded and erases it. Erased, the boundary has to
  // survive anyway — it lives on the messages themselves.
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

  // Round-1 review finding (P1). The watermark is monotonic, which only guards at-most-once while
  // the ids reaching it arrive in order — and the two writers do not share a latency. The customer's
  // path waits on the eager media pass (STT/vision, a provider round-trip) and an agent's reply waits
  // on nothing, so an attendant answering a voice note is folded in FIRST. On one shared column that
  // higher id advances the watermark and the customer's message is skipped for good: the fix for a
  // memory missing the team's half would have started losing the customer's.
  // Accepting an out-of-order id means a message can land whose attendance is already OVER: a
  // delayed media webhook from conversation A, arriving after B has opened. Run through the normal
  // boundary it would write a divider for A, walk the thread marker backwards to A, and arm
  // compaction for B — the conversation still being served. B would be summarised mid-attendance and
  // its raw turns replaced by a summary of a conversation that has not finished.
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

    // It is in the thread — nothing is lost, which is the whole point of #194 —
    const cp = await saver.get({ configurable: { thread_id: graphThreadId } });
    const contents = (
      ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
        []) as BaseMessage[]
    ).map((m) => String(m.content));
    expect(contents.some((c) => c.includes("<audio> do primeiro"))).toBe(true);
    // — and it changed nothing else. No second boundary armed for B, and the thread still says B.
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

  // Round-8 review finding (P1), and the half of the late-arrival rule a marker check cannot reach.
  // ../../src/modules/memory/cut.ts decides which attendance is OPEN by reading the last stamp in the
  // channel and walking back over its run — so a late message stamped with the conversation it
  // belongs to redefines the open attendance from the END of the thread. Everything above it, the
  // live conversation included, becomes the closed prefix, and compaction replaces a conversation
  // still being served with a summary of it.
  //
  // Asserted through the real consumer rather than by reading kwargs: the stamp only matters because
  // of what the cut does with it.
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
    // The late message is in the thread, which is the point of #194, and it travels with the open
    // attendance because it never claimed one.
    expect(open.some((c) => c.includes("<audio> do primeiro"))).toBe(true);
    expect(
      stampedConversationId(messages[messages.length - 1] as BaseMessage),
    ).toBe(null);
  });

  // Round-6 review finding (P2), and the same hazard as the test above reached through the OTHER
  // writer. The frontier was read from the arriving message's own role, so a delayed customer
  // message still counted as current whenever the new attendance had been opened by a human agent —
  // which is the ordinary shape of it: the bot qualifies, a person takes over, and the takeover
  // message is the one that opens the next conversation. The customer's own mark is still back in
  // the old attendance, so the delayed note read as the newest thing on the thread, closed the LIVE
  // conversation and walked the marker backwards.
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

  // Issue #194, hazard 2, and the reason the watermark stops being a high-water mark. The two
  // customer messages do NOT share a latency: one with media waits on the eager pass (a provider
  // round-trip for STT/vision) before reaching ingestion, the other waits on nothing. So the LATER
  // message can be folded in first, and a monotonic watermark then reads the earlier one as already
  // handled. It is not late, it is ABSENT: nothing re-delivers it and nothing restores it.
  //
  // Asserted on the CHANNEL rather than on the return value alone, because "ingested" is a proxy —
  // what the issue says goes missing is the customer's words in the thread the agent reads.
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

    // Dedup still holds for a genuine re-delivery of either id, which is the property the
    // high-water mark was there for and the one that must survive replacing it.
    expect(await ingest(200, "DUP-ALTO")).toBe("skipped");
    expect(await ingest(100, "DUP-BAIXO")).toBe("skipped");
  });

  // The decision issue #187 asked to make EXPLICITLY rather than as a side effect: a human agent's
  // reply is visible to the TURN, not only to the summarizer. An agent resuming a conversation after
  // a handoff and not knowing what its own team promised is the same defect one turn earlier — it
  // would quote a price nobody agreed to. The note travels with it so the model can tell who spoke;
  // stored bare, the words would read as the customer's here too.
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

  // Issue #203, the half that survives the claim: the row is READ at the top of the section and
  // WRITTEN at the end, with checkpointer round-trips in between, and the queue that ordered them is
  // process-local. Another replica writing in that window used to be erased by whichever append
  // finished second, because it recomputed the mark and the dedupe ledger from what it had read
  // BEFORE the other one landed.
  //
  // The other replica is personified by writing the row from inside `stillWanted`, which is called
  // exactly in that window and for an unrelated reason. Nothing else in this file can reach it.
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
