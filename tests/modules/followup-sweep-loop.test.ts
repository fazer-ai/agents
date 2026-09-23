import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  followUpHandler,
  registerFollowUpHandlers,
} from "@/modules/followups/handlers";
import {
  type ClaimedJob,
  claimDueJobs,
  enqueueJob,
} from "@/modules/scheduler/service";
import {
  getJobHandler,
  registerJobHandler,
  runClaimed,
} from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// A VARREDURA SÓ OFERECE O QUE O HANDLER VAI FAZER (issue #796).
//
// A varredura roda a cada minuto e re-arma `followup:<thread>` para toda conversa que ela seleciona.
// Três entradas faziam dela um laço sem fim: um agente com o follow-up desligado continuava
// selecionado (a SQL testava só `follow_up_armed_at`), uma conversa atribuída a OUTRO bot também (o
// portão ao vivo devolve `stale`, que não carimba nada), e uma linha que o handler adiou de propósito
// voltava para agora com o payload trocado, perdendo a contagem de retentativas e a cadência do
// passo 0. Medido em produção: 89 linhas PENDING do passo 0, uma com `claim_seq` 366.
//
// O arranjo é o caminho vivo: a varredura de verdade arma, `claimDueJobs` reivindica, `runClaimed`
// executa o handler de produção com um modelo e um Chatwoot falsos.
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

const DAY_MS = 24 * 60 * 60_000;
const OUR_BOT = 5;
// Uma caixa por agente: a caixa decide o agente da conversa.
const INBOX_ON = 7961;
const INBOX_OFF = 7962;
const INBOX_SLOW = 7963;
// Uma conversa por caso: a chave do follow-up nomeia a conversa.
const CONV_ON = 79_601;
const CONV_OFF = 79_602;
const CONV_OTHER_BOT = 79_603;
const CONV_LATER = 79_605;
const CONV_DUE = 79_606;
const CONV_SLOW = 79_607;

let tenantId = 0n;
let instanceId = 0n;
let sweepJobId = 0n;
const inboxIds = new Map<number, bigint>();

function threadOf(convId: number): string {
  return `${tenantId}:${instanceId}:${convId}`;
}

function keyOf(convId: number): string {
  return `followup:${threadOf(convId)}`;
}

function stubClient(meta: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const client = {
    getConversation: async (c: number) => ({
      id: c,
      status: "pending",
      meta,
    }),
    sendMessage: async (_c: number, t: string) => {
      sent.push(t);
      return {};
    },
    sendPrivateNote: async () => ({}),
    getConversationLabels: async () => [],
    setConversationLabels: async () => ({}),
    toggleStatus: async () => ({}),
  } as unknown as ChatwootClient;
  return { sent, makeClient: async () => client };
}

function registerStubbed(s: ReturnType<typeof stubClient>) {
  registerJobHandler("FOLLOWUP", (job, base) =>
    followUpHandler(job, base, {
      makeModel: () => new FakeListChatModel({ responses: ["Oi?"] }),
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    }),
  );
}

async function runSweep(): Promise<void> {
  const sweep = getJobHandler("FOLLOWUP_SWEEP");
  if (!sweep) throw new Error("unreachable: registerFollowUpHandlers ran");
  const job: ClaimedJob = {
    id: sweepJobId,
    tenantId,
    kind: "FOLLOWUP_SWEEP",
    payload: {},
    attempts: 0,
    claimSeq: 0,
  };
  await sweep(job, appDb);
}

async function rowOf(convId: number) {
  return suDb.schedulerJob.findFirst({
    where: { tenantId, kind: "FOLLOWUP", dedupeKey: keyOf(convId) },
    select: { status: true, payload: true, runAt: true, claimSeq: true },
  });
}

// Uma conversa parada há dois minutos, respondida por nós, que a varredura seleciona para o passo 0.
async function seedIdle(
  convId: number,
  inbox: number,
  assignee: { type: string; id: number } | null = null,
): Promise<void> {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxIds.get(inbox) ?? null,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: assignee?.type ?? null,
      assigneeId: assignee?.id ?? null,
      threadId: threadOf(convId),
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
      lastRepliedMessageId: 1,
    },
  });
}

async function seedAgent(
  name: string,
  followUp: { enabled: boolean; delayMinutes: number },
  inbox: number,
  botId: number,
): Promise<void> {
  const llmKey = await suDb.vaultEntry.create({
    data: { tenantId, name: `llm-${name}`, secret: encryptJson("sk-test") },
    select: { id: true },
  });
  const agent = await suDb.agent.create({
    data: {
      tenantId,
      name,
      systemPrompt: "Você é prestativa.",
      followUpArmedAt: new Date(Date.now() - 30 * DAY_MS),
      modelConfig: {
        provider: "openai",
        model: "gpt-4o-mini",
        credentialRef: `vault:${llmKey.id}`,
      },
      settings: {
        followUp: {
          enabled: followUp.enabled,
          steps: [
            {
              delayValue: followUp.delayMinutes,
              delayUnit: "minutes",
              instructions: "a",
            },
          ],
        },
      },
    },
  });
  await suDb.chatwootAgentBot.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      agentId: agent.id,
      chatwootAgentBotId: botId,
      accessToken: encryptJson("BOT"),
      webhookSecret: encryptJson("S"),
      webhookRouteTokenHash: `fu796-${name}-${process.pid}`,
      name,
    },
  });
  const row = await suDb.inbox.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootInboxId: inbox,
      name,
      agentId: agent.id,
      channelType: "Channel::Api",
    },
  });
  inboxIds.set(inbox, row.id);
}

describe.skipIf(!dbUp)(
  "the follow-up sweep only offers what the handler will act on (issue #796)",
  () => {
    beforeAll(async () => {
      sweepJobId = await burnSchedulerJobId(suDb);
      const t = await suDb.tenant.create({
        data: { name: "FU796", slug: `fu796-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 5,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      await seedAgent(
        "on",
        { enabled: true, delayMinutes: 1 },
        INBOX_ON,
        OUR_BOT,
      );
      // Armed once, then switched off: `follow_up_armed_at` stays set.
      await seedAgent("off", { enabled: false, delayMinutes: 1 }, INBOX_OFF, 6);
      // A first step longer than the sweep's cutoff, which the minimum over agents sets at 1 minute.
      await seedAgent(
        "slow",
        { enabled: true, delayMinutes: 10 },
        INBOX_SLOW,
        7,
      );
      registerFollowUpHandlers();
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "scheduler_jobs",
          "llm_usage",
          "conversations",
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

    test("an agent whose follow-up was switched off is not swept, and one that is on is", async () => {
      await seedIdle(CONV_ON, INBOX_ON);
      await seedIdle(CONV_OFF, INBOX_OFF);
      await runSweep();
      expect((await rowOf(CONV_ON))?.status).toBe("PENDING");
      expect(await rowOf(CONV_OFF)).toBeNull();
    });

    // Another bot's conversation stays in the selection, because the mirror's assignee may be the
    // stale half and only the live gate repairs it (review round 1). What ends the loop is the
    // handler parking the row when the gate declines, and the next pass leaving it parked.
    test("a conversation another bot holds is asked once, then parked for an hour", async () => {
      await seedIdle(CONV_OTHER_BOT, INBOX_ON, { type: "AgentBot", id: 99 });
      await runSweep();
      const claimed = (
        await claimDueJobs(50, appDb, new Date(), tenantId)
      ).filter((j) => j.dedupeKey === keyOf(CONV_OTHER_BOT));
      expect(claimed).toHaveLength(1);
      const s = stubClient({ assignee_type: "AgentBot", assignee: { id: 99 } });
      registerStubbed(s);
      const [job] = claimed;
      if (!job) return;
      await runClaimed(job, appDb);
      const parked = await rowOf(CONV_OTHER_BOT);
      expect(parked?.status).toBe("PENDING");
      const until = parked?.runAt.getTime() ?? 0;
      expect(until).toBeGreaterThan(Date.now() + 55 * 60_000);
      await runSweep();
      const after = await rowOf(CONV_OTHER_BOT);
      expect(after?.runAt.getTime()).toBe(until);
      expect(after?.claimSeq).toBe(parked?.claimSeq);
      expect(s.sent).toEqual([]);
    });

    // The retry the handler scheduled keeps its time and its count, so NUDGE_RETRY_LIMIT can be
    // reached; before, each pass put the row back to now with the sweep's own payload.
    test("a run its handler put off keeps its time and its payload; a due one is armed as before", async () => {
      await seedIdle(CONV_LATER, INBOX_ON);
      await seedIdle(CONV_DUE, INBOX_ON);
      const later = new Date(Date.now() + 30 * 60_000);
      const retried = {
        threadId: threadOf(CONV_LATER),
        nudgeRetries: 2,
      };
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_LATER),
        runAt: later,
        payload: retried,
        rearm: "same-work",
        base: appDb,
      });
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_DUE),
        runAt: new Date(Date.now() - 60_000),
        payload: { threadId: threadOf(CONV_DUE), nudgeRetries: 1 },
        rearm: "same-work",
        base: appDb,
      });
      const before = Date.now();
      await runSweep();
      const kept = await rowOf(CONV_LATER);
      expect(kept?.runAt.getTime()).toBe(later.getTime());
      expect(kept?.payload).toEqual(retried);
      const due = await rowOf(CONV_DUE);
      expect(due?.payload).toEqual({ threadId: threadOf(CONV_DUE) });
      expect(due?.runAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    });

    // The cadence of a step longer than the cutoff: the handler reschedules to when the step is due,
    // and the next pass used to pull it back to now, a claim and a reschedule every minute.
    test("a step-0 cadence longer than the sweep's cutoff is not pulled back every pass", async () => {
      await seedIdle(CONV_SLOW, INBOX_SLOW);
      await runSweep();
      const claimed = (
        await claimDueJobs(50, appDb, new Date(), tenantId)
      ).filter((j) => j.dedupeKey === keyOf(CONV_SLOW));
      expect(claimed).toHaveLength(1);
      const s = stubClient();
      registerStubbed(s);
      const [job] = claimed;
      if (!job) return;
      await runClaimed(job, appDb);
      const deferred = await rowOf(CONV_SLOW);
      expect(deferred?.status).toBe("PENDING");
      const dueAt = deferred?.runAt.getTime() ?? 0;
      expect(dueAt).toBeGreaterThan(Date.now() + 5 * 60_000);
      await runSweep();
      const after = await rowOf(CONV_SLOW);
      expect(after?.runAt.getTime()).toBe(dueAt);
      expect(after?.claimSeq).toBe(deferred?.claimSeq);
      expect(s.sent).toEqual([]);
    });
  },
);
