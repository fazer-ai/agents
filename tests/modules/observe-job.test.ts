import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import type { ResolvedModelConfig } from "@/graph/models";
import {
  clearMediaAnnotations,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { withConversationLabels } from "@/modules/chatwoot/labels";
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

const observeLines = () =>
  flowLogRows(suDb, {
    where: { conversationId: convRowId, stage: "observe" },
    orderBy: { id: "asc" },
    select: { status: true, level: true, detail: true, agentId: true },
  });

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

  test("nothing is armed without a label group, and a burst is not armed for an agent that only looks at the end", async () => {
    expect(
      await armObserve({
        tenantId,
        instanceId,
        conversationId: CONV + 1,
        agentId,
        reason: "burst",
        cfg: readMonitoringConfig({}),
        base: appDb,
      }),
    ).toBe("off");
    const onResolve = readMonitoringConfig({
      monitoring: { ...MONITORING, analysis: "on_resolve" },
    });
    expect(
      await armObserve({
        tenantId,
        instanceId,
        conversationId: CONV + 1,
        agentId,
        reason: "burst",
        cfg: onResolve,
        base: appDb,
      }),
    ).toBe("off");
    expect(
      await armObserve({
        tenantId,
        instanceId,
        conversationId: CONV + 1,
        agentId,
        reason: "resolved",
        cfg: onResolve,
        base: appDb,
      }),
    ).toBe("armed");
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, dedupeKey: { contains: `:${CONV + 1}` } },
    });
  });

  test("the tick writes the exclusive label once, posts one private note, and writes one observe line", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const labels = ["agente-off", "compra-de-ingresso"];
    const calls = { n: 0 };
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
        makeModel: () =>
          verdictModel(
            {
              assunto: "cancelamento",
              confidence: 0.92,
              reason: "O cliente pediu para cancelar o ingresso.",
            },
            calls,
          ),
      },
    );
    expect(res).toEqual({ outcome: "done" });
    expect(calls.n).toBe(1);
    expect(log.labelsWritten).toEqual([["agente-off", "cancelamento"]]);
    expect(log.notes).toEqual([
      "🔎 Observadora · assunto: compra-de-ingresso → cancelamento\nO cliente pediu para cancelar o ingresso.",
    ]);
    expect(log.publicSends).toBe(0);
    const lines = await observeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.status).toBe("ok");
    expect(lines[0]?.agentId).toBe(agentId);
    const detail = detailOf(lines, 0);
    expect(detail.changed).toBe(true);
    expect(detail.reason).toBe("burst");
    expect(detail.verdict).toEqual({ assunto: "cancelamento" });
    expect(detail.noted).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("pediu para cancelar");
    const usage = await suDb.llmUsage.findMany({
      where: { tenantId },
      select: { node: true, conversationId: true },
    });
    expect(usage.map((u) => u.node)).toEqual(["observer"]);
    expect(usage[0]?.conversationId).toBe(convRowId);
  });

  test("the same verdict again writes nothing and says so; a value outside the list is refused", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    // A resolve verdict runs on a conversation that IS resolved (issue #477 review, round 6).
    await suDb.conversation.update({
      where: { id: convRowId },
      data: { status: "resolved" },
    });
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
          stubClient([message(3, "quero cancelar")], ["cancelamento"], log),
        makeModel: () =>
          verdictModel(
            { assunto: "cancelamento", confidence: 1, reason: "" },
            calls,
          ),
      },
    );
    await suDb.conversation.update({
      where: { id: convRowId },
      data: { status: "open" },
    });
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
          stubClient([message(4, "quero reembolso")], ["cancelamento"], log),
        makeModel: () =>
          verdictModel(
            { assunto: "reembolso", confidence: 0.7, reason: "x" },
            calls,
          ),
      },
    );
    expect(log.labelsWritten).toEqual([]);
    expect(log.notes).toEqual([]);
    const lines = await observeLines();
    expect(lines).toHaveLength(3);
    expect(detailOf(lines, 1).changed).toBe(false);
    expect(detailOf(lines, 1).reason).toBe("resolved");
    expect(lines[2]?.level).toBe("warn");
    // The GROUP that refused, never what it refused: a value outside the enum is the model's own
    // text, and `ExecutionLog.detail` carries no model text (issue #477 review, round 3).
    expect(detailOf(lines, 2).refused).toEqual(["assunto"]);
    expect(detailOf(lines, 2).verdict).toEqual({ assunto: null });
    expect(JSON.stringify(detailOf(lines, 2))).not.toContain("reembolso");
  });

  test("an answer in prose is read for its JSON; one nothing can read is a done tick with an error line", async () => {
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
          stubClient(
            [message(5, "afinal vou comprar outro")],
            ["cancelamento"],
            log,
          ),
        makeModel: () =>
          verdictModel(
            'Claro! {"assunto": "compra-de-ingresso", "confidence": 0.8, "reason": "novo pedido"} fim',
            calls,
          ),
      },
    );
    expect(log.labelsWritten).toEqual([["compra-de-ingresso"]]);
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
          stubClient([message(6, "oi")], ["cancelamento"], log),
        makeModel: () => verdictModel("não sei dizer", calls),
      },
    );
    expect(res).toEqual({ outcome: "done" });
    const lines = await observeLines();
    expect(lines.at(-1)?.status).toBe("error");
    expect(detailOf(lines, -1).failed).toBe("unreadable_verdict");
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

  test("an agent flipped to answering while the tick was reading writes nothing", async () => {
    // The flip lands AFTER the tick loaded the agent and BEFORE it writes: the model has answered,
    // and the re-read before the write is what keeps the verdict off a responder's conversation.
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const client = stubClient([message(9, "cancela tudo")], [], log);
    const flipping = {
      ...client,
      getConversationLabels: async () => {
        await suDb.agent.update({
          where: { id: agentId },
          data: { mode: "production" },
        });
        return [];
      },
    } as unknown as ChatwootClient;
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
          makeClient: async () => flipping,
          makeModel: () => verdictModel({ assunto: "cancelamento" }, calls),
        },
      );
      expect(res).toEqual({ outcome: "done" });
      expect(calls.n).toBe(1);
      expect(log.labelsWritten).toEqual([]);
      expect(log.notes).toEqual([]);
      const last = detailOf(await observeLines(), -1);
      expect(last.skipped).toBe("agent_no_longer_observes");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "monitoring" },
      });
    }
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

  // `setConversationLabels` REPLACES the set, so the write has to be built on the labels as they are
  // when it goes out. Built on the snapshot taken before the model call, a label a colleague added
  // in those seconds is deleted by a feature whose whole promise is not to touch what is outside its
  // groups (issue #477 review, round 1).
  test("a label added while the model was answering survives the write", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const labels = ["compra-de-ingresso"];
    const calls = { n: 0 };
    const client = stubClient(
      [message(1, "quero cancelar, não vou conseguir ir")],
      labels,
      log,
    );
    let reads = 0;
    (client as { getConversationLabels: unknown }).getConversationLabels =
      async () => {
        reads += 1;
        // The colleague's label lands between the read that feeds the prompt and the one that feeds
        // the write; from then on it is part of the live set.
        if (reads === 2) labels.push("vip");
        return [...labels];
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
        makeModel: () =>
          verdictModel(
            { assunto: "cancelamento", confidence: 0.9, reason: "pediu" },
            calls,
          ),
      },
    );
    expect(res).toEqual({ outcome: "done" });
    // Three: the prompt's, the write's, and the verification pass that finds the write standing and
    // writes nothing more.
    expect(reads).toBe(3);
    expect(log.labelsWritten).toEqual([["vip", "cancelamento"]]);
  });

  // A read that fails does not get to write a stale set. The tick does not end there either: the
  // FIRST read failing is the verdict lost, since nothing re-arms an `on_resolve` row, so it fails
  // and the scheduler retries (issue #477 review, round 7).
  test("labels that cannot be re-read fail the tick without writing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const client = stubClient(
      [message(1, "quero cancelar")],
      ["compra-de-ingresso"],
      log,
    );
    let reads = 0;
    (client as { getConversationLabels: unknown }).getConversationLabels =
      async () => {
        reads += 1;
        if (reads === 1) return ["compra-de-ingresso"];
        throw new Error("chatwoot 502");
      };
    const before = (await observeLines()).length;
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
          makeModel: () =>
            verdictModel(
              { assunto: "cancelamento", confidence: 0.9, reason: "pediu" },
              calls,
            ),
        },
      ),
    ).toEqual({
      outcome: "fail",
      error: "observe: the labels could not be read before writing",
    });
    expect(log.labelsWritten).toEqual([]);
    const lines = await observeLines();
    expect(lines.length).toBe(before + 1);
    expect(detailOf(lines, -1).failed).toBe("labels_unreadable");
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

  // Chatwoot has no compare-and-set on the labels endpoint, and two classifiers hold two rows now:
  // the later POST erases the earlier one's group. The verification pass re-applies the same verdict
  // onto the newest set (issue #477 review, round 2).
  test("a write another classifier clobbered is re-applied once", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const labels = ["compra-de-ingresso"];
    const calls = { n: 0 };
    const client = stubClient([message(1, "quero cancelar")], labels, log);
    let reads = 0;
    (client as { getConversationLabels: unknown }).getConversationLabels =
      async () => {
        reads += 1;
        // The other classifier's POST lands between our write and the verification read, and it was
        // built on the set as it was before ours.
        if (reads === 3) labels.splice(0, labels.length, "urgente");
        return [...labels];
      };
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
          makeModel: () =>
            verdictModel(
              { assunto: "cancelamento", confidence: 0.9, reason: "pediu" },
              calls,
            ),
        },
      ),
    ).toEqual({ outcome: "done" });
    expect(log.labelsWritten).toEqual([
      ["cancelamento"],
      ["urgente", "cancelamento"],
    ]);
    // ...and the other classifier's own label is kept, which is the point of re-applying rather than
    // re-posting what we had.
    expect(labels).toEqual(["urgente", "cancelamento"]);
  });

  // THE REPAIR'S SUBJECT IS THE WRITE IT REPAIRS (issue #477 review, round 24). A group the first
  // pass left alone, edited by a person between our POST and the verification read, is an edit we
  // have SEEN — re-applying the verdict over it would revert a manual classification and fire
  // whatever the label triggers.
  test("a group the first pass did not move is left alone by the repair", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    // Two groups: the verdict moves `assunto` and repeats what `sinal` already holds.
    const labels = ["compra-de-ingresso", "morno"];
    const calls = { n: 0 };
    const client = stubClient([message(1, "quero cancelar")], labels, log);
    let reads = 0;
    (client as { getConversationLabels: unknown }).getConversationLabels =
      async () => {
        reads += 1;
        // Read 1 feeds the prompt, read 2 is the pre-write re-read, read 3 the verification.
        if (reads === 3)
          // Another classifier clobbers OUR group, and a person moves the other one.
          labels.splice(0, labels.length, "urgente", "quente");
        return [...labels];
      };
    try {
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            monitoring: {
              labelGroups: [
                ...MONITORING.labelGroups,
                {
                  name: "sinal",
                  exclusive: true,
                  values: ["morno", "quente"],
                },
              ],
            },
          },
        },
      });
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
            makeModel: () =>
              verdictModel(
                {
                  assunto: "cancelamento",
                  sinal: "morno",
                  confidence: 0.9,
                  reason: "pediu",
                },
                calls,
              ),
          },
        ),
      ).toEqual({ outcome: "done" });
      // The repair puts OUR value back onto the set as it stands, and leaves `quente` — the edit it
      // did not make and has now seen — exactly where the person put it.
      expect(log.labelsWritten).toEqual([
        // `assunto` moved; `sinal` was already on the value the verdict repeats.
        ["morno", "cancelamento"],
        // Without the restriction the repair would also sweep `quente` back to `morno`.
        ["urgente", "quente", "cancelamento"],
      ]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
    }
  });

  // THE REPAIR IS HELD TO THE TAXONOMY IT WROTE (issue #477 review, round 23). The in-queue fence
  // hands back the CURRENT configuration on both passes; the groups the repair applies were chosen
  // on the first, so a taxonomy replaced while our first POST was in flight would have the second
  // pass write a value from a group that is gone — the very thing the first pass refuses to do.
  test("a group replaced between the write and the repair is not repaired", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const labels = ["compra-de-ingresso"];
    const calls = { n: 0 };
    const client = stubClient([message(1, "quero cancelar")], labels, log);
    let reads = 0;
    (client as { getConversationLabels: unknown }).getConversationLabels =
      async () => {
        reads += 1;
        // Read 1 feeds the prompt, read 2 is the pre-write re-read, read 3 the verification.
        if (reads === 3) {
          // Another classifier clobbers our write...
          labels.splice(0, labels.length, "urgente");
          // ...and the operator replaces the group we wrote under, in the same window.
          await suDb.agent.update({
            where: { id: agentId },
            data: {
              settings: {
                monitoring: {
                  labelGroups: [
                    { name: "assunto", exclusive: false, values: ["outros"] },
                  ],
                },
              },
            },
          });
        }
        return [...labels];
      };
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
            makeClient: async () => client,
            makeModel: () =>
              verdictModel(
                { assunto: "cancelamento", confidence: 0.9, reason: "pediu" },
                calls,
              ),
          },
        ),
      ).toEqual({ outcome: "done" });
      // The first write landed and stands; the repair wrote nothing, because the group it would
      // have repaired is not the group standing now.
      expect(log.labelsWritten).toEqual([["cancelamento"]]);
      expect(labels).toEqual(["urgente"]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
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

  // THE TAXONOMY IS A DIFFERENT THING FROM THE AGENT. An operator edits it from the console while a
  // model call is in flight, and applied from the snapshot this tick loaded the verdict lands under
  // a group that was replaced — or on an agent whose last group was deleted, which is how
  // observation is switched off (issue #477 review, round 5).
  test("label groups cleared during the model call stop the write", async () => {
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
            makeClient: async () =>
              stubClient([message(1, "quero cancelar")], [], log),
            makeModel: () => {
              // The operator clears the taxonomy while the model is answering.
              const m = verdictModel(
                { assunto: "cancelamento", confidence: 0.9, reason: "r" },
                calls,
              );
              const inner = m.invoke.bind(m);
              (m as { invoke: unknown }).invoke = async (
                msgs: Parameters<typeof inner>[0],
                opts: Parameters<typeof inner>[1],
              ) => {
                await suDb.agent.update({
                  where: { id: agentId },
                  data: { settings: { monitoring: { labelGroups: [] } } },
                });
                return inner(msgs, opts);
              };
              return m;
            },
          },
        ),
      ).toEqual({ outcome: "done" });
      expect(calls.n).toBe(1);
      expect(log.labelsWritten).toEqual([]);
      expect(log.notes).toEqual([]);
      const lines = await observeLines();
      expect(lines.length).toBe(before + 1);
      expect(detailOf(lines, -1).skipped).toBe("observation_off");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
    }
  });

  // ...AND THE SAME EDIT LANDING ONE ROUND TRIP LATER (issue #477 review, round 22). The fence used
  // to be asked once, at the top of the label queue, with a Chatwoot GET between it and the POST:
  // an operator switching observation off inside that window reached the write unseen, and the
  // scheduler's CAS only notices after the label, the note and whatever the label triggered have
  // landed.
  test("label groups cleared during the label read stop the write", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    const client = stubClient([message(1, "quero cancelar")], [], log);
    (client as { getConversationLabels: unknown }).getConversationLabels =
      async () => {
        // The console write lands while this read is in flight.
        await suDb.agent.update({
          where: { id: agentId },
          data: { settings: { monitoring: { labelGroups: [] } } },
        });
        return [];
      };
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
            makeClient: async () => client,
            makeModel: () =>
              verdictModel(
                { assunto: "cancelamento", confidence: 0.9, reason: "r" },
                calls,
              ),
          },
        ),
      ).toEqual({ outcome: "done" });
      // The model was still paid for — the fence is downstream of the call by design — but nothing
      // was written.
      expect(calls.n).toBe(1);
      expect(log.labelsWritten).toEqual([]);
      expect(log.notes).toEqual([]);
      const lines = await observeLines();
      expect(lines.length).toBe(before + 1);
      expect(detailOf(lines, -1).skipped).toBe("observation_off");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
    }
  });

  // A TICK ALREADY CLAIMED IS PAST EVERY CANCEL. `/reset` retires the pending rows, but one whose
  // model call was in flight when the command landed would write back the labels the operator was
  // just told were cleared. The fence is the one the direct turn is held to, asked in Chatwoot's own
  // message sequence (issue #477 review, round 6).
  test("a verdict about a message the reset erased writes nothing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    await suDb.conversation.update({
      where: { id: convRowId },
      data: { resetAtMessageId: 500 },
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
            // Armed on a message the command then erased.
            atMessageId: 499,
          },
          appDb,
          {
            // A post-reset message stands too, so the transcript is not empty and the tick reaches
            // the reset FENCE rather than exiting earlier for having nothing to read.
            makeClient: async () =>
              stubClient(
                [message(499, "quero cancelar"), message(501, "oi")],
                [],
                log,
              ),
            makeModel: () =>
              verdictModel(
                { assunto: "cancelamento", confidence: 0.9, reason: "r" },
                calls,
              ),
          },
        ),
      ).toEqual({ outcome: "done" });
      expect(log.labelsWritten).toEqual([]);
      expect(detailOf(await observeLines(), -1).skipped).toBe("reset");
      // A verdict about a message that arrived AFTER the command is a new episode, and writes.
      expect(
        await runObserve(
          tenantId,
          {
            instanceId,
            conversationId: CONV,
            agentId,
            reason: "burst",
            atMessageId: 501,
          },
          appDb,
          {
            makeClient: async () =>
              stubClient([message(501, "quero cancelar")], [], log),
            makeModel: () =>
              verdictModel(
                { assunto: "cancelamento", confidence: 0.9, reason: "r" },
                calls,
              ),
          },
        ),
      ).toEqual({ outcome: "done" });
      expect(log.labelsWritten).toEqual([["cancelamento"]]);
      expect((await observeLines()).length).toBe(before + 2);
    } finally {
      await suDb.conversation.update({
        where: { id: convRowId },
        data: { resetAtMessageId: null },
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

  // The arm asks two questions; the pre-write fence has to ask both. An operator switching to
  // `on_resolve` while the call is in flight is refusing exactly this verdict.
  test("analysis switched to on_resolve during the call stops the burst verdict", async () => {
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
            makeClient: async () =>
              stubClient([message(1, "quero cancelar")], [], log),
            makeModel: () => {
              const m = verdictModel(
                { assunto: "cancelamento", confidence: 0.9, reason: "r" },
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
                      monitoring: { ...MONITORING, analysis: "on_resolve" },
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
      expect(log.labelsWritten).toEqual([]);
      const lines = await observeLines();
      expect(lines.length).toBe(before + 1);
      expect(detailOf(lines, -1).skipped).toBe("analysis_changed");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
    }
  });
  // A message that lands while the model answers re-arms the SAME row, so the tick holding the older
  // transcript is superseded before it writes. The scheduler's CAS only catches that after the
  // handler returns, by which point the note is posted (issue #477 review, round 7).
  test("a superseded run writes nothing and posts no note", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const key = observeDedupeKey(
      chatwootThreadId(tenantId, instanceId, CONV),
      agentId,
    );
    await suDb.schedulerJob.deleteMany({ where: { tenantId, dedupeKey: key } });
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "OBSERVE",
        dedupeKey: key,
        runAt: new Date(),
        status: "CLAIMED",
        claimSeq: 4,
        payload: {},
      },
      select: { id: true },
    });
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
            // The claim this tick holds is generation 4; the row moved on to 5 meanwhile.
            claim: { jobId: row.id, claimSeq: 4 },
            makeClient: async () =>
              stubClient([message(1, "quero cancelar")], [], log),
            makeModel: () => {
              const m = verdictModel(
                { assunto: "cancelamento", confidence: 0.9, reason: "r" },
                calls,
              );
              const inner = m.invoke.bind(m);
              (m as { invoke: unknown }).invoke = async (
                msgs: Parameters<typeof inner>[0],
                opts: Parameters<typeof inner>[1],
              ) => {
                await suDb.schedulerJob.update({
                  where: { id: row.id },
                  data: { status: "PENDING", claimSeq: 5 },
                });
                return inner(msgs, opts);
              };
              return m;
            },
          },
        ),
      ).toEqual({ outcome: "done" });
      expect(calls.n).toBe(1);
      expect(log.labelsWritten).toEqual([]);
      expect(log.notes).toEqual([]);
      const lines = await observeLines();
      expect(lines.length).toBe(before + 1);
      expect(detailOf(lines, -1).skipped).toBe("superseded");
    } finally {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, dedupeKey: key },
      });
    }
  });

  // Unreadable is not absent: folded into `null`, a failed read says "no reset happened" and the
  // verdict writes anyway, which is the one answer the reset fence must never give (round 7).
  test("an unreadable conversation row fails the tick instead of writing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    // The LOAD reads the row and succeeds; the pre-write read is the one that breaks, which is the
    // only way to tell "unreadable" apart from "absent" — deleting the row would exercise `null`,
    // the case that must NOT fail the tick.
    const flaky = appDb.$extends({
      query: {
        conversation: {
          findUnique({ args, query }) {
            // The pre-write read is the one that asks for exactly these two columns.
            const select = args.select as Record<string, unknown> | undefined;
            if (
              select?.status === true &&
              select.resetAtMessageId === true &&
              select.id !== true
            )
              throw new Error("db down");
            return query(args);
          },
        },
      },
    }) as unknown as typeof appDb;
    const result = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      flaky,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () =>
          verdictModel(
            { assunto: "cancelamento", confidence: 0.9, reason: "r" },
            calls,
          ),
      },
    );
    expect(result.outcome).toBe("fail");
    expect(log.labelsWritten).toEqual([]);
    expect(log.notes).toEqual([]);
    const lines = await observeLines();
    expect(lines.length).toBe(before + 1);
    expect(detailOf(lines, -1).failed).toBe("conversation_unreadable");
  });

  // `agentObservesNow` answers in three values precisely so the caller can tell a transient read
  // failure from a definite "no"; collapsing them discarded a verdict already paid for (round 8).
  test("an unreadable agent state fails the tick instead of standing down", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    // The load reads the agent with four columns; the pre-write re-read asks for exactly two.
    const flaky = appDb.$extends({
      query: {
        agent: {
          findUnique({ args, query }) {
            const select = args.select as Record<string, unknown> | undefined;
            if (
              select?.enabled === true &&
              select.mode === true &&
              select.name !== true
            )
              throw new Error("db down");
            return query(args);
          },
        },
      },
    }) as unknown as typeof appDb;
    const result = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      flaky,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () =>
          verdictModel(
            { assunto: "cancelamento", confidence: 0.9, reason: "r" },
            calls,
          ),
      },
    );
    expect(result.outcome).toBe("fail");
    expect(log.labelsWritten).toEqual([]);
    expect(log.notes).toEqual([]);
    const lines = await observeLines();
    expect(lines.length).toBe(before + 1);
    expect(detailOf(lines, -1).failed).toBe("agent_state_unreadable");
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

  // `/reset` clears the labels INSIDE `withConversationLabels`. A fence read OUTSIDE that queue
  // passes, the reset then takes the queue first and clears, and the tick enters afterwards and puts
  // back exactly what the operator was told was gone (issue #477 review, round 8). Here another
  // holder of the queue writes the marker while the tick is blocked on it: the fence only sees the
  // marker if it is read after the queue is entered.
  test("a reset that lands while the tick waits for the label queue wins", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    // Enter the queue first and stay in it, the way `/reset` does while it clears.
    const holder = withConversationLabels(tenantId, CONV, () => held);
    try {
      const tick = runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          // The burst is about message 40; the reset above lands after it.
          atMessageId: 40,
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
      );
      // Let the tick get past everything that is NOT the queue and block on it. The marker is
      // written only now: a fence read before the queue has already passed by this point, so the
      // refusal below is evidence the fence is read after the queue is entered, not merely late.
      await new Promise((r) => setTimeout(r, 50));
      await suDb.conversation.update({
        where: { id: convRowId },
        data: { resetAtMessageId: 41 },
      });
      release();
      await holder;
      expect(await tick).toEqual({ outcome: "done" });
      expect(log.labelsWritten).toEqual([]);
      expect(log.notes).toEqual([]);
      const lines = await observeLines();
      expect(lines.length).toBe(before + 1);
      expect(detailOf(lines, -1).skipped).toBe("reset");
    } finally {
      release();
      await holder.catch(() => {});
      await suDb.conversation.update({
        where: { id: convRowId },
        data: { resetAtMessageId: null },
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

  // At load time "unreadable keeps the tick" is right; on the other side of the model call it means
  // WRITES, onto an inbox the agent may already be off (issue #477 review, round 10).
  test("an unreadable binding fails the tick instead of writing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    let reads = 0;
    const flaky = appDb.$extends({
      query: {
        inbox: {
          findUnique({ args, query }) {
            reads += 1;
            // The load asks once, before the model call; the pre-write fence is the second.
            if (reads > 1) throw new Error("db down");
            return query(args);
          },
        },
      },
    }) as unknown as typeof appDb;
    const result = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      flaky,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () =>
          verdictModel(
            { assunto: "cancelamento", confidence: 0.9, reason: "r" },
            calls,
          ),
      },
    );
    expect(result.outcome).toBe("fail");
    expect(log.labelsWritten).toEqual([]);
    expect(log.notes).toEqual([]);
    const lines = await observeLines();
    expect(lines.length).toBe(before + 1);
    expect(detailOf(lines, -1).failed).toBe("binding_unreadable");
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

  // A conversation moved to another inbox mid-call leaves the load's snapshot naming the old one,
  // and the binding fence would ask about an inbox it is no longer on (round 11).
  test("the binding fence asks about the inbox the conversation is on now", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    const other = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 98765,
        name: "Outra",
      },
      select: { id: true },
    });
    try {
      const result = await runObserve(
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
          makeModel: () => {
            const m = verdictModel(
              { assunto: "cancelamento", confidence: 0.9, reason: "r" },
              calls,
            );
            const inner = m.invoke.bind(m);
            (m as { invoke: unknown }).invoke = async (
              msgs: Parameters<typeof inner>[0],
              opts: Parameters<typeof inner>[1],
            ) => {
              // The move lands while the model answers: nothing observes the new inbox.
              await suDb.conversation.update({
                where: { id: convRowId },
                data: { inboxId: other.id },
              });
              return inner(msgs, opts);
            };
            return m;
          },
        },
      );
      expect(result).toEqual({ outcome: "done" });
      expect(log.labelsWritten).toEqual([]);
      expect(log.notes).toEqual([]);
      const lines = await observeLines();
      expect(lines.length).toBe(before + 1);
      expect(detailOf(lines, -1).skipped).toBe("agent_no_longer_on_inbox");
    } finally {
      await suDb.conversation.update({
        where: { id: convRowId },
        data: { inboxId: inboxRowId },
      });
      await suDb.inbox.delete({ where: { id: other.id } });
    }
  });

  // The taxonomy is what the verdict is applied AGAINST, so an unreadable re-read is not "keep the
  // snapshot": it writes labels from a taxonomy an operator may have just replaced (round 12).
  test("unreadable monitoring settings fail the tick instead of writing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    // The load reads four columns off the agent; the settings re-read asks for one.
    const flaky = appDb.$extends({
      query: {
        agent: {
          findUnique({ args, query }) {
            const select = args.select as Record<string, unknown> | undefined;
            if (
              select?.settings === true &&
              select.name !== true &&
              select.mode !== true
            )
              throw new Error("db down");
            return query(args);
          },
        },
      },
    }) as unknown as typeof appDb;
    const result = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: CONV,
        agentId,
        reason: "burst",
        atMessageId: null,
      },
      flaky,
      {
        makeClient: async () =>
          stubClient([message(1, "quero cancelar")], [], log),
        makeModel: () =>
          verdictModel(
            { assunto: "cancelamento", confidence: 0.9, reason: "r" },
            calls,
          ),
      },
    );
    expect(result.outcome).toBe("fail");
    expect(log.labelsWritten).toEqual([]);
    expect(log.notes).toEqual([]);
    const lines = await observeLines();
    expect(lines.length).toBe(before + 1);
    expect(detailOf(lines, -1).failed).toBe("settings_unreadable");
  });

  // The prompt asks for 0 to 1; a prose answer gives whatever it likes, and a number the reader
  // cannot vouch for is better absent than wrong (issue #477 review, round 12).
  test("a confidence outside the advertised range is not recorded", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
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
        makeModel: () =>
          verdictModel(
            { assunto: "cancelamento", confidence: 75, reason: "r" },
            calls,
          ),
      },
    );
    const lines = await observeLines();
    expect(lines.length).toBe(before + 1);
    expect(detailOf(lines, -1).confidence).toBe(null);
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

  // The write already landed; only the VERIFICATION pass is best-effort, and returning there
  // skipped the note that describes the change (issue #477 review, round 13).
  test("a failed verification read still posts the change note", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const client = stubClient([message(1, "quero cancelar")], [], log);
    let reads = 0;
    (client as { getConversationLabels: unknown }).getConversationLabels =
      async () => {
        reads += 1;
        // 1: the prompt's read. 2: the pre-write read. 3: the verification, which fails.
        if (reads >= 3) throw new Error("chatwoot 502");
        return [];
      };
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
          makeModel: () =>
            verdictModel(
              { assunto: "cancelamento", confidence: 0.9, reason: "pediu" },
              calls,
            ),
        },
      ),
    ).toEqual({ outcome: "done" });
    expect(log.labelsWritten).toEqual([["cancelamento"]]);
    expect(log.notes).toHaveLength(1);
    expect(log.notes[0]).toContain("cancelamento");
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

  // The queue can be held by another writer for as long as its own Chatwoot round trips take, and
  // the checks before it are seconds old by the time the tick enters (issue #477 review, round 19).
  test("observation switched off while the tick waits for the queue writes nothing", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const before = (await observeLines()).length;
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = withConversationLabels(tenantId, CONV, () => held);
    try {
      const tick = runObserve(
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
            verdictModel(
              { assunto: "cancelamento", confidence: 0.9, reason: "r" },
              calls,
            ),
        },
      );
      // The tick is blocked on the queue by now; the switch is thrown only here, so a check made
      // before the queue has already passed.
      await new Promise((r) => setTimeout(r, 50));
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: {} },
      });
      release();
      await holder;
      expect(await tick).toEqual({ outcome: "done" });
      expect(log.labelsWritten).toEqual([]);
      expect(log.notes).toEqual([]);
      const lines = await observeLines();
      expect(lines.length).toBe(before + 1);
      expect(detailOf(lines, -1).skipped).toBe("observation_off");
    } finally {
      release();
      await holder.catch(() => {});
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { monitoring: MONITORING } },
      });
    }
  });

  // THE SECOND PROVIDER RUNS FOR A VERDICT (issue #567). `runModelCall` carries the recovery
  // LangChain does not make, and the observer used to call it bare: an agent with a fallback
  // configured had nothing behind its provider here, and an intermittent 503 cost the LABEL — the
  // tick ends, the conversation keeps its old classification, and nothing says why.
  //
  // Both models come out of the SAME `makeModel`, told apart by the model id, which is also how the
  // job builds them: the fallback is `buildFallbackModel` over the agent's own `modelFallback`.
  test("a transient provider failure is answered by the configured fallback", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    const built: ResolvedModelConfig[] = [];
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          monitoring: MONITORING,
          // Same vendor, another model: the resolution then takes the agent's own credential, so
          // this needs no second vault entry to be runnable.
          modelFallback: { provider: "openai", model: "gpt-5.4" },
        },
      },
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
            stubClient(
              [
                message(1, "oi, comprei ingresso para sábado"),
                message(2, "quero cancelar, não vou conseguir ir"),
              ],
              ["agente-off"],
              log,
            ),
          makeModel: (mc) => {
            built.push(mc);
            if (mc.model === "gpt-5.4")
              return verdictModel(
                {
                  assunto: "cancelamento",
                  confidence: 0.9,
                  reason: "O cliente pediu cancelamento.",
                },
                calls,
              );
            // The primary answers with a status the fallback exists for (503), not with a refusal:
            // a 400 would be the same answer from anybody and must NOT be failed over.
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
      expect(res).toEqual({ outcome: "done" });
      // Both models were built, and the verdict written is the FALLBACK's. The FALLBACK COMES FIRST
      // in this list, and that order is itself the round-1 fix: the primary's bounds depend on
      // whether a fallback exists, so it cannot be built before the answer to that question.
      expect(built.map((m) => m.model)).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
      // ...and the primary WAS bounded, because one exists (issue #567 review, round 1). Unbounded,
      // LangChain's six retries and its unbounded wait spend the observer's whole abort on the
      // provider that already failed, and the second one never gets a turn.
      const primaryBuilt = built.find((m) => m.model === "gpt-5.4-mini");
      expect(primaryBuilt?.maxRetries).toBe(0);
      expect(primaryBuilt?.timeoutMs).toBeGreaterThan(0);
      expect(log.labelsWritten.at(-1)).toContain("cancelamento");
      // The usage row is filed under the model that actually answered, not under the primary's
      // name: the fallback gets its own callbacks for exactly this.
      const usage = await suDb.llmUsage.findMany({
        where: { tenantId, node: "observer" },
        select: { model: true },
        orderBy: { id: "desc" },
        take: 1,
      });
      expect(usage.at(0)?.model).toBe("gpt-5.4");
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

  // A FALLBACK THAT CANNOT BE BUILT SAYS SO, AT BUILD TIME (issue #567 review, round 1). A deleted
  // credential leaves the tick with nothing behind its provider, which is indistinguishable from
  // having configured none — and a server log is not where the operator who configured it looks.
  test("a fallback that cannot be built leaves a warning on the trail", async () => {
    const log: ClientLog = { labelsWritten: [], notes: [], publicSends: 0 };
    const calls = { n: 0 };
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          monitoring: MONITORING,
          // Another vendor, so the resolution demands its OWN credential, and the ref resolves to
          // nothing: `buildFallbackModel` reports `credential_not_found`.
          modelFallback: {
            provider: "anthropic",
            model: "claude-4-5-haiku",
            credentialRef: "vault:999999",
          },
        },
      },
    });
    const before2 = (await observeLines()).length;
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
          makeClient: async () =>
            stubClient(
              [message(1, "quero cancelar, não vou conseguir ir")],
              ["agente-off"],
              log,
            ),
          makeModel: () =>
            verdictModel(
              { assunto: "cancelamento", confidence: 0.9, reason: "r" },
              calls,
            ),
        },
      );
      const lines = (await observeLines()).slice(before2);
      const unavailable = lines.find(
        (l) =>
          (l.detail as Record<string, unknown> | null)?.fallbackUnavailable !==
          undefined,
      );
      expect(unavailable?.level).toBe("warn");
      // The tick still ran on the primary: a fallback that cannot be built is a warning, not a stop.
      expect(log.labelsWritten.at(-1)).toContain("cancelamento");
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
});
