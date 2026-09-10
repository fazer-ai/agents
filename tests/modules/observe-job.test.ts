import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import {
  clearMediaAnnotations,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  armObserve,
  observeDedupeKey,
  runObserve,
} from "@/modules/observe/job";
import { readMonitoringConfig } from "@/modules/observe/settings";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { UsageReportingModel } from "../utils/scripted-models";

// The OBSERVE job end to end (issue #477): a burst arms one row per conversation, the tick reads
// Chatwoot, asks the model once, writes the label set deterministically, posts one private note
// when a label moved, and writes one `observe` line — with no customer-facing call anywhere.

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

const INBOX_ID = 91;
const OUR_BOT = 29;
const CONV = 9101;
let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let convRowId = 0n;
let inboxRowId = 0n;

const MONITORING = {
  labelGroups: [
    {
      name: "assunto",
      exclusive: true,
      values: ["cancelamento", "compra-de-ingresso", "outros"],
    },
  ],
};

interface ClientLog {
  labelsWritten: string[][];
  notes: string[];
  publicSends: number;
}

function message(
  id: number,
  content: string,
  type: "incoming" | "outgoing" = "incoming",
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    content,
    message_type: type === "incoming" ? 0 : 1,
    private: false,
    attachments: [],
    ...extra,
  };
}

// A Chatwoot double: the messages and labels the job reads, and a record of what it writes. The
// customer-facing sends are counted so the invariant of the whole feature can be asserted on it.
function stubClient(
  messages: unknown[],
  labels: string[],
  log: ClientLog,
): ChatwootClient {
  return {
    getMessages: async () => ({ payload: messages }),
    getConversationLabels: async () => [...labels],
    setConversationLabels: async (_id: number, next: string[]) => {
      log.labelsWritten.push(next);
      labels.splice(0, labels.length, ...next);
      return {};
    },
    sendPrivateNote: async (_id: number, text: string) => {
      log.notes.push(text);
      return {};
    },
    sendMessage: async () => {
      log.publicSends++;
      return {};
    },
    toggleTyping: async () => {
      log.publicSends++;
      return {};
    },
  } as unknown as ChatwootClient;
}

// A model double that answers BOTH call shapes with usage metadata, so the usage row the job files
// under its own node can be asserted on: `withStructuredOutput` rides the same `invoke`, parsing
// the text the way an adapter would, and a text that is not JSON arrives with no parsed answer.
class VerdictModel extends UsageReportingModel {
  constructor(
    answer: unknown,
    private readonly counter: { n: number },
  ) {
    super([typeof answer === "string" ? answer : JSON.stringify(answer)]);
  }
  override async _generate(
    ...args: Parameters<UsageReportingModel["_generate"]>
  ): ReturnType<UsageReportingModel["_generate"]> {
    this.counter.n++;
    return super._generate(...args);
  }
  override withStructuredOutput(): never {
    return {
      invoke: async (
        messages: Parameters<UsageReportingModel["invoke"]>[0],
        options: Parameters<UsageReportingModel["invoke"]>[1],
      ) => {
        const raw = await this.invoke(messages, options);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(String(raw.content));
        } catch {
          parsed = null;
        }
        return { raw, parsed };
      },
    } as never;
  }
}

function verdictModel(answer: unknown, calls: { n: number }): BaseChatModel {
  return new VerdictModel(answer, calls);
}

// A WATCHER'S TURN IS ITS TOOL CALLS. The graph asks the model, runs whatever it called, asks again,
// and the second answer is prose nobody delivers — so a double that calls a tool on the first hop
// and answers on the second is what an observation turn looks like end to end.
class LabellingModel {
  calls = 0;
  constructor(
    private readonly labels: string[],
    // Runs after the model "answers" and before the tool node asks the fence, which is the window
    // every one of these fences exists for: the world moved while the model was generating.
    private readonly whileGenerating?: () => Promise<unknown>,
  ) {}
  async invoke(): Promise<AIMessage> {
    this.calls++;
    return new AIMessage("pronto");
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        self.calls++;
        n++;
        if (n === 1 && self.whileGenerating) await self.whileGenerating();
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "set_labels",
                  args: { labels: self.labels },
                  id: "call_labels",
                },
              ],
            })
          : new AIMessage("classifiquei a conversa.");
      },
    };
  }
}

// ...and one that decides nothing changed, which is what most ticks should look like.
class SilentModel {
  calls = 0;
  async invoke(): Promise<AIMessage> {
    this.calls++;
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    return {
      async invoke(): Promise<AIMessage> {
        self.calls++;
        return new AIMessage("nada mudou.");
      },
    };
  }
}

// ONE reader for this file, parameterised by stage: the tool logger writes `tool` lines and the
// tick writes `observe` ones, and a second `flowLogRows` call here would be a second reader for
// `flowlog-reader-scope.test.ts` to account for. Scoping stays in one place either way.
const stageLines = (stage: "observe" | "tool") =>
  flowLogRows(suDb, {
    where: { conversationId: convRowId, stage },
    orderBy: { id: "asc" },
    select: { status: true, level: true, detail: true, agentId: true },
  });
const observeLines = () => stageLines("observe");

describe.skipIf(!dbUp)("the OBSERVE job", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "OBS", slug: `obs-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 61,
      baseUrl: "https://chat.observe.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Observadora",
        systemPrompt: "Você acompanha o SAC de uma bilheteria.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "monitoring",
        settings: { monitoring: MONITORING },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: OUR_BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `obs-route-${process.pid}`,
        name: "Observadora",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
        name: "SAC",
      },
    });
    // The binding the tick asks about: a watcher only reaches a conversation because it is on the
    // inbox, and the job re-asks that at load and again before writing (issue #477 review, round 1).
    inboxRowId = inbox.id;
    await suDb.inboxObserver.create({
      data: { tenantId, inboxId: inbox.id, agentId },
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: CONV,
        inboxId: inbox.id,
        status: "open",
        threadId: chatwootThreadId(tenantId, instanceId, CONV),
      },
    });
    convRowId = conv.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const table of [
      "execution_logs",
      "llm_usage",
      "scheduler_jobs",
      "conversations",
      "inbox_observers",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "chatwoot_instances",
      "chatwoot_deployments",
      "tenants",
    ]) {
      await suDb
        .$executeRawUnsafe(
          table === "tenants"
            ? `DELETE FROM tenants WHERE id = ${tenantId}`
            : `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        )
        .catch(() => {});
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  const cfg = () => readMonitoringConfig({ monitoring: MONITORING });
  const detailOf = (
    lines: { detail: unknown }[],
    i: number,
  ): Record<string, unknown> => {
    const l = lines.at(i);
    if (!l) throw new Error(`no observe line at ${i}`);
    return l.detail as Record<string, unknown>;
  };
  const jobRow = () =>
    suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "OBSERVE",
        dedupeKey: observeDedupeKey(
          chatwootThreadId(tenantId, instanceId, CONV),
          agentId,
        ),
      },
      select: { id: true, status: true, runAt: true, payload: true },
    });
  const mustRow = async () => {
    const r = await jobRow();
    if (!r) throw new Error("no OBSERVE row");
    return r;
  };

  test("a burst arms one row per conversation, and a second message joins it inside the window", async () => {
    const t0 = new Date("2026-09-03T12:00:00Z");
    const first = await armObserve({
      tenantId,
      instanceId,
      conversationId: CONV,
      agentId,
      reason: "burst",
      cfg: cfg(),
      base: appDb,
      now: t0,
    });
    expect(first).toBe("armed");
    const a = await mustRow();
    expect(a.status).toBe("PENDING");
    expect(a.runAt.getTime()).toBe(t0.getTime() + 20_000);

    const t1 = new Date(t0.getTime() + 15_000);
    await armObserve({
      tenantId,
      instanceId,
      conversationId: CONV,
      agentId,
      reason: "burst",
      cfg: cfg(),
      base: appDb,
      now: t1,
    });
    const b = await mustRow();
    expect(b.id).toBe(a.id);
    expect(b.runAt.getTime()).toBe(t1.getTime() + 20_000);
    expect((b.payload as { burstStartedAt: number }).burstStartedAt).toBe(
      t0.getTime(),
    );

    // The max window caps how far a chatty burst can push the verdict out.
    const t2 = new Date(t0.getTime() + 55_000);
    await armObserve({
      tenantId,
      instanceId,
      conversationId: CONV,
      agentId,
      reason: "burst",
      cfg: cfg(),
      base: appDb,
      now: t2,
    });
    expect((await mustRow()).runAt.getTime()).toBe(t0.getTime() + 60_000);

    // A resolve pulls the same row to now.
    const t3 = new Date(t0.getTime() + 58_000);
    await armObserve({
      tenantId,
      instanceId,
      conversationId: CONV,
      agentId,
      reason: "resolved",
      cfg: cfg(),
      base: appDb,
      now: t3,
    });
    const c = await mustRow();
    expect(c.runAt.getTime()).toBe(t3.getTime());
    expect((c.payload as { reason: string }).reason).toBe("resolved");
    expect(await suDb.schedulerJob.count({ where: { tenantId } })).toBe(1);
  });

  test("a conversation with nobody from the customer in view is skipped without a model call", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(7, "Bom dia!", "outgoing")], [], log),
        makeModel: () => verdictModel({ assunto: "outros" }, calls),
      },
    );
    expect(calls.n).toBe(0);
    expect(log.labelsWritten).toEqual([]);
    expect((await observeLines()).at(-1)?.status).toBe("skipped");
  });

  test("an agent that stopped observing between the arm and the tick writes nothing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    await suDb.agent.update({
      where: { id: agentId },
      data: { mode: "production" },
    });
    try {
      const res = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () => stubClient([message(8, "cancela")], [], log),
          makeModel: () => verdictModel({ assunto: "cancelamento" }, calls),
        },
      );
      expect(res).toEqual({ outcome: "done" });
      expect(calls.n).toBe(0);
      expect(log.labelsWritten).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "monitoring" },
      });
    }
  });

  // TWO CLASSIFIERS, TWO ROWS. An inbox can carry a monitoring responder and a different observer,
  // and both arm by design. One row per conversation made the second upsert overwrite the first's
  // agent, so which persona classified was decided by delivery order.
  test("two monitoring agents on one conversation arm one row each", async () => {
    const other = await suDb.agent.create({
      data: {
        tenantId,
        name: "Segunda",
        systemPrompt: "p",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "monitoring",
        settings: { monitoring: MONITORING },
      },
    });
    try {
      for (const id of [agentId, other.id])
        expect(
          await armObserve({
            tenantId,
            instanceId,
            conversationId: CONV + 7,
            agentId: id,
            reason: "burst",
            cfg: cfg(),
            base: appDb,
          }),
        ).toBe("armed");
      const rows = await suDb.schedulerJob.findMany({
        where: {
          tenantId,
          kind: "OBSERVE",
          dedupeKey: { contains: `:${CONV + 7}:` },
        },
        select: { dedupeKey: true, payload: true },
      });
      expect(rows).toHaveLength(2);
      expect(
        rows.map((r) => (r.payload as Record<string, unknown>).agentId).sort(),
      ).toEqual([String(agentId), String(other.id)].sort());
    } finally {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, dedupeKey: { contains: `:${CONV + 7}:` } },
      });
      await suDb.agent.delete({ where: { id: other.id } });
    }
  });

  // The OBSERVE row is not retired by a detach, and `agentObservesNow` asks about the AGENT. Without
  // the binding check a watcher taken off the inbox still spends a model call and moves its labels.
  test("an observer detached while the verdict was queued writes nothing", async () => {
    const row = await suDb.inboxObserver.findFirstOrThrow({
      where: { tenantId, agentId },
      select: { id: true, inboxId: true, agentId: true },
    });
    await suDb.inboxObserver.delete({ where: { id: row.id } });
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    try {
      expect(
        await runObserve(
          tenantId,
          {
            instanceId,
            conversationId: CONV,
            agentId,
            reason: "burst",
            atMessageId: null,
          },
          appDb,
          {
            makeClient: async () =>
              stubClient([message(1, "quero cancelar")], [], log),
            makeModel: () => verdictModel({ assunto: "cancelamento" }, calls),
          },
        ),
      ).toEqual({ outcome: "done" });
      expect(calls.n).toBe(0);
      expect(log.labelsWritten).toEqual([]);
    } finally {
      await suDb.inboxObserver.create({
        data: { tenantId, inboxId: row.inboxId, agentId: row.agentId },
      });
    }
  });

  // One unanchored page is Chatwoot's newest ~20 rows, so a window above that read one page and
  // called it the window. `before` walks older until the window is covered.
  test("a window wider than one page reads older pages", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    // Two pages of twenty, newest first, the way Chatwoot answers.
    const all = Array.from({ length: 40 }, (_, i) =>
      message(i + 1, `linha ${i + 1}`),
    );
    const asked: (number | undefined)[] = [];
    const client = stubClient([], ["compra-de-ingresso"], log);
    (client as { getMessages: unknown }).getMessages = async (
      _conv: number,
      opts?: { before?: number },
    ) => {
      asked.push(opts?.before);
      const upTo = opts?.before === undefined ? 41 : opts.before;
      return { payload: all.filter((m) => m.id < upTo).slice(-20) };
    };
    let prompt = "";
    (client as { getConversationLabels: unknown }).getConversationLabels =
      async () => ["compra-de-ingresso"];
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          monitoring: { ...MONITORING, window: { messages: 30 } },
        },
      },
    });
    try {
      await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () => client,
          makeModel: () => {
            const m = verdictModel(
              { assunto: "cancelamento", confidence: 0.5, reason: "r" },
              calls,
            );
            const inner = m.invoke.bind(m);
            (m as { invoke: unknown }).invoke = async (
              msgs: Parameters<typeof inner>[0],
              opts: Parameters<typeof inner>[1],
            ) => {
              prompt = JSON.stringify(msgs);
              return inner(msgs, opts);
            };
            return m;
          },
        },
      );
      // The first read is unanchored, the second is anchored on the oldest id the first returned.
      expect(asked).toEqual([undefined, 21]);
      // And the transcript actually reaches back past one page.
      expect(prompt).toContain("linha 11");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
    }
  });

  // THE GATE SITS NEXT TO THE BILLED CALL, and that placement is what the line says. Asked at the top
  // it answered for every exit before it, so a conversation with nothing from the customer read as a
  // tenant out of budget and the real reason never reached the flow page (issue #477 review, round 1).
  test("over the ceiling, an exit that was never going to spend says its own reason", async () => {
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyInboxUsd: 10 } },
      },
    });
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: { tenantId, source: "inbox", monthStart },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart,
        costUsd: 1000,
        polledAt: new Date(),
      },
      update: { costUsd: 1000, polledAt: new Date() },
    });
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    try {
      expect(
        await runObserve(
          tenantId,
          {
            instanceId,
            conversationId: CONV,
            agentId,
            reason: "burst",
            atMessageId: null,
          },
          appDb,
          {
            // Nobody from the customer in view: an exit that costs nothing.
            makeClient: async () =>
              stubClient(
                [message(1, "Olá! Como posso ajudar?", "outgoing")],
                [],
                log,
              ),
            makeModel: () => verdictModel({ assunto: "outros" }, calls),
          },
        ),
      ).toEqual({ outcome: "done" });
      expect(calls.n).toBe(0);
      const lines = await observeLines();
      expect(lines.length).toBe(before + 1);
      expect(detailOf(lines, -1).skipped).toBe("no_customer_message");
    } finally {
      await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
    }
  });

  // A burst queued while the agent was incremental must not outlive a flip to `on_resolve`: the row
  // is not retired by the edit, and the reload has to re-ask what the arm asked.
  test("a queued burst is dropped when the agent now classifies only on resolve", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: { monitoring: { ...MONITORING, analysis: "on_resolve" } },
      },
    });
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    try {
      expect(
        await runObserve(
          tenantId,
          {
            instanceId,
            conversationId: CONV,
            agentId,
            reason: "burst",
            atMessageId: null,
          },
          appDb,
          {
            makeClient: async () =>
              stubClient([message(1, "quero cancelar")], [], log),
            makeModel: () => verdictModel({ assunto: "cancelamento" }, calls),
          },
        ),
      ).toEqual({ outcome: "done" });
      expect(calls.n).toBe(0);
      expect(log.labelsWritten).toEqual([]);
      // ...and the resolve pass still runs, which is what the setting asks for.
      await suDb.conversation.update({
        where: { id: convRowId },
        data: { status: "resolved" },
      });
      expect(
        await runObserve(
          tenantId,
          {
            instanceId,
            conversationId: CONV,
            agentId,
            reason: "resolved",
            atMessageId: null,
          },
          appDb,
          {
            makeClient: async () =>
              stubClient([message(1, "quero cancelar")], [], log),
            makeModel: () =>
              verdictModel(
                { assunto: "cancelamento", confidence: 0.8, reason: "r" },
                calls,
              ),
          },
        ),
      ).toEqual({ outcome: "done" });
      expect(calls.n).toBe(1);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
      await suDb.conversation.update({
        where: { id: convRowId },
        data: { status: "open" },
      });
    }
  });

  // A PENDING RESOLVE IS NOT THE BURST THIS MESSAGE JOINS (issue #477 review, round 2). Read as one,
  // the new burst inherits the resolve's `burstStartedAt` — by then past the max window — and runs
  // immediately instead of waiting the window it was configured with.
  test("a customer who reopens after a pending resolve opens a new burst", async () => {
    const CONV_R = CONV + 11;
    const t0 = new Date("2026-09-04T10:00:00Z");
    expect(
      await armObserve({
        tenantId,
        instanceId,
        conversationId: CONV_R,
        agentId,
        reason: "burst",
        cfg: cfg(),
        base: appDb,
        now: t0,
      }),
    ).toBe("armed");
    // The conversation resolves: the same row is pulled to now.
    expect(
      await armObserve({
        tenantId,
        instanceId,
        conversationId: CONV_R,
        agentId,
        reason: "resolved",
        cfg: cfg(),
        base: appDb,
        now: new Date(t0.getTime() + 30_000),
      }),
    ).toBe("armed");
    // ...and the customer writes again before the worker claims it.
    const reopened = new Date(t0.getTime() + 120_000);
    expect(
      await armObserve({
        tenantId,
        instanceId,
        conversationId: CONV_R,
        agentId,
        reason: "burst",
        cfg: cfg(),
        base: appDb,
        now: reopened,
      }),
    ).toBe("armed");
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: {
        tenantId,
        kind: "OBSERVE",
        dedupeKey: observeDedupeKey(
          chatwootThreadId(tenantId, instanceId, CONV_R),
          agentId,
        ),
      },
      select: { runAt: true, payload: true },
    });
    const payload = row.payload as Record<string, unknown>;
    expect(payload.reason).toBe("burst");
    // Its own burst, not the resolve's: the window is measured from the reopening.
    expect(payload.burstStartedAt).toBe(reopened.getTime());
    expect(row.runAt.getTime()).toBe(
      reopened.getTime() + cfg().debounce.windowSeconds * 1000,
    );
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, dedupeKey: { contains: `:${CONV_R}:` } },
    });
  });

  // ONE VERDICT PER RESOLUTION. Chatwoot emits both accepted resolve events, and on an inbox with two
  // bindings each reaches its own route: four deliveries for one resolve. They fold while the row is
  // PENDING, and once the first verdict is CLAIMED the next upsert put it back to PENDING and bought
  // a second billed classification of the same resolution (issue #477 review, round 3).
  test("a resolve already armed for this version arms nothing again", async () => {
    const CONV_M = CONV + 21;
    const key = observeDedupeKey(
      chatwootThreadId(tenantId, instanceId, CONV_M),
      agentId,
    );
    const arm = (mark: number | null) =>
      armObserve({
        tenantId,
        instanceId,
        conversationId: CONV_M,
        agentId,
        reason: "resolved" as const,
        cfg: cfg(),
        base: appDb,
        mark,
      });
    try {
      expect(await arm(1700.5)).toBe("armed");
      // The second event type, and the observer's own route: same resolution, same version.
      expect(await arm(1700.5)).toBe("off");
      // ...and it is still off once the first verdict has been claimed and finished, which is the
      // case that used to buy a second model call.
      await suDb.schedulerJob.updateMany({
        where: { tenantId, kind: "OBSERVE", dedupeKey: key },
        data: { status: "DONE" },
      });
      expect(await arm(1700.5)).toBe("off");
      expect(
        (
          await suDb.schedulerJob.findFirstOrThrow({
            where: { tenantId, kind: "OBSERVE", dedupeKey: key },
            select: { status: true },
          })
        ).status,
      ).toBe("DONE");
      // A LATER resolution has a newer version and arms.
      expect(await arm(1800.25)).toBe("armed");
      // ...and an OLDER one does not (issue #477 review, round 22). Resolved, reopened, resolved
      // again, with a delivery of the FIRST resolution still in flight: compared for equality it
      // armed, overwrote the newer mark with the older, and bought the standing resolution a second
      // billed classification while superseding the verdict already in flight for it.
      expect(await arm(1700.5)).toBe("off");
      expect(
        (
          await suDb.schedulerJob.findFirstOrThrow({
            where: { tenantId, kind: "OBSERVE", dedupeKey: key },
            select: { payload: true },
          })
        ).payload,
      ).toMatchObject({ resolveMark: 1800.25 });
      // A payload with no version cannot be deduplicated, and arms rather than being dropped.
      expect(await arm(null)).toBe("armed");
    } finally {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, dedupeKey: key },
      });
    }
  });

  // A burst clears the mark, so the NEXT resolution arms even at the same version.
  test("a burst between two resolves clears the mark", async () => {
    const CONV_M = CONV + 22;
    const key = observeDedupeKey(
      chatwootThreadId(tenantId, instanceId, CONV_M),
      agentId,
    );
    try {
      expect(
        await armObserve({
          tenantId,
          instanceId,
          conversationId: CONV_M,
          agentId,
          reason: "resolved",
          cfg: cfg(),
          base: appDb,
          mark: 900,
        }),
      ).toBe("armed");
      expect(
        await armObserve({
          tenantId,
          instanceId,
          conversationId: CONV_M,
          agentId,
          reason: "burst",
          cfg: cfg(),
          base: appDb,
        }),
      ).toBe("armed");
      expect(
        await armObserve({
          tenantId,
          instanceId,
          conversationId: CONV_M,
          agentId,
          reason: "resolved",
          cfg: cfg(),
          base: appDb,
          mark: 900,
        }),
      ).toBe("armed");
    } finally {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, dedupeKey: key },
      });
    }
  });

  // An `on_resolve` agent arms nothing on a reopening message, so the row queued for the old
  // resolution is still there — and it would classify a live conversation as if it had ended.
  test("a resolve verdict on a conversation that reopened writes nothing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    expect(
      await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "resolved",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () =>
            stubClient([message(1, "quero cancelar")], [], log),
          makeModel: () =>
            verdictModel(
              { assunto: "cancelamento", confidence: 0.9, reason: "r" },
              calls,
            ),
        },
      ),
    ).toEqual({ outcome: "done" });
    expect(calls.n).toBe(0);
    expect(log.labelsWritten).toEqual([]);
    const lines = await observeLines();
    expect(lines.length).toBe(before + 1);
    expect(detailOf(lines, -1).skipped).toBe("conversation_reopened");
  });

  // A credential the vault cannot hand over is not an operator switching observation off, and the
  // one-shot resolve verdict must not be discarded for it (issue #477 review, round 8).
  test("a model configuration that cannot be built fails the tick", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        modelConfig: {
          provider: "openai",
          model: "gpt-5.4-mini",
          credentialRef: "missing-on-purpose",
        },
      },
    });
    // The job must not be MOOT, or completing is the right answer for a different reason (round 20).
    await suDb.conversation.update({
      where: { id: convRowId },
      data: { status: "resolved" },
    });
    try {
      const result = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "resolved",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () =>
            stubClient([message(1, "quero cancelar")], [], log),
          makeModel: () => verdictModel({ assunto: "cancelamento" }, calls),
        },
      );
      expect(result.outcome).toBe("fail");
      expect(calls.n).toBe(0);
      expect(log.labelsWritten).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { modelConfig: { provider: "openai", model: "gpt-5.4-mini" } },
      });
      await suDb.conversation.update({
        where: { id: convRowId },
        data: { status: "open" },
      });
    }
  });

  // `/reset` clears the labels and the memory, but Chatwoot keeps every message, and this module
  // reads Chatwoot. Without a boundary the next verdict reads the erased episode's demands, finds no
  // labels standing, and writes the old classification straight back (issue #477 review, round 9).
  test("the transcript starts after the reset boundary", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    let seen = "";
    await suDb.conversation.update({
      where: { id: convRowId },
      data: { resetAtMessageId: 600 },
    });
    try {
      await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: 601,
        },
        appDb,
        {
          makeClient: async () =>
            stubClient(
              [
                message(599, "quero cancelar meu ingresso"),
                message(601, "como faço pra chegar no evento?"),
              ],
              [],
              log,
            ),
          makeModel: () => {
            const m = verdictModel(
              { assunto: "outros", confidence: 0.9, reason: "r" },
              calls,
            );
            const inner = m.invoke.bind(m);
            (m as { invoke: unknown }).invoke = async (
              msgs: Parameters<typeof inner>[0],
              opts: Parameters<typeof inner>[1],
            ) => {
              seen = JSON.stringify(msgs);
              return inner(msgs, opts);
            };
            return m;
          },
        },
      );
      expect(calls.n).toBe(1);
      expect(seen).toContain("como faço pra chegar");
      expect(seen).not.toContain("quero cancelar meu ingresso");
    } finally {
      await suDb.conversation.update({
        where: { id: convRowId },
        data: { resetAtMessageId: null },
      });
    }
  });

  // Upstream Chatwoot 404s the attachment-meta write-back, so an eager transcription lives only in
  // the in-process store. Both other read paths overlay it; this one did not (round 9).
  test("a cached transcription reaches the observer's transcript", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    let seen = "";
    const MSG = 701;
    stashMediaAnnotation(
      { tenantId, instanceId, messageId: MSG },
      { transcribedText: "quero transferir o ingresso pro meu irmão" },
    );
    try {
      await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: MSG,
        },
        appDb,
        {
          makeClient: async () => {
            const row = message(MSG, "");
            (row as { attachments?: unknown }).attachments = [
              { id: 1, file_type: "audio", data_url: "https://x/a.ogg" },
            ];
            return stubClient([row], [], log);
          },
          makeModel: () => {
            const m = verdictModel(
              { assunto: "outros", confidence: 0.9, reason: "r" },
              calls,
            );
            const inner = m.invoke.bind(m);
            (m as { invoke: unknown }).invoke = async (
              msgs: Parameters<typeof inner>[0],
              opts: Parameters<typeof inner>[1],
            ) => {
              seen = JSON.stringify(msgs);
              return inner(msgs, opts);
            };
            return m;
          },
        },
      );
      expect(seen).toContain("transferir o ingresso");
    } finally {
      clearMediaAnnotations();
    }
  });

  // Chatwoot delivers out of order, and this id is what the reset fence orders against: a delayed
  // older delivery joining a burst must not push it backwards (issue #477 review, round 9).
  test("a burst keeps the newest message id, not the last one to arrive", async () => {
    const CONV_M = CONV + 31;
    const key = observeDedupeKey(
      chatwootThreadId(tenantId, instanceId, CONV_M),
      agentId,
    );
    const arm = (atMessageId: number) =>
      armObserve({
        tenantId,
        instanceId,
        conversationId: CONV_M,
        agentId,
        reason: "burst" as const,
        cfg: cfg(),
        base: appDb,
        atMessageId,
      });
    const idOf = async () =>
      (
        (
          await suDb.schedulerJob.findFirstOrThrow({
            where: { tenantId, kind: "OBSERVE", dedupeKey: key },
            select: { payload: true },
          })
        ).payload as { atMessageId?: number }
      ).atMessageId;
    try {
      expect(await arm(900)).toBe("armed");
      expect(await idOf()).toBe(900);
      // The delayed older delivery joins and must not win.
      expect(await arm(880)).toBe("armed");
      expect(await idOf()).toBe(900);
      // A genuinely newer one does.
      expect(await arm(910)).toBe("armed");
      expect(await idOf()).toBe(910);
    } finally {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, dedupeKey: key },
      });
    }
  });

  // Enough ROWS is not enough CONTEXT: a reply inside the window can quote something on an older
  // page, and a terse "sim" without its question is what the resolver exists for (round 11).
  test("paging continues for a quote the window points at", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    let seen = "";
    // Page 1 is the newest two; the quoted target only appears on page 2.
    const pages: Record<string, unknown[]> = {
      first: [
        message(802, "quer cancelar o ingresso?", "outgoing"),
        message(803, "sim", "incoming", {
          content_attributes: { in_reply_to: 801 },
        }),
      ],
      older: [message(801, "boa tarde"), message(800, "oi")],
    };
    await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: 803,
      },
      appDb,
      {
        makeClient: async () => {
          const c = stubClient([], [], log);
          (c as { getMessages: unknown }).getMessages = async (
            _id: number,
            opts?: { before?: number },
          ) => ({
            payload: opts?.before === undefined ? pages.first : pages.older,
          });
          return c;
        },
        makeModel: () => {
          const m = verdictModel(
            { assunto: "outros", confidence: 0.9, reason: "r" },
            calls,
          );
          const inner = m.invoke.bind(m);
          (m as { invoke: unknown }).invoke = async (
            msgs: Parameters<typeof inner>[0],
            opts: Parameters<typeof inner>[1],
          ) => {
            seen = JSON.stringify(msgs);
            return inner(msgs, opts);
          };
          return m;
        },
      },
    );
    expect(calls.n).toBe(1);
    // The quoted line is rendered with the reply that points at it.
    expect(seen).toContain("boa tarde");
  });

  // The row not having landed reads identical to a detach on the row alone, and completing was
  // PERMANENT for a resolve: the mark suppresses every later delivery (issue #477 review, r13).
  test("a tick armed in the attach window retries instead of completing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const rows = await suDb.inboxObserver.findMany({
      where: { tenantId, agentId },
      select: { id: true, inboxId: true },
    });
    await suDb.inboxObserver.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    try {
      // Without the flag the same state is a detach, and completing is right.
      expect(
        await runObserve(
          tenantId,
          {
            instanceId,
            conversationId: CONV,
            agentId,
            reason: "resolved",
            atMessageId: null,
          },
          appDb,
          {
            makeClient: async () =>
              stubClient([message(1, "quero cancelar")], [], log),
            makeModel: () => verdictModel({ assunto: "cancelamento" }, calls),
          },
        ),
      ).toEqual({ outcome: "done" });
      // With it, the tick is retried until the row is visible.
      const result = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "resolved",
          atMessageId: null,
          attaching: true,
        },
        appDb,
        {
          makeClient: async () =>
            stubClient([message(1, "quero cancelar")], [], log),
          makeModel: () => verdictModel({ assunto: "cancelamento" }, calls),
        },
      );
      expect(result.outcome).toBe("fail");
      expect(calls.n).toBe(0);
      expect(log.labelsWritten).toEqual([]);
    } finally {
      for (const r of rows)
        await suDb.inboxObserver.create({
          data: { tenantId, inboxId: r.inboxId, agentId },
        });
    }
  });

  // ...AND THE ROW SAYS IT ITSELF NOW (issue #540, window 5). `observeInbox` writes the row before
  // Chatwoot is asked and stamps it after, so an unstamped row IS the attach window — the tick no
  // longer needs the arm to have carried a flag, which is what a job armed before the flag existed
  // (or by a delivery that could not tell) had to rely on.
  test("a tick against a row Chatwoot has not confirmed retries, flag or no flag", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const rows = await suDb.inboxObserver.findMany({
      where: { tenantId, agentId },
      select: { id: true },
    });
    await suDb.inboxObserver.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { attachedAt: null },
    });
    try {
      const result = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "resolved",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () =>
            stubClient([message(1, "quero cancelar")], [], log),
          makeModel: () => verdictModel({ assunto: "cancelamento" }, calls),
        },
      );
      expect(result.outcome).toBe("fail");
      expect(calls.n).toBe(0);
      expect(log.labelsWritten).toEqual([]);
    } finally {
      await suDb.inboxObserver.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { attachedAt: new Date() },
      });
    }
  });

  // The verdict was computed against the set the prompt showed; a person who moved one of OUR groups
  // during the call is fresher information than a transcript that predates the move, and the
  // commonest verdict (repeat what you were shown) reverted it silently (issue #477 review, r14).
  test("a group moved during the model call is left to the next tick", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    // The prompt sees `compra-de-ingresso`; a person moves it to `cancelamento` mid-call.
    const labels = ["compra-de-ingresso", "vip"];
    const client = stubClient([message(1, "ok, obrigado")], labels, log);
    expect(
      await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () => client,
          makeModel: () => {
            const m = verdictModel(
              // No new demand: the model repeats what it was shown.
              {
                assunto: "compra-de-ingresso",
                confidence: 0.9,
                reason: "sem demanda nova",
              },
              calls,
            );
            const inner = m.invoke.bind(m);
            (m as { invoke: unknown }).invoke = async (
              msgs: Parameters<typeof inner>[0],
              opts: Parameters<typeof inner>[1],
            ) => {
              labels.splice(0, labels.length, "cancelamento", "vip");
              return inner(msgs, opts);
            };
            return m;
          },
        },
      ),
    ).toEqual({ outcome: "done" });
    expect(calls.n).toBe(1);
    // Nothing written: the person's `cancelamento` stands.
    expect(log.labelsWritten).toEqual([]);
    expect(log.notes).toEqual([]);
    expect(labels).toEqual(["cancelamento", "vip"]);
  });

  // A verdict is an answer to a DEFINITION — these values, accumulating or not. An additive group
  // flipped to exclusive during the call makes `applyVerdict` sweep out a value the model was told
  // could stand beside the one it chose (issue #477 review, round 18).
  test("a group whose definition changed during the call is left alone", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const additive = {
      monitoring: {
        labelGroups: [
          {
            name: "sinal",
            exclusive: false,
            values: ["vip", "urgente"],
          },
        ],
      },
    };
    await suDb.agent.update({
      where: { id: agentId },
      data: { settings: additive },
    });
    try {
      expect(
        await runObserve(
          tenantId,
          {
            instanceId,
            conversationId: CONV,
            agentId,
            reason: "burst",
            atMessageId: null,
          },
          appDb,
          {
            makeClient: async () =>
              stubClient(
                [message(1, "quero cancelar")],
                ["vip", "urgente"],
                log,
              ),
            makeModel: () => {
              const m = verdictModel(
                { sinal: "vip", confidence: 0.9, reason: "r" },
                calls,
              );
              const inner = m.invoke.bind(m);
              (m as { invoke: unknown }).invoke = async (
                msgs: Parameters<typeof inner>[0],
                opts: Parameters<typeof inner>[1],
              ) => {
                await suDb.agent.update({
                  where: { id: agentId },
                  data: {
                    settings: {
                      monitoring: {
                        labelGroups: [
                          {
                            name: "sinal",
                            exclusive: true,
                            values: ["vip", "urgente"],
                          },
                        ],
                      },
                    },
                  },
                });
                return inner(msgs, opts);
              };
              return m;
            },
          },
        ),
      ).toEqual({ outcome: "done" });
      expect(calls.n).toBe(1);
      // `urgente` would have been swept out under the new exclusive rule.
      expect(log.labelsWritten).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
    }
  });

  // BOTH PROVIDERS DOWN LEAVES ONE ALARM, NOT TWO (issue #567 review, round 1). The `observe` stage
  // emits its own error when the tick fails, and alert coalescing keys on (channel, stage, level):
  // a second `observe`/`error` line for the same failure bumps one delivery to "×2", or sends two if
  // it loses the coalesce window. The attribution line is `info` with `status: "error"` — it exists
  // only to say WHICH model died, because the stage is labelled with the primary by construction.
  // THE PER-TOOL LINE, which `buildCallbacks` does not carry. Without it a watcher whose tool fails
  // finishes the graph normally and the tick reports `ok` with `acted: true`: a tool error with no
  // line and no alert, and no second copy anywhere, since the observer's checkpoint is discarded.
  // A SCHEDULER JOB THAT FAILS IS RETRIED, and this tick is stateless on purpose — its own thread,
  // an in-memory checkpointer — so the retry re-runs the WHOLE turn from the top. Harmless while the
  // tick was a classifier with one deterministic write; with the ordinary toolset a booking, an
  // outbound POST or a charge can already have committed (review round 25).
  test("a failure AFTER a tool ran ends the tick instead of arming a retry", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    // Calls the tool on the first hop, then dies on the second — the shape of a provider blip, a
    // timeout, or the tick's own deadline landing between two rounds.
    class DiesAfterTheTool {
      calls = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("pronto");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(): Promise<AIMessage> {
            self.calls++;
            n++;
            if (n === 1)
              return new AIMessage({
                content: "",
                tool_calls: [
                  {
                    name: "set_labels",
                    args: { labels: ["cancelamento"] },
                    id: "call_labels",
                  },
                ],
              });
            throw new Error("provider 503");
          },
        };
      }
    }
    const model = new DiesAfterTheTool();
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () => model as unknown as BaseChatModel,
      },
    );
    // DONE, not fail: the label is written, and a retry would run the whole turn again — with
    // whatever else the model chose to call the first time.
    expect(res).toEqual({ outcome: "done" });
    expect(log.labelsWritten.length).toBeGreaterThan(0);
    // And it is not silent: the operator still learns the observation did not finish.
    const lines = await stageLines("observe");
    const stopped = lines.filter(
      (l) => (l.detail as { retried?: boolean } | null)?.retried === false,
    );
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped.at(-1)?.level).toBe("warn");
  });

  test("a failure BEFORE any tool ran still retries", async () => {
    // The control the case above needs: nothing committed, so the scheduler is still the right
    // answer — and this is the ordinary transient, which is most of them.
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    class DiesFirst {
      async invoke(): Promise<AIMessage> {
        return new AIMessage("pronto");
      }
      bindTools(_tools: unknown) {
        return {
          async invoke(): Promise<AIMessage> {
            throw new Error("provider 503");
          },
        };
      }
    }
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () => new DiesFirst() as unknown as BaseChatModel,
      },
    );
    expect(res.outcome).toBe("fail");
    expect(log.labelsWritten).toEqual([]);
  });

  test("a tool call writes its own flow line under the tick", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const model = new LabellingModel(["cancelamento"]);
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () => model as unknown as BaseChatModel,
      },
    );
    expect(res).toEqual({ outcome: "done" });
    const tools = await stageLines("tool");
    expect(
      tools.some(
        (t) => (t.detail as { tool?: string } | null)?.tool === "set_labels",
      ),
    ).toBe(true);
  });

  // A FALLBACK THAT CANNOT BE BUILT is indistinguishable from no fallback at all, and the primary
  // answering fine is exactly when nobody finds out. Reported at build time for that reason; the
  // verdict path used to and the graph build came up without the callback.
  test("a fallback that cannot be built is reported even when the primary answers", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          monitoring: MONITORING,
          // A provider with no credential in this tenant: buildFallbackModel has nothing to build.
          modelFallback: { provider: "anthropic", model: "claude-opus-5" },
        },
      },
    });
    const before = (await observeLines()).length;
    try {
      const res = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () =>
            stubClient([message(1, "quero cancelar")], [], log),
          makeModel: () => new SilentModel() as unknown as BaseChatModel,
        },
      );
      expect(res).toEqual({ outcome: "done" });
      const lines = (await observeLines()).slice(before);
      const warned = lines.find(
        (l) =>
          (l.detail as { fallbackUnavailable?: string } | null)
            ?.fallbackUnavailable !== undefined,
      );
      expect(warned).toBeDefined();
      expect(warned?.level).toBe("warn");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
    }
  });

  test("when the fallback fails too, the attribution line does not raise a second alarm", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          monitoring: MONITORING,
          modelFallback: { provider: "openai", model: "gpt-5.4" },
        },
      },
    });
    // Only THIS tick's lines: the rows accumulate on the conversation across the file.
    const before = (await observeLines()).length;
    try {
      const res = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () =>
            stubClient(
              [message(1, "quero cancelar, não vou conseguir ir")],
              ["agente-off"],
              log,
            ),
          makeModel: () => {
            const m = verdictModel({ assunto: "outros" }, calls);
            (m as { invoke: unknown }).invoke = async () => {
              const err = new Error("service unavailable") as Error & {
                status?: number;
              };
              err.status = 503;
              throw err;
            };
            return m;
          },
        },
      );
      expect(res.outcome).toBe("fail");
      const lines = (await observeLines()).slice(before);
      const errors = lines.filter((l) => l.level === "error");
      // ONE alerting line for one failed tick. The attribution rides at `info`.
      expect(errors.length).toBe(1);
      const attribution = lines.find(
        (l) =>
          l.level === "info" &&
          (l.detail as Record<string, unknown> | null)?.fallbackFailed !==
            undefined,
      );
      expect(attribution?.status).toBe("error");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
      await clearFlowLog(suDb, {
        tenantId,
        conversationId: convRowId,
        stage: "observe",
      });
    }
  });

  // ── the turn ───────────────────────────────────────────────────────────────
  //
  // A watcher runs the ordinary graph now (issue #568): the agent's own tools act on the
  // conversation, and the classifier that used to live in this module — one call, a JSON verdict, a
  // deterministic apply — is gone with the taxonomy it needed.

  test("the tick runs the agent's turn, and its tool call is what writes", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const labels = ["agente-off", "compra-de-ingresso"];
    const model = new LabellingModel(["agente-off", "cancelamento"]);
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient(
            [
              message(1, "oi, comprei ingresso para sábado"),
              message(2, "Olá! Como posso ajudar?", "outgoing"),
              message(3, "quero cancelar, não vou conseguir ir"),
            ],
            labels,
            log,
          ),
        makeModel: () => model as unknown as BaseChatModel,
      },
    );
    expect(res).toEqual({ outcome: "done" });
    expect(log.labelsWritten).toEqual([["agente-off", "cancelamento"]]);
    // NOTHING REACHES THE CUSTOMER, which is the one promise the mode makes. The final prose is the
    // model talking to a wall: the turn delivers no reply, and the client it holds would refuse one.
    expect(log.publicSends).toBe(0);
    const lines = await observeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.status).toBe("ok");
    expect(lines[0]?.agentId).toBe(agentId);
    const detail = detailOf(lines, 0);
    expect(detail.acted).toBe(true);
    expect(detail.toolCalls).toBe(1);
    expect(detail.reason).toBe("burst");
  });

  test("a turn that calls nothing writes nothing, and says so on the trail", async () => {
    await clearFlowLog(suDb, { tenantId });
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const model = new SilentModel();
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(1, "obrigado!")], ["cancelamento"], log),
        makeModel: () => model as unknown as BaseChatModel,
      },
    );
    expect(res).toEqual({ outcome: "done" });
    expect(log.labelsWritten).toEqual([]);
    expect(log.notes).toEqual([]);
    const detail = detailOf(await observeLines(), 0);
    expect(detail.acted).toBe(false);
    expect(detail.toolCalls).toBe(0);
  });

  test("the tick builds its client MUTED, with the persona's bot token", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    let built: { botToken?: string; mute?: boolean } | null = null;
    await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async (config) => {
          built = config as { botToken?: string; mute?: boolean };
          return stubClient([message(1, "oi")], [], log);
        },
        makeModel: () => new SilentModel() as unknown as BaseChatModel,
      },
    );
    // The bot token is the persona's, so the private notes and labels it writes are signed by the
    // watcher and not by a person; the mute is what makes the rest of the graph safe to run.
    expect(built).not.toBeNull();
    expect((built as unknown as { botToken: string }).botToken).toBe("BOT");
    expect((built as unknown as { mute: boolean }).mute).toBe(true);
  });

  // ── the fences ─────────────────────────────────────────────────────────────
  //
  // They used to be asked once, between the verdict and the single write. A turn has as many writes
  // as the model has tool calls, so they are asked at every tool HOP now — which is where a tool
  // that would write is stopped, rather than after it already has.

  test("an agent flipped to answering while the tick was reading acts on nothing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const model = new LabellingModel(["cancelamento"], () =>
      suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production" },
      }),
    );
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () => model as unknown as BaseChatModel,
      },
    );
    await suDb.agent.update({
      where: { id: agentId },
      data: { mode: "monitoring" },
    });
    expect(res).toEqual({ outcome: "done" });
    expect(log.labelsWritten).toEqual([]);
  });

  // A WITHDRAWAL COMPLETES THE TICK; A FENCE THAT COULD NOT BE READ RETRIES IT. The two answers are
  // kept apart everywhere else in this module for the same reason they have to end differently
  // here: nothing re-arms this row on its own, an `on_resolve` agent has no later burst and a
  // resolve happens once, so a transient database blip that completes the job is a conversation
  // that is never classified (issue #477 review, round 7).
  test("a fence that could not be read fails the tick instead of completing it", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    let generating = false;
    // The fence's own conversation read, and only once the model is answering: the same read at
    // LOAD time is a different question, and failing it there is not what this test is about.
    const unreadable = appDb.$extends({
      query: {
        conversation: {
          async findUnique({ args, query }) {
            const sel = args.select as Record<string, unknown> | undefined;
            if (generating && sel?.resetAtMessageId === true) {
              throw new Error("conversation row unreadable");
            }
            return query(args);
          },
        },
      },
    }) as unknown as typeof appDb;
    const model = new LabellingModel(["cancelamento"], async () => {
      generating = true;
    });
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      unreadable,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () => model as unknown as BaseChatModel,
      },
    );
    expect(res.outcome).toBe("fail");
    expect(log.labelsWritten).toEqual([]);
    const rows = await observeLines();
    expect(rows.at(-1)?.status).toBe("error");
    expect((rows.at(-1)?.detail as { failed?: string })?.failed).toBe(
      "conversation_unreadable",
    );
  });

  // A BINDING THAT HAS NOT LANDED IS NOT A DETACH, and the load-time check has said so since #540.
  // The tool fence folded it into a permanent detach, which COMPLETES the job — and for an
  // `on_resolve` watcher that is the classification lost for good, because the resolve mark
  // suppresses every later delivery of the same resolution.
  test("a binding still attaching at the fence retries instead of completing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const rows = await suDb.inboxObserver.findMany({
      where: { tenantId, agentId },
      select: { id: true },
    });
    // Unstamped only after the model call starts, so the LOAD-time check passes and the FENCE is
    // the one that sees the pending row — which is exactly the detach/reattach straddle. Driven as
    // a burst rather than a resolve so the fence's own reopened check (which legitimately completes
    // a resolve tick on an open conversation) cannot answer first; the binding question, and
    // whether its answer is retryable, is the same either way.
    const model = new LabellingModel(["cancelamento"], async () => {
      await suDb.inboxObserver.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { attachedAt: null },
      });
    });
    try {
      const res = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () =>
            stubClient([message(1, "quero cancelar")], [], log),
          makeModel: () => model as unknown as BaseChatModel,
        },
      );
      expect(res.outcome).toBe("fail");
      expect(log.labelsWritten).toEqual([]);
    } finally {
      await suDb.inboxObserver.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { attachedAt: new Date() },
      });
    }
  });

  // ONE READ FOR THE PROMPT AND FOR THE TOOL'S BASELINE. `set_labels` diffs the model's list against
  // what the model was SHOWN, so two reads are two claims about the same turn: a label the prompt
  // advertises but the baseline lacks comes back as an ADDITION when the model repeats it to keep
  // it, which puts back what somebody removed in between — the exact harm the diff exists to avoid.
  test("the labels in the prompt are the labels the tool compares against", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    let reads = 0;
    const base = stubClient([message(1, "quero cancelar")], [], log);
    // First read (the prompt's) sees `vip`; a second read would see it gone. With one read there is
    // no second, and the model repeating `vip` cannot resurrect it.
    const drifting = {
      ...base,
      getConversationLabels: async () => {
        reads++;
        return reads === 1 ? ["vip"] : [];
      },
    } as unknown as typeof base;
    const model = new LabellingModel(["vip", "cancelamento"]);
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () => drifting,
        makeModel: () => model as unknown as BaseChatModel,
      },
    );
    expect(res).toEqual({ outcome: "done" });
    // The write is computed against the read INSIDE the label queue (reads 2+), and `vip` was in
    // the shown set, so repeating it is not a request to add it back.
    const written = log.labelsWritten.at(-1);
    expect(written).toBeDefined();
    expect(written).not.toContain("vip");
    expect(written).toContain("cancelamento");
  });

  // THE GUARD HAS TO HOLD IN EVERY MODEL-FACING PLACE, not only in the tool's diff. `set_labels`
  // filters guarded labels out of what it shows and out of what it accepts, but the observer's own
  // prompt prints the conversation's labels in `<etiquetas-atuais>` from the SAME read — so without
  // this the block advertised `agente-off` while the tool's description denied it existed, which is
  // both a contradiction to reason from and the invitation the guard exists to withdraw (round 12).
  test("a guarded label is absent from the prompt, and survives the write", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const client = stubClient([message(1, "quero cancelar")], [], log);
    (client as { getConversationLabels: unknown }).getConversationLabels =
      async () => ["agente-off", "compra-de-ingresso"];
    let prompt = "";
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          monitoring: MONITORING,
          setLabels: { protected: ["agente-off"] },
        },
      },
    });
    try {
      // A local stub, because LabellingModel's `bindTools` returns an invoke that takes no
      // arguments: what this test needs is exactly the two things it drops, the messages the model
      // was handed and the tool descriptions it was bound to.
      const seenTools: string[] = [];
      const model = {
        async invoke(): Promise<AIMessage> {
          return new AIMessage("pronto");
        },
        bindTools(tools: { name?: string; description?: string }[]) {
          for (const t of tools) seenTools.push(String(t.description ?? ""));
          let n = 0;
          return {
            async invoke(msgs: unknown): Promise<AIMessage> {
              prompt += JSON.stringify(msgs);
              n++;
              return n === 1
                ? new AIMessage({
                    content: "",
                    tool_calls: [
                      {
                        name: "set_labels",
                        args: { labels: ["cancelamento"] },
                        id: "call_labels",
                      },
                    ],
                  })
                : new AIMessage("pronto");
            },
          };
        },
      };
      const res = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () => client,
          makeModel: () => model as unknown as BaseChatModel,
        },
      );
      expect(res).toEqual({ outcome: "done" });
      // Neither the labels block in the prompt nor the tool's own description names it.
      expect(prompt).toContain("compra-de-ingresso");
      expect(prompt).not.toContain("agente-off");
      const labelsTool = seenTools.find((d) => d.includes("current_labels"));
      expect(labelsTool).toBeDefined();
      expect(labelsTool).not.toContain("agente-off");
      // And the model asking for `cancelamento` alone did not take it off the conversation.
      const written = log.labelsWritten.at(-1);
      expect(written).toContain("agente-off");
      expect(written).toContain("cancelamento");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
    }
  });

  // THE OBSERVER RUNS THE ORDINARY TOOLSET NOW, so a tool whose URL carries `{{message_id}}` is as
  // legal on a tick as on a reactive turn — and the tick was the only caller that never supplied it,
  // so such a tool failed with a missing-placeholder error on EVERY observation. The burst knows the
  // id (`atMessageId`); it just was not being passed (round 13).
  test("a burst hands its triggering message id to the tools", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const client = stubClient([message(1, "e o pedido?")], [], log);
    let calledUrl = "";
    const def = await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: `eco_${process.pid}`,
        label: "Eco",
        method: "GET",
        // A public IP literal: the SSRF guard treats it as an IP and makes no DNS lookup, and the
        // injected fetch means nothing leaves this process.
        urlTemplate: "https://8.8.8.8/eco/{{message_id}}",
        allowedHosts: ["8.8.8.8"],
      },
    });
    const sel = await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId,
        source: "HTTP",
        toolDefinitionId: def.id,
        knowledgeBaseIds: [],
        enabledTools: [def.name],
      },
    });
    try {
      const model = {
        async invoke(): Promise<AIMessage> {
          return new AIMessage("pronto");
        },
        bindTools() {
          let n = 0;
          return {
            async invoke(): Promise<AIMessage> {
              n++;
              return n === 1
                ? new AIMessage({
                    content: "",
                    tool_calls: [{ name: def.name, args: {}, id: "call_eco" }],
                  })
                : new AIMessage("pronto");
            },
          };
        },
      };
      const res = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: 4242,
        },
        appDb,
        {
          makeClient: async () => client,
          makeModel: () => model as unknown as BaseChatModel,
          outboundFetch: (async (url: string) => {
            calledUrl = String(url);
            return new Response('{"ok":true}', {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }) as unknown as typeof fetch,
        },
      );
      expect(res).toEqual({ outcome: "done" });
      expect(calledUrl).toContain("/eco/4242");
    } finally {
      await suDb.agentToolSelection.deleteMany({ where: { id: sel.id } });
      await suDb.toolDefinition.deleteMany({ where: { id: def.id } });
    }
  });

  // DISCOVERY IS THE ONE CALL THAT CAN HANG FOREVER, and before this it was the one call the
  // deadline did not cover: it was created after `buildToolset`. An MCP server that opens its stream
  // and never emits an endpoint waits with no timeout of its own, and `startScheduler` skips every
  // later tick while one is running — so one tenant's broken server stops everyone's reminders.
  test("an MCP server that never answers gives the tick back instead of hanging discovery", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const conn = await suDb.mcpServerConnection.create({
      data: {
        tenantId,
        name: `mudo-${process.pid}`,
        transport: "streamableHttp",
        url: "https://mudo.example.com/mcp",
      },
    });
    const sel = await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId,
        source: "MCP",
        mcpServerConnectionId: conn.id,
        knowledgeBaseIds: [],
        enabledTools: ["qualquer_uma"],
      },
    });
    const started = Date.now();
    try {
      const res = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async () =>
            stubClient([message(1, "quero cancelar")], [], log),
          makeModel: () => new SilentModel() as unknown as BaseChatModel,
          // Opens and never says anything else, which is the SSE pathology in miniature.
          mcp: { connect: (() => new Promise(() => {})) as never },
          timeoutMs: 300,
        },
      );
      expect(res.outcome).toBe("fail");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(log.labelsWritten).toEqual([]);
    } finally {
      await suDb.agentToolSelection.delete({ where: { id: sel.id } });
      await suDb.mcpServerConnection.delete({ where: { id: conn.id } });
    }
  });

  // THE TICK RUNS ON THE SHARED SCHEDULER, so a provider that never answers is not just this
  // observation lost: `runSchedulerTick` awaits every handler and `startScheduler` skips the next
  // tick while one is still running, so reminders and every other job queue up behind it. The
  // verdict call this replaced carried a deadline; the graph invoke came up without one.
  test("a model that never answers gives the tick back instead of hanging the scheduler", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    // An ARRAY and not a `let`: control-flow analysis narrows a variable assigned only inside a
    // callback to `never`, and the release below stops type-checking.
    const release: (() => void)[] = [];
    const stalled = {
      calls: 0,
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      },
      bindTools(_tools: unknown) {
        return {
          invoke(): Promise<AIMessage> {
            // Never resolves on its own: only the deadline can end this.
            return new Promise<AIMessage>((resolve) => {
              release.push(() => resolve(new AIMessage("tarde demais")));
            });
          },
        };
      },
    };
    const started = Date.now();
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () => stalled as unknown as BaseChatModel,
        timeoutMs: 200,
      },
    );
    for (const r of release) r();
    expect(res.outcome).toBe("fail");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(log.labelsWritten).toEqual([]);
  });

  test("a superseded run acts on nothing", async () => {
    await clearFlowLog(suDb, { tenantId });
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const job = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "OBSERVE",
        dedupeKey: `sup-${process.pid}`,
        status: "CLAIMED",
        claimSeq: 7,
        runAt: new Date(),
        payload: {},
      },
    });
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () =>
          new LabellingModel(["cancelamento"]) as unknown as BaseChatModel,
        // A message that landed while the model answered re-armed the row, so the claim this tick
        // holds is no longer the current one.
        claim: { jobId: job.id, claimSeq: 6 },
      },
    );
    expect(res).toEqual({ outcome: "done" });
    expect(log.labelsWritten).toEqual([]);
    const detail = detailOf(await observeLines(), 0);
    expect(detail.skipped).toBe("superseded");
  });

  test("a turn about a message the reset erased acts on nothing", async () => {
    await clearFlowLog(suDb, { tenantId });
    await suDb.conversation.update({
      where: { id: convRowId },
      data: { resetAtMessageId: 500 },
    });
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: 400,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(600, "quero cancelar")], [], log),
        makeModel: () =>
          new LabellingModel(["cancelamento"]) as unknown as BaseChatModel,
      },
    );
    await suDb.conversation.update({
      where: { id: convRowId },
      data: { resetAtMessageId: null },
    });
    expect(res).toEqual({ outcome: "done" });
    expect(log.labelsWritten).toEqual([]);
    const detail = detailOf(await observeLines(), 0);
    expect(detail.skipped).toBe("reset");
  });

  test("an observer taken off the inbox while the model answered acts on nothing", async () => {
    await clearFlowLog(suDb, { tenantId });
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const res = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () =>
          new LabellingModel(["cancelamento"], () =>
            suDb.inboxObserver.deleteMany({
              where: { tenantId, inboxId: inboxRowId, agentId },
            }),
          ) as unknown as BaseChatModel,
      },
    );
    const stillThere = await suDb.inboxObserver.count({
      where: { tenantId, inboxId: inboxRowId, agentId },
    });
    await suDb.inboxObserver.createMany({
      data: [{ tenantId, inboxId: inboxRowId, agentId }],
      skipDuplicates: true,
    });
    // The detach has to have actually landed, or this asserts nothing about the fence.
    expect(stillThere).toBe(0);
    expect(res).toEqual({ outcome: "done" });
    expect(log.labelsWritten).toEqual([]);
  });
});
