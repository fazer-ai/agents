import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import {
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "@/graph/inflight";
import {
  CONVERSATION_DIVIDER,
  conversationDividerMessage,
  conversationStamp,
  MEMORY_HEAD_OPEN,
  memoryHeadMessage,
} from "@/graph/markers";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { runScopedOn } from "@/lib/tenancy";
import { type CompactPayload, runCompaction } from "@/modules/memory/compact";
import { MEMORY_HEAD_MAX_ATTENDANCES } from "@/modules/memory/cut";
import { seedChatwootInstance } from "../utils/chatwoot";
import { UsageReportingModel } from "../utils/scripted-models";

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

// The summarizer, scripted. `beforeReturn` is the whole reason this is not FakeListChatModel: the
// provider round-trip is the window during which a customer message can land on the thread, and the
// only way to test that window is to write into it from inside the call.
class SummarizerModel extends BaseChatModel {
  calls = 0;
  seen: string[] = [];
  constructor(
    private readonly reply: string,
    private readonly beforeReturn?: () => Promise<void>,
  ) {
    super({});
  }
  _llmType() {
    return "fake-summarizer";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    this.seen.push(messages.map((m) => String(m.content)).join("\n"));
    await this.beforeReturn?.();
    return {
      generations: [{ text: this.reply, message: new AIMessage(this.reply) }],
    };
  }
}

// A saver that lets a test write to the thread at an exact point in the compaction's checkpoint
// traffic. The window that matters is between the job's locked re-read and the update it derives
// from it: the advisory lock keeps INGESTION out of it, but a graph turn writes to this same thread
// holding no lock at all, so a customer message really can land there.
class HookedSaver extends MemorySaver {
  calls = 0;
  constructor(
    private readonly at: number,
    private readonly hook: () => Promise<void>,
  ) {
    super();
  }
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the saver's own loose tuple typing
  override async getTuple(config: any): Promise<any> {
    const tuple = await super.getTuple(config);
    this.calls += 1;
    if (this.calls === this.at) await this.hook();
    return tuple;
  }
}

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;

// A distinctive string that only ever exists in the seeded transcript, so a test can prove it did
// NOT leak into a place that promises to carry no message text.
const SEEDED_TEXT = "abacaxi-com-hortela-4471";

describe.skipIf(!dbUp)("memory compaction", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MC", slug: `mc-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 11,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        settings: { memory: { compaction: { enabled: true } } },
      },
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "attendance_summaries",
        "execution_logs",
        "agent_threads",
        "conversations",
        "inboxes",
        "agents",
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

  async function setCompaction(enabled: boolean) {
    await suDb.agent.update({
      where: { id: agentId },
      data: { settings: { memory: { compaction: { enabled } } } },
    });
  }

  // The AgentThread row comes with the messages on purpose: in production every path that stamps a
  // message upserts it, so a populated channel with no row is not a state the system can reach —
  // except as the residue of a /reset, which is what the generation fence keys on. Seeding the
  // channel alone would model an impossible thread and quietly exercise the fence's null branch.
  // `withThreadRow: false` is for the one test that wants that residue on purpose.
  async function seedThread(
    saver: MemorySaver,
    threadId: string,
    messages: BaseMessage[],
    opts: { withThreadRow?: boolean } = {},
  ) {
    const graph = buildThreadStateGraph(saver);
    for (const m of messages) {
      await graph.updateState(
        { configurable: { thread_id: threadId } },
        { messages: [m] },
        THREAD_STATE_NODE,
      );
    }
    if (opts.withThreadRow === false) return;
    const contactInboxId = Number(threadId.split(":ci:")[1]);
    await suDb.agentThread.upsert({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      create: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId,
        threadId,
      },
      update: {},
    });
  }

  async function readThread(
    saver: MemorySaver,
    threadId: string,
  ): Promise<string[]> {
    const cp = await saver.get({ configurable: { thread_id: threadId } });
    const messages = ((
      cp?.channel_values as { messages?: BaseMessage[] } | undefined
    )?.messages ?? []) as BaseMessage[];
    return messages.map((m) => String(m.content));
  }

  // Two attendances on one thread: the first one (raw) is what a boundary trigger compacts. The
  // customer turns carry the conversation they belong to, as production writes them; the assistant
  // replies do not, because the graph builds those.
  function twoAttendances(closedId = 708, openId = 709): BaseMessage[] {
    return [
      new HumanMessage({
        content: `quero marcar uma avaliação, ${SEEDED_TEXT}`,
        additional_kwargs: conversationStamp(closedId),
      }),
      new AIMessage("Claro! Consegui terça 08h30, R$ 250."),
      new HumanMessage({
        content: "pode ser, obrigado",
        additional_kwargs: conversationStamp(closedId),
      }),
      conversationDividerMessage(openId, "oi, voltei"),
      new AIMessage("Oi! Como posso ajudar?"),
    ];
  }

  function countFlowLines(threadId: string) {
    return suDb.executionLog.count({
      where: { tenantId, stage: "memory", threadId },
    });
  }

  // emitFlowEvent is fire-and-forget, so a test that reads too early sees zero and proves nothing.
  async function waitForFlowLines(threadId: string, n: number) {
    for (let i = 0; i < 40; i++) {
      if ((await countFlowLines(threadId)) >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const payload = (
    contactInboxId: number,
    conversationId: number,
    reason: "resolved" | "new_attendance",
  ): CompactPayload => ({
    instanceId,
    contactInboxId,
    conversationId,
    agentId,
    reason,
  });

  test("a closed attendance becomes one summary and the open one travels untouched", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5001;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());
    const model = new SummarizerModel("Ana marcou avaliação terça, R$ 250.");

    const res = await runCompaction(
      tenantId,
      payload(contactInboxId, 708, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => model },
    );
    expect(res).toEqual({ outcome: "done" });

    const after = await readThread(saver, threadId);
    // head + the open attendance, in order. The three raw turns of the closed one are gone.
    expect(after.length).toBe(3);
    expect(after[0]).toStartWith(MEMORY_HEAD_OPEN);
    expect(after[0]).toContain("Ana marcou avaliação terça");
    expect(after[1]).toStartWith(CONVERSATION_DIVIDER);
    expect(after[2]).toBe("Oi! Como posso ajudar?");
    expect(after.some((c) => c.includes(SEEDED_TEXT))).toBe(false);

    // The summarizer read the closed turns and NOT the open ones — summarizing the conversation
    // still in progress is how a thread ends up with the same events described twice.
    expect(model.calls).toBe(1);
    expect(model.seen[0]).toContain(SEEDED_TEXT);
    expect(model.seen[0]).not.toContain("Oi! Como posso ajudar?");

    const rows = await suDb.attendanceSummary.findMany({ where: { tenantId } });
    expect(rows.length).toBe(1);
    // 708 is the conversation the closed turns are stamped with: the row is filed under the
    // attendance it describes, not under whatever the job happened to be armed for.
    expect(rows[0]?.conversationId).toBe(708);
    expect(rows[0]?.messageCount).toBe(3);
  });

  // Both triggers can fire for the same thread, and a job that failed late gets retried, so a second
  // run has to be free AND invisible. "Same content" is not enough: a run that rewrites the thread to
  // the same bytes still writes a checkpoint and still tells the operator a compaction happened.
  test("running it again touches nothing: no row, no generation, no write, no log line", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5002;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());
    const model = new SummarizerModel("resumo");

    const args = [
      tenantId,
      payload(contactInboxId, 701, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => model },
    ] as const;
    await runCompaction(...args);
    const afterFirst = await readThread(saver, threadId);
    const checkpointAfterFirst = (
      await saver.get({ configurable: { thread_id: threadId } })
    )?.id;
    await waitForFlowLines(threadId, 1);

    await runCompaction(...args);

    expect(await readThread(saver, threadId)).toEqual(afterFirst);
    expect(model.calls).toBe(1);
    // No new checkpoint: the second run never wrote to the thread at all.
    expect(
      (await saver.get({ configurable: { thread_id: threadId } }))?.id,
    ).toBe(checkpointAfterFirst);
    const rows = await suDb.attendanceSummary.findMany({
      where: { tenantId, contactInboxId },
    });
    expect(rows.length).toBe(1);
    // And the trail still shows ONE compaction, not two.
    expect(await countFlowLines(threadId)).toBe(1);
  });

  // The failure this guards against loses a customer's message, silently. The summarizer takes
  // seconds, the thread is append-only during that time, and a rewrite computed from the OLD read
  // would delete whatever arrived in between.
  test("a message that arrives while the summarizer runs survives the rewrite", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5003;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());

    const model = new SummarizerModel("resumo", async () => {
      await seedThread(saver, threadId, [
        new HumanMessage("esqueci de perguntar uma coisa"),
      ]);
    });

    await runCompaction(
      tenantId,
      payload(contactInboxId, 702, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => model },
    );

    const after = await readThread(saver, threadId);
    expect(after.at(-1)).toBe("esqueci de perguntar uma coisa");
    expect(after[0]).toStartWith(MEMORY_HEAD_OPEN);
    // and the open attendance is still whole
    expect(after.some((c) => c.startsWith(CONVERSATION_DIVIDER))).toBe(true);
  });

  // /reset deletes the whole thread (webhook.ts), and it can land while a compaction is mid-
  // summarize. Writing the rewrite anyway would put memory back that an operator just deleted on
  // purpose, rendered from rows the reset already cleared.
  test("a thread reset during the summarizer aborts the rewrite", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5008;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());
    const model = new SummarizerModel("resumo", async () => {
      await saver.deleteThread(threadId);
    });

    const res = await runCompaction(
      tenantId,
      payload(contactInboxId, 707, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => model },
    );

    expect(res.outcome).toBe("fail");
    expect(await readThread(saver, threadId)).toEqual([]);
  });

  // The same race, with the customer typing again right after the reset. The message COUNT lines up
  // with what was summarized, so only the identity of the messages tells the two apart — and getting
  // it wrong deletes three messages the customer just sent.
  test("a reset followed by fresh messages is caught by identity, not by count", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5009;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());
    const model = new SummarizerModel("resumo", async () => {
      await saver.deleteThread(threadId);
      await seedThread(saver, threadId, [
        new HumanMessage("oi"),
        new HumanMessage("tudo bem?"),
        new HumanMessage("consegue me ajudar?"),
      ]);
    });

    const res = await runCompaction(
      tenantId,
      payload(contactInboxId, 708, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => model },
    );

    expect(res.outcome).toBe("fail");
    expect(await readThread(saver, threadId)).toEqual([
      "oi",
      "tudo bem?",
      "consegue me ajudar?",
    ]);
  });

  // The narrow window, and the reason the update names the ids it removes instead of clearing the
  // channel: REMOVE_ALL_MESSAGES replaces the whole list with what the update carries, so a message
  // written here would be erased by a compaction that never read it.
  test("a message written between the locked re-read and the update survives", async () => {
    const contactInboxId = 5010;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    let saver: HookedSaver | undefined;
    // The job's checkpoint traffic is: getState, then the locked re-read, then the update's own
    // internal read. Firing on the second is what puts the write inside the gap.
    saver = new HookedSaver(2, async () => {
      if (!saver) return;
      await seedThread(saver, threadId, [
        new HumanMessage("mensagem que chegou no meio da reescrita"),
      ]);
    });
    await seedThread(saver, threadId, twoAttendances());
    const before = saver.calls;
    saver.calls = 0;
    expect(before).toBeGreaterThan(0);

    await runCompaction(
      tenantId,
      payload(contactInboxId, 709, "new_attendance"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () => new SummarizerModel("resumo"),
      },
    );

    const after = await readThread(saver, threadId);
    expect(after).toContain("mensagem que chegou no meio da reescrita");
    expect(after[0]).toStartWith(MEMORY_HEAD_OPEN);
  });

  // The measured fact the in-flight guard is built on, pinned here so it stays checkable. A LangGraph
  // invoke is a read-modify-write of the WHOLE message channel: it saves the state it loaded when it
  // started, plus its own messages. A rewrite that lands in the middle of one is therefore not merged
  // — it is UNDONE the moment the turn finishes, and the raw history it replaced comes back.
  test("a rewrite that lands mid-invoke is undone when the turn finishes", async () => {
    const saver = new MemorySaver();
    const threadId = contactInboxThreadId(tenantId, instanceId, 5020);
    const cfg = { configurable: { thread_id: threadId } };
    let release = () => {};
    const modelIsThinking = new Promise<void>((r) => {
      release = r;
    });
    // Stands in for the agent graph: one node that takes as long as a generation does.
    const turnGraph = new StateGraph(MessagesAnnotation)
      .addNode("agent", async () => {
        await modelIsThinking;
        return {
          messages: [new AIMessage({ id: "ai-1", content: "resposta" })],
        };
      })
      .addEdge(START, "agent")
      .addEdge("agent", END)
      .compile({ checkpointer: saver });

    await seedThread(saver, threadId, [
      new HumanMessage({ id: "m1", content: `pedido antigo, ${SEEDED_TEXT}` }),
      new AIMessage({ id: "m2", content: "combinado" }),
      new HumanMessage({ id: "m3", content: "assunto novo" }),
    ]);

    const turn = turnGraph.invoke(
      { messages: [new HumanMessage({ id: "m4", content: "oi de novo" })] },
      cfg,
    );
    // Let the invoke load the channel before the rewrite touches it.
    await new Promise((r) => setTimeout(r, 30));

    const plain = buildThreadStateGraph(saver);
    await plain.updateState(
      cfg,
      {
        messages: [
          memoryHeadMessage(
            `${MEMORY_HEAD_OPEN}resumo</atendimentos-anteriores>`,
            "m1",
          ),
          new RemoveMessage({ id: "m2" }),
        ],
      },
      THREAD_STATE_NODE,
    );
    expect((await readThread(saver, threadId))[0]).toStartWith(
      MEMORY_HEAD_OPEN,
    );

    release();
    await turn;

    const after = await readThread(saver, threadId);
    expect(after[0]).not.toStartWith(MEMORY_HEAD_OPEN);
    // Not merely "the head is gone": the raw turns it had replaced are back, which is what would
    // make the next cut summarize them a second time.
    expect(after[0]).toContain(SEEDED_TEXT);
    expect(after).toContain("combinado");
  });

  test("a turn already in flight defers the job instead of paying for it", async () => {
    const contactInboxId = 5021;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const saver = new MemorySaver();
    await seedThread(saver, threadId, twoAttendances());
    const model = new SummarizerModel("resumo");

    markTurnInFlight(threadId);
    let result: Awaited<ReturnType<typeof runCompaction>>;
    try {
      result = await runCompaction(
        tenantId,
        payload(contactInboxId, 720, "new_attendance"),
        appDb,
        { checkpointer: saver, makeModel: () => model },
      );
    } finally {
      // The registry is module-global: a leak here would silently disable compaction for every test
      // that follows.
      clearTurnInFlight(threadId);
    }

    expect(result.outcome).toBe("reschedule");
    // Deferred BEFORE the generation, not after: the reply the model would have written is thrown
    // away by the locked check anyway, and the tenant would have been billed for it.
    expect(model.calls).toBe(0);
    expect(
      await suDb.attendanceSummary.count({
        where: { tenantId, contactInboxId },
      }),
    ).toBe(0);
    expect(await readThread(saver, threadId)).toEqual(
      twoAttendances().map((m) => String(m.content)),
    );
  });

  // Overlapping turns are ordinary here: two deliveries for one conversation race whenever debounce
  // is off, and a follow-up nudge invokes on this same thread. With presence instead of a count, the
  // FIRST turn to finish would release a claim the other still holds, and the rewrite would land in
  // the middle of the surviving invoke — the exact undo the claim exists to prevent, visible only
  // under load.
  test("one turn finishing does not release a claim another turn still holds", async () => {
    const contactInboxId = 5023;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const saver = new MemorySaver();
    await seedThread(saver, threadId, twoAttendances());
    const model = new SummarizerModel("resumo");

    markTurnInFlight(threadId); // turn A
    markTurnInFlight(threadId); // turn B, overlapping
    clearTurnInFlight(threadId); // A finishes; B is still invoking
    let result: Awaited<ReturnType<typeof runCompaction>>;
    try {
      result = await runCompaction(
        tenantId,
        payload(contactInboxId, 722, "new_attendance"),
        appDb,
        { checkpointer: saver, makeModel: () => model },
      );
    } finally {
      clearTurnInFlight(threadId);
    }

    expect(result.outcome).toBe("reschedule");
    expect(model.calls).toBe(0);
    expect(await readThread(saver, threadId)).toEqual(
      twoAttendances().map((m) => String(m.content)),
    );
    // Balanced: once B releases too, the thread is free again.
    expect(isTurnInFlight(threadId)).toBe(false);
  });

  test("a turn that starts while the summarizer runs is caught by the locked check", async () => {
    const contactInboxId = 5022;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    // Fires on the job's FIRST checkpoint read, which is past the cheap pre-check and before the
    // locked one — exactly the window a turn starting mid-summarization occupies. `armed` keeps the
    // hook out of the seeding above it: seedThread reads the checkpoint too, and a mark set there
    // would be caught by the pre-check and prove nothing about the locked one.
    let armed = false;
    const saver = new HookedSaver(1, async () => {
      if (armed) markTurnInFlight(threadId);
    });
    await seedThread(saver, threadId, twoAttendances());
    saver.calls = 0;
    armed = true;
    const model = new SummarizerModel("resumo do atendimento");

    let result: Awaited<ReturnType<typeof runCompaction>>;
    try {
      result = await runCompaction(
        tenantId,
        payload(contactInboxId, 721, "new_attendance"),
        appDb,
        { checkpointer: saver, makeModel: () => model },
      );
    } finally {
      clearTurnInFlight(threadId);
    }

    expect(result.outcome).toBe("reschedule");
    // The thread is left exactly as the turn found it. Rewriting here is what the turn would undo.
    expect(await readThread(saver, threadId)).toEqual(
      twoAttendances().map((m) => String(m.content)),
    );
    // The summary was already generated and committed before the rewrite could be attempted, and it
    // stays: that is what makes the deferred attempt free instead of a second generation.
    const rows = await suDb.attendanceSummary.findMany({
      where: { tenantId, contactInboxId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("resumo do atendimento");
    expect(model.calls).toBe(1);
  });

  test("a resolve that was undone inside the grace window does not compact", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5004;
    const conversationId = 703;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
        // reopened between the arm and the run
        status: "open",
        threadId: `${tenantId}:${instanceId}:${conversationId}`,
        lastEventAt: new Date(),
      },
    });
    const model = new SummarizerModel("resumo");

    const before = await readThread(saver, threadId);
    await runCompaction(
      tenantId,
      payload(contactInboxId, conversationId, "resolved"),
      appDb,
      { checkpointer: saver, makeModel: () => model },
    );

    expect(await readThread(saver, threadId)).toEqual(before);
    expect(model.calls).toBe(0);
    expect(
      await suDb.attendanceSummary.count({
        where: { tenantId, contactInboxId },
      }),
    ).toBe(0);
  });

  // The row is committed before the rewrite, on purpose. So a deferral between the two leaves a row
  // describing turns that are still sitting raw in the thread — and if the conversation reopened
  // meanwhile, the retry used to bail at the reopened guard and strand it there. The next resolve then
  // summarized those same turns again into a SECOND row, and the memory head said it all twice.
  test("a summary stranded by a deferral is applied even after the conversation reopens", async () => {
    const contactInboxId = 5024;
    const conversationId = 723;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${conversationId}`,
        lastEventAt: new Date(),
      },
    });
    const closed = [
      new HumanMessage({
        content: "quanto custa a limpeza?",
        additional_kwargs: conversationStamp(conversationId),
      }),
      new AIMessage("R$ 180, com retorno em 6 meses."),
    ];
    // A turn starts while the summarizer is running: the row lands, the rewrite defers.
    let armed = false;
    const saver = new HookedSaver(1, async () => {
      if (armed) markTurnInFlight(threadId);
    });
    await seedThread(saver, threadId, closed);
    saver.calls = 0;
    armed = true;
    const model = new SummarizerModel("Orçamento de R$ 180 informado.");

    let first: Awaited<ReturnType<typeof runCompaction>>;
    try {
      first = await runCompaction(
        tenantId,
        payload(contactInboxId, conversationId, "resolved"),
        appDb,
        { checkpointer: saver, makeModel: () => model },
      );
    } finally {
      clearTurnInFlight(threadId);
    }
    expect(first.outcome).toBe("reschedule");
    expect(
      await suDb.attendanceSummary.count({
        where: { tenantId, contactInboxId },
      }),
    ).toBe(1);
    // The turn that got in the way was the customer coming back: the conversation is open again.
    await suDb.conversation.update({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      data: { status: "open" },
    });
    await seedThread(saver, threadId, [
      new HumanMessage({
        content: "voltei, quero marcar",
        additional_kwargs: conversationStamp(conversationId),
      }),
    ]);

    const retry = await runCompaction(
      tenantId,
      payload(contactInboxId, conversationId, "resolved"),
      appDb,
      { checkpointer: saver, makeModel: () => model },
    );

    expect(retry.outcome).toBe("done");
    // Still ONE row, and the turns it describes are gone from the thread — replaced by the head, with
    // the turns since the reopen left raw.
    expect(
      await suDb.attendanceSummary.count({
        where: { tenantId, contactInboxId },
      }),
    ).toBe(1);
    expect(model.calls).toBe(1);
    const after = await readThread(saver, threadId);
    expect(after[0]).toStartWith(MEMORY_HEAD_OPEN);
    expect(after).toEqual([after[0] as string, "voltei, quero marcar"]);
  });

  // The thread marker is advanced by whoever claims a boundary, and a claim can be SKIPPED when an
  // invoke from the previous conversation is still reading the thread. The turns of the new
  // conversation are in the thread anyway, so the marker names a conversation the thread has already
  // left. Asked of the marker, "is this attendance the current one" answers no, and a resolve on the
  // conversation that is plainly the current one compacts nothing.
  test("a stale thread marker does not stop a resolved attendance from compacting", async () => {
    const contactInboxId = 5025;
    const conversationId = 724;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const saver = new MemorySaver();
    await seedThread(saver, threadId, [
      new HumanMessage({
        content: "queria trocar o horário de quinta",
        additional_kwargs: conversationStamp(conversationId),
      }),
      new AIMessage("Movi para sexta às 10h."),
    ]);
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${conversationId}`,
        lastEventAt: new Date(),
      },
    });
    // The marker still names the PREVIOUS conversation: its boundary claim was skipped.
    await suDb.agentThread.update({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      data: {
        lastConversationId: conversationId - 1,
      },
    });

    const result = await runCompaction(
      tenantId,
      payload(contactInboxId, conversationId, "resolved"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () => new SummarizerModel("Horário movido para sexta 10h."),
      },
    );

    expect(result.outcome).toBe("done");
    expect(
      await suDb.attendanceSummary.count({
        where: { tenantId, contactInboxId },
      }),
    ).toBe(1);
    const after = await readThread(saver, threadId);
    expect(after).toHaveLength(1);
    expect(after[0]).toStartWith(MEMORY_HEAD_OPEN);
  });

  // The job's dedupe key is the THREAD, so a later attendance re-arms the same row: a retry can
  // arrive with a wider prefix than the attempt that already committed a summary for part of it.
  // Summarizing the wider prefix pays the model to describe those turns a second time and renders
  // both rows, overlapping, into the head.
  test("a wider retry applies the summary already owed instead of writing a second one", async () => {
    const contactInboxId = 5026;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    let armed = false;
    const saver = new HookedSaver(1, async () => {
      if (armed) markTurnInFlight(threadId);
    });
    await seedThread(saver, threadId, twoAttendances());
    saver.calls = 0;
    armed = true;
    const model = new SummarizerModel("Avaliação marcada, R$ 250.");

    // First attempt: row committed, rewrite deferred by a turn.
    try {
      const first = await runCompaction(
        tenantId,
        payload(contactInboxId, 708, "new_attendance"),
        appDb,
        { checkpointer: saver, makeModel: () => model },
      );
      expect(first.outcome).toBe("reschedule");
    } finally {
      clearTurnInFlight(threadId);
    }
    armed = false;
    const owed = await suDb.attendanceSummary.findMany({
      where: { tenantId, contactInboxId },
    });
    expect(owed).toHaveLength(1);

    // A THIRD attendance opens before the retry runs, so the re-armed job carries a wider prefix.
    await seedThread(saver, threadId, [
      conversationDividerMessage(710, "oi, de novo"),
    ]);
    const retry = await runCompaction(
      tenantId,
      payload(contactInboxId, 709, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => model },
    );

    // Rescheduled, not done: the owed prefix is only the part already paid for, and the turns the
    // wider cut reaches past it are still raw. Nothing else is coming back for them — this job's row
    // is being retired and its triggers have already fired.
    expect(retry.outcome).toBe("reschedule");
    // The trail names the attendance that was actually folded, not the one this job was armed for.
    // Those differ exactly on a retry, which is when an operator most needs the line to be right.
    await waitForFlowLines(threadId, 1);
    const trail = await suDb.executionLog.findFirst({
      where: { tenantId, stage: "memory", threadId },
    });
    expect(JSON.stringify(trail?.detail ?? {})).toContain(
      '"attendanceConversationId":708',
    );
    // No second generation, no second row: the owed prefix is what got folded.
    expect(model.calls).toBe(1);
    const rows = await suDb.attendanceSummary.findMany({
      where: { tenantId, contactInboxId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastMessageId).toBe(owed[0]?.lastMessageId as string);
    const after = await readThread(saver, threadId);
    expect(after[0]).toStartWith(MEMORY_HEAD_OPEN);
    // Everything the owed row did NOT cover is still raw, waiting for the next pass.
    expect(after.some((c) => c.includes("oi, voltei"))).toBe(true);
    expect(after.some((c) => c.includes("oi, de novo"))).toBe(true);

    // And that pass finishes the job: the rest is summarized under its OWN attendance.
    const third = await runCompaction(
      tenantId,
      payload(contactInboxId, 709, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => model },
    );
    expect(third.outcome).toBe("done");
    expect(model.calls).toBe(2);
    const finalRows = await suDb.attendanceSummary.findMany({
      where: { tenantId, contactInboxId },
      orderBy: { id: "asc" },
    });
    expect(finalRows.map((r) => r.conversationId)).toEqual([708, 709]);
    const settled = await readThread(saver, threadId);
    expect(settled[0]).toStartWith(MEMORY_HEAD_OPEN);
    expect(settled.some((c) => c.includes("oi, voltei"))).toBe(false);
  });

  // Registration in TENANT_SCOPED_MODELS is what makes the tenancy extension inject the tenant on a
  // scoped write and override a spoofed one. The production upsert happens to pass tenantId itself,
  // so nothing about today's behavior would notice the model missing from that set — which is exactly
  // how a table opts out of the repo's defense-in-depth without anyone seeing it.
  test("a scoped write fills in the tenant even when the caller does not", async () => {
    const contactInboxId = 5027;
    await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        (
          db.attendanceSummary as unknown as {
            create: (a: { data: Record<string, unknown> }) => Promise<unknown>;
          }
        ).create({
          data: {
            chatwootInstanceId: instanceId,
            contactInboxId,
            conversationId: 730,
            lastMessageId: "scoped-1",
            summary: "sem tenant no payload",
            messageCount: 1,
            attendanceAt: new Date(),
          },
        }),
    );
    const row = await suDb.attendanceSummary.findFirstOrThrow({
      where: { contactInboxId, chatwootInstanceId: instanceId },
    });
    expect(row.tenantId).toBe(tenantId);
  });

  // loadAgentConfig resolves the agent's A/B variant, and resolving one WRITES an assignment keyed by
  // the thread it is handed. Keyed by contact-inbox it would be an assignment no conversion can ever
  // match, counted in the denominator of every result for that agent — rates drifting down by one row
  // per contact, with nothing in the numbers to say why.
  test("compacting does not invent an experiment assignment", async () => {
    const contactInboxId = 5028;
    const conversationId = 731;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const exp = await suDb.experiment.create({
      data: {
        tenantId,
        agentId,
        name: "tom",
        enabled: true,
        variants: [
          { key: "a", systemPrompt: "A" },
          { key: "b", systemPrompt: "B" },
        ],
      },
      select: { id: true },
    });
    const saver = new MemorySaver();
    await seedThread(saver, threadId, twoAttendances());

    await runCompaction(
      tenantId,
      payload(contactInboxId, conversationId, "new_attendance"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () => new SummarizerModel("resumo"),
      },
    );

    const assignments = await suDb.promptVariantAssignment.findMany({
      where: { tenantId, experimentId: exp.id },
      select: { threadId: true },
    });
    // Whatever it assigned, it is NOT keyed by the contact-inbox thread: that key belongs to no
    // conversation, so no conversion could ever be matched to it.
    expect(assignments.map((a) => a.threadId)).not.toContain(threadId);
  });

  // Resolving a variant is not a read: it INSERTS the assignment when the thread has none. Keying it
  // by the conversation only makes the row look real — an attendance a human handled, or one that
  // predates the experiment, still gets a phantom participant that no conversion can match.
  test("compacting an attendance with no assignment does not invent one", async () => {
    const contactInboxId = 5029;
    const conversationId = 732;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const exp = await suDb.experiment.create({
      data: {
        tenantId,
        agentId,
        name: "tom-2",
        enabled: true,
        variants: [
          { key: "a", systemPrompt: "A" },
          { key: "b", systemPrompt: "B" },
        ],
      },
      select: { id: true },
    });
    const saver = new MemorySaver();
    await seedThread(saver, threadId, twoAttendances());

    await runCompaction(
      tenantId,
      payload(contactInboxId, conversationId, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => new SummarizerModel("resumo") },
    );

    // Not "not keyed by the contact-inbox thread" — NONE. Compaction takes no part in the experiment.
    expect(
      await suDb.promptVariantAssignment.count({
        where: { tenantId, experimentId: exp.id },
      }),
    ).toBe(0);
  });

  test("a resolved attendance compacts the whole thread down to its memory", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5005;
    const conversationId = 704;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, [
      new HumanMessage(`bom dia, ${SEEDED_TEXT}`),
      new AIMessage("Bom dia! Agendado para 18/08."),
    ]);
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${conversationId}`,
        lastEventAt: new Date(),
      },
    });

    await runCompaction(
      tenantId,
      payload(contactInboxId, conversationId, "resolved"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () => new SummarizerModel("Agendado 18/08."),
      },
    );

    const after = await readThread(saver, threadId);
    expect(after.length).toBe(1);
    expect(after[0]).toStartWith(MEMORY_HEAD_OPEN);
    expect(after[0]).toContain("Agendado 18/08.");
  });

  // The grace window on a resolve is long enough for the contact to come back and open a NEW
  // attendance. The resolved conversation stays resolved, so the status check still passes, and
  // treating the whole thread as closed would summarize the conversation the agent is in the middle
  // of — the memory would then describe a conversation that is still happening.
  test("a resolve whose thread already moved on cuts at the divider instead", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5011;
    const conversationId = 710;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${conversationId}`,
        lastEventAt: new Date(),
      },
    });
    // The thread has already moved on to a newer conversation.
    await suDb.agentThread.update({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      data: {
        lastConversationId: conversationId + 1,
      },
    });

    await runCompaction(
      tenantId,
      payload(contactInboxId, conversationId, "resolved"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () => new SummarizerModel("resumo"),
      },
    );

    const after = await readThread(saver, threadId);
    // The open attendance survived: head + its divider + its reply, not a lone head.
    expect(after.length).toBe(3);
    expect(after[1]).toStartWith(CONVERSATION_DIVIDER);
    expect(after[2]).toBe("Oi! Como posso ajudar?");
  });

  test("a retry reuses the stored summary instead of generating a second one", async () => {
    const contactInboxId = 5012;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);

    // ONE thread across both attempts, which is what a retry actually is. The row is committed before
    // the rewrite, so a checkpointer that fails right after it leaves exactly the state the scheduler
    // comes back to — and the message ids the reuse is keyed on are the same ones.
    let failNextWrite = false;
    class FlakyWriteSaver extends MemorySaver {
      // biome-ignore lint/suspicious/noExplicitAny: mirrors the saver's own loose typing
      override async put(...args: any[]): Promise<any> {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("checkpointer write failed");
        }
        // biome-ignore lint/suspicious/noExplicitAny: forwarding the saver's own signature
        return (super.put as any)(...args);
      }
    }
    const saver = new FlakyWriteSaver();
    await seedThread(saver, threadId, twoAttendances());

    const first = new SummarizerModel("resumo do atendimento");
    failNextWrite = true;
    await expect(
      runCompaction(
        tenantId,
        payload(contactInboxId, 711, "new_attendance"),
        appDb,
        { checkpointer: saver, makeModel: () => first },
      ),
    ).rejects.toThrow();
    expect(first.calls).toBe(1);
    expect(
      await suDb.attendanceSummary.count({
        where: { tenantId, contactInboxId },
      }),
    ).toBe(1);

    // The retry finds the same cut, the same last message id and the stored row: no second bill.
    const second = new SummarizerModel("NUNCA CHAMADO");
    const res = await runCompaction(
      tenantId,
      payload(contactInboxId, 711, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => second },
    );
    expect(res).toEqual({ outcome: "done" });
    expect(second.calls).toBe(0);
    expect((await readThread(saver, threadId))[0]).toContain(
      "resumo do atendimento",
    );
  });

  // A billed generation that nobody is waiting on is exactly how model spend goes missing from the
  // cost report: no customer notices, no latency shows up, and with compaction on by default this
  // runs once per closed attendance across every agent.
  test("the summary generation is billed to the tenant like any other", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5013;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());

    await runCompaction(
      tenantId,
      payload(contactInboxId, 712, "new_attendance"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () => new UsageReportingModel(["resumo"]),
      },
    );

    // UsageCapture persists fire-and-forget, like the flow lines.
    let usage = null;
    for (let i = 0; i < 40 && !usage; i++) {
      usage = await suDb.llmUsage.findFirst({
        where: { tenantId, threadId, node: "memory_compact" },
      });
      if (!usage) await new Promise((r) => setTimeout(r, 25));
    }
    expect(usage).not.toBeNull();
    expect(usage?.promptTokens).toBeGreaterThan(0);
    expect(usage?.completionTokens).toBeGreaterThan(0);
  });

  // The job is armed for the attendance that closed, but a claimed job can find the thread already
  // past it: more boundaries pass while it waits, and the cut it makes covers them too. The row and
  // the flow line already say which SEGMENT this summary is of; the usage row and the trace said the
  // conversation the payload happened to name, putting this spend on an attendance nothing here
  // summarized.
  test("the summary is billed to the segment it actually cut", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5019;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    // Armed for 730; by the time it runs the thread also closed 731 and opened 732.
    const armedFor = 730;
    const segmentIs = 731;
    const openNow = 732;
    const segmentRow = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: segmentIs,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${segmentIs}`,
        lastEventAt: new Date("2026-03-04T10:00:00Z"),
      },
      select: { id: true },
    });
    await seedThread(saver, threadId, [
      new HumanMessage({
        content: `quanto custa? ${SEEDED_TEXT}`,
        additional_kwargs: conversationStamp(armedFor),
      }),
      new AIMessage("R$ 250."),
      new HumanMessage({
        content: "e o horário de sábado?",
        additional_kwargs: conversationStamp(segmentIs),
      }),
      new AIMessage("Temos 09h."),
      conversationDividerMessage(openNow, "oi, voltei"),
      new AIMessage("Oi! Como posso ajudar?"),
    ]);

    await runCompaction(
      tenantId,
      payload(contactInboxId, armedFor, "new_attendance"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () => new UsageReportingModel(["resumo"]),
      },
    );

    let usage = null;
    for (let i = 0; i < 40 && !usage; i++) {
      usage = await suDb.llmUsage.findFirst({
        where: { tenantId, threadId, node: "memory_compact" },
      });
      if (!usage) await new Promise((r) => setTimeout(r, 25));
    }
    expect(usage).not.toBeNull();
    expect(usage?.conversationId).toBe(segmentRow.id);
    // And the summary row it was billed for is the same segment.
    const row = await suDb.attendanceSummary.findFirst({
      where: { tenantId, contactInboxId },
      select: { conversationId: true },
    });
    expect(row?.conversationId).toBe(segmentIs);
  });

  // The override exists to say "not the payload's conversation", and NULL is one of its answers: the
  // segment can belong to a conversation whose mirrored row is gone (an owed backlog, a conversation
  // deleted since). Coalescing that back to the config's own conversation charges the generation to
  // an unrelated attendance — louder than the misattribution the override was added to fix.
  test("a segment whose conversation row is gone is billed to nobody, not to the payload", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5021;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const armedFor = 740;
    const segmentIs = 741; // deliberately NOT mirrored
    const openNow = 742;
    // The PAYLOAD's conversation is mirrored, so the config carries a real conversation id — which is
    // exactly what a coalescing override would fall back to.
    const payloadRow = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: armedFor,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${armedFor}`,
        lastEventAt: new Date("2026-03-05T10:00:00Z"),
      },
      select: { id: true },
    });
    expect(payloadRow.id).toBeDefined();
    await seedThread(saver, threadId, [
      new HumanMessage({
        content: `quanto custa? ${SEEDED_TEXT}`,
        additional_kwargs: conversationStamp(armedFor),
      }),
      new AIMessage("R$ 250."),
      new HumanMessage({
        content: "e o horário de sábado?",
        additional_kwargs: conversationStamp(segmentIs),
      }),
      new AIMessage("Temos 09h."),
      conversationDividerMessage(openNow, "oi, voltei"),
      new AIMessage("Oi! Como posso ajudar?"),
    ]);

    await runCompaction(
      tenantId,
      payload(contactInboxId, armedFor, "new_attendance"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () => new UsageReportingModel(["resumo"]),
      },
    );

    let usage = null;
    for (let i = 0; i < 40 && !usage; i++) {
      usage = await suDb.llmUsage.findFirst({
        where: { tenantId, threadId, node: "memory_compact" },
      });
      if (!usage) await new Promise((r) => setTimeout(r, 25));
    }
    expect(usage).not.toBeNull();
    expect(usage?.conversationId).toBeNull();
  });

  // cancelPendingJob only reaches a job still PENDING, so a compaction already claimed — provider
  // call in flight — outlives the /reset that ran a second ago. Writing its row anyway would restore
  // memory the operator explicitly deleted, with nothing to say where it came from.
  test("a reset that lands mid-compaction stops the summary from being written", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5014;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());
    await suDb.agentThread.update({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      data: {
        lastConversationId: 713,
      },
    });

    const before = await readThread(saver, threadId);
    const res = await runCompaction(
      tenantId,
      payload(contactInboxId, 713, "new_attendance"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () =>
          // /reset deletes the AgentThread row; the id this job started with is the generation token.
          new SummarizerModel("resumo", async () => {
            await suDb.agentThread.deleteMany({
              where: {
                tenantId,
                chatwootInstanceId: instanceId,
                contactInboxId,
              },
            });
          }),
      },
    );

    expect(res).toEqual({ outcome: "done" });
    expect(
      await suDb.attendanceSummary.count({
        where: { tenantId, contactInboxId },
      }),
    ).toBe(0);
    expect(await readThread(saver, threadId)).toEqual(before);
  });

  // The same fence, on a thread that has no AgentThread row to use as its generation token. That
  // state is reachable: /reset deletes the row and the checkpoint under the lock, but an invoke that
  // started earlier saves the channel it had loaded AFTER the delete — restoring the stamped
  // messages while the row stays gone — and a nudge can populate a checkpoint without ever creating
  // a row. A fence that only runs when the row was present reads "no row" as "nothing was reset" and
  // writes the summary anyway, rendering back the memory the operator cleared.
  test("a thread with no AgentThread row is fenced too, not waved through", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5040;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    // No agentThread row on purpose: this is the residue a reset leaves behind.
    await seedThread(saver, threadId, twoAttendances(), {
      withThreadRow: false,
    });

    const before = await readThread(saver, threadId);
    const res = await runCompaction(
      tenantId,
      payload(contactInboxId, 709, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => new SummarizerModel("resumo") },
    );

    expect(res).toEqual({ outcome: "done" });
    expect(
      await suDb.attendanceSummary.count({
        where: { tenantId, contactInboxId },
      }),
    ).toBe(0);
    expect(await readThread(saver, threadId)).toEqual(before);
  });

  // A resolved conversation can be reopened by the customer and resolved again — ordinary Chatwoot,
  // and with compaction on by default it happens after the first pass already compacted it. The
  // second cut carries only the new turns, so a row keyed on the conversation alone would either
  // replace the first summary with a description of the tail or reuse the first for turns it never
  // saw. Both delete the new turns and lose half the attendance.
  test("a reopened attendance keeps the memory of its first half", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5015;
    const conversationId = 714;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${conversationId}`,
        lastEventAt: new Date(),
      },
    });
    await seedThread(saver, threadId, [
      new HumanMessage("quero marcar, quanto custa?"),
      new AIMessage("R$ 250, terça 08:30."),
    ]);
    const args = (m: SummarizerModel) =>
      [
        tenantId,
        payload(contactInboxId, conversationId, "resolved"),
        appDb,
        { checkpointer: saver, makeModel: () => m },
      ] as const;

    await runCompaction(...args(new SummarizerModel("Combinou R$ 250 terça.")));
    expect((await readThread(saver, threadId)).length).toBe(1);

    // Reopened: two more turns land on the SAME conversation, then it is resolved again.
    await seedThread(saver, threadId, [
      new HumanMessage("na verdade preciso mudar para quinta"),
      new AIMessage("Remarquei para quinta 10:00."),
    ]);
    await runCompaction(...args(new SummarizerModel("Remarcou para quinta.")));

    const rows = await suDb.attendanceSummary.findMany({
      where: { tenantId, contactInboxId },
      orderBy: { id: "asc" },
    });
    expect(rows.length).toBe(2);
    const head = (await readThread(saver, threadId))[0] ?? "";
    // Both halves are still in the memory the model will read.
    expect(head).toContain("Combinou R$ 250 terça.");
    expect(head).toContain("Remarcou para quinta.");
  });

  // The head renders the newest MEMORY_HEAD_MAX_ATTENDANCES rows, so the query asks for exactly
  // those. It used to load every row this contact ever had and sort them all, on every compaction,
  // to keep the last twenty — and the rows are kept forever by design. What this pins is the part a
  // limit can silently get wrong: WHICH twenty, and in which order.
  test("the head carries the newest attendances, oldest-first", async () => {
    const contactInboxId = 7180;
    const conversationId = 7181;
    const saver = new MemorySaver();
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${conversationId}`,
        lastEventAt: new Date(),
      },
    });
    // Two more than the head can hold, each an hour apart so the ordering is unambiguous.
    const total = MEMORY_HEAD_MAX_ATTENDANCES + 2;
    const base = Date.parse("2026-01-01T12:00:00Z");
    for (let i = 0; i < total; i++) {
      await suDb.attendanceSummary.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
          conversationId: 6000 + i,
          lastMessageId: `seed-${i}`,
          summary: `atendimento numero ${i}`,
          messageCount: 2,
          attendanceAt: new Date(base + i * 3_600_000),
        },
      });
    }
    await seedThread(saver, threadId, [
      new HumanMessage("voltei"),
      new AIMessage("Oi! Como posso ajudar?"),
    ]);

    await runCompaction(
      tenantId,
      payload(contactInboxId, conversationId, "resolved"),
      appDb,
      { checkpointer: saver, makeModel: () => new SummarizerModel("Voltou.") },
    );

    const head = (await readThread(saver, threadId))[0] ?? "";
    // The two oldest fell off the front, which is the same order a person forgets in.
    expect(head).not.toContain("atendimento numero 0\n");
    expect(head).not.toContain("atendimento numero 1\n");
    expect(head).toContain(`atendimento numero ${total - 1}`);
    // Oldest-first among the ones kept: the head reads as a history, not a stack.
    expect(head.indexOf("atendimento numero 2")).toBeLessThan(
      head.indexOf(`atendimento numero ${total - 1}`),
    );
  });

  // The boundary trigger fires only when the contact comes back, which can be months later. Dating a
  // memory by the job that wrote it tells the model a returning customer's whole history happened
  // today, and a model that believes that will answer as if it did.
  // Dated by the attendance the SEGMENT is about, which is not always the one the job was armed for:
  // a claimed job cannot be called back, so a new attendance can re-arm the row while the handler is
  // still running and the cut it takes reaches past the payload's conversation. Dating from the
  // payload would file a months-old conversation under the date of a different one.
  test("the memory is dated by the attendance, not by the job that summarized it", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5016;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const longAgo = new Date(Date.UTC(2026, 1, 3, 15, 0, 0));
    // 708 is the attendance the closed turns belong to; 715 is what this job was armed for.
    for (const [chatwootConversationId, lastEventAt] of [
      [708, longAgo],
      [715, new Date()],
    ] as const) {
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId,
          status: "resolved",
          threadId: `${tenantId}:${instanceId}:${chatwootConversationId}`,
          lastEventAt,
        },
      });
    }
    await seedThread(saver, threadId, twoAttendances());

    await runCompaction(
      tenantId,
      payload(contactInboxId, 715, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => new SummarizerModel("resumo") },
    );

    const row = await suDb.attendanceSummary.findFirst({
      where: { tenantId, contactInboxId },
    });
    expect(row?.attendanceAt?.toISOString()).toBe(longAgo.toISOString());
    expect((await readThread(saver, threadId))[0]).toContain(
      '<atendimento data="2026-02-03">',
    );
  });

  // The other half of the same rule: with the mirrored conversation gone there is nothing to read the
  // date OFF, and `now()` is not a neutral fallback — it is exactly the lie the test above forbids,
  // asserted at the one moment the code cannot check itself against a seeded date.
  test("an attendance whose mirror row is gone is stored undated, not dated today", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5041;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    // 7152 exists (the job was armed for it); 7082, which the closed turns are stamped with, does not.
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: 7152,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:7152`,
        lastEventAt: new Date(),
      },
    });
    await seedThread(saver, threadId, twoAttendances(7082, 7092));

    await runCompaction(
      tenantId,
      payload(contactInboxId, 7152, "new_attendance"),
      appDb,
      { checkpointer: saver, makeModel: () => new SummarizerModel("resumo") },
    );

    const row = await suDb.attendanceSummary.findFirst({
      where: { tenantId, contactInboxId },
    });
    expect(row).not.toBeNull();
    expect(row?.attendanceAt).toBeNull();
    const head = (await readThread(saver, threadId))[0] ?? "";
    expect(head).toContain("<atendimento>");
    expect(head).not.toContain("data=");
  });

  // An undated row must never displace a dated one out of the window the head renders. Postgres puts
  // NULLs FIRST on a descending sort by default, so the row we could not date would otherwise be
  // taken as the newest of all.
  test("an undated attendance sorts last, never ahead of a dated one", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5042;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const conversationId = 6501;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${conversationId}`,
        lastEventAt: new Date(),
      },
    });
    const total = MEMORY_HEAD_MAX_ATTENDANCES;
    const base = Date.parse("2026-01-01T12:00:00Z");
    // One undated row plus a full window of dated ones: the undated one is what has to fall off.
    await suDb.attendanceSummary.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId,
        conversationId: 6400,
        lastMessageId: "seed-undated",
        summary: "atendimento sem data",
        messageCount: 2,
        attendanceAt: null,
      },
    });
    for (let i = 0; i < total; i++) {
      await suDb.attendanceSummary.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
          conversationId: 6410 + i,
          lastMessageId: `seed-dated-${i}`,
          summary: `atendimento datado ${i}`,
          messageCount: 2,
          attendanceAt: new Date(base + i * 3_600_000),
        },
      });
    }
    await seedThread(saver, threadId, [
      new HumanMessage("voltei"),
      new AIMessage("Oi! Como posso ajudar?"),
    ]);

    await runCompaction(
      tenantId,
      payload(contactInboxId, conversationId, "resolved"),
      appDb,
      { checkpointer: saver, makeModel: () => new SummarizerModel("Voltou.") },
    );

    const head = (await readThread(saver, threadId))[0] ?? "";
    expect(head).not.toContain("atendimento sem data");
    expect(head).toContain(`atendimento datado ${total - 1}`);
  });

  test("the switch is honored at execution, not only at arming time", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5006;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    await seedThread(saver, threadId, twoAttendances());
    const model = new SummarizerModel("resumo");

    await setCompaction(false);
    try {
      const before = await readThread(saver, threadId);
      await runCompaction(
        tenantId,
        payload(contactInboxId, 705, "new_attendance"),
        appDb,
        { checkpointer: saver, makeModel: () => model },
      );
      expect(await readThread(saver, threadId)).toEqual(before);
      expect(model.calls).toBe(0);
    } finally {
      await setCompaction(true);
    }
  });

  // `detail` on ExecutionLog carries counts and ids, never message text. Compaction is the one stage
  // whose whole input is the customer's words, so the promise is worth asserting here.
  test("the turn trail records the compaction with counts only", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 5007;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    // The mirrored conversation the closed turns belong to, on its inbox: together they are what the
    // trail line points AT, and what the Logs page filters on.
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 4242,
        name: "Suporte",
        agentId,
      },
      select: { id: true },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: 760,
        inboxId: inbox.id,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:760`,
        lastEventAt: new Date(),
      },
    });
    await seedThread(saver, threadId, twoAttendances(760, 761));

    await runCompaction(
      tenantId,
      payload(contactInboxId, 760, "new_attendance"),
      appDb,
      {
        checkpointer: saver,
        makeModel: () => new SummarizerModel("resumo do atendimento"),
      },
    );

    await waitForFlowLines(threadId, 1);
    const row = await suDb.executionLog.findFirst({
      where: { tenantId, stage: "memory", threadId },
    });
    expect(row).not.toBeNull();
    expect(row?.level).toBe("info");
    // Findable from the conversation. The Logs page filters on the database ids, so a line without
    // them exists and is invisible to the operator who opens the trail from the conversation.
    expect(row?.conversationId).not.toBeNull();
    expect(row?.inboxId).not.toBeNull();
    const detail = JSON.stringify(row?.detail ?? {});
    expect(detail).toContain('"messagesCompacted":3');
    expect(detail).not.toContain(SEEDED_TEXT);
    expect(detail).not.toContain("resumo do atendimento");
  });
});
