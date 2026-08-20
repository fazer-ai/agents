import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type BaseMessage,
  HumanMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { buildAgentGraph } from "@/graph/graph";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import { ingestMessageIntoThread } from "@/graph/ingest";
import { isConversationDivider, stampedConversationId } from "@/graph/markers";
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
        ...over,
      });

    // 1. A real turn seeds the thread (the bot answered "resposta-1" to "oi").
    const model = new FakeListChatModel({
      responses: ["resposta-1", "resposta-2"],
    });
    const graph = buildAgentGraph({
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

    // 3. Idempotency: the same id (re-delivery) and an older id are both skipped by the watermark.
    expect(await ingest({ messageId: 11, text: "DUP" })).toBe("skipped");
    expect(await ingest({ messageId: 5, text: "OLD" })).toBe("skipped");

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

    // 5. The watermark advanced to the highest ingested id.
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
});
