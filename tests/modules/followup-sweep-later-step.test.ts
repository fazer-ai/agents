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
import { type ClaimedJob, claimDueJobs } from "@/modules/scheduler/service";
import {
  getJobHandler,
  registerJobHandler,
  runClaimed,
} from "@/modules/scheduler/worker";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// A VARREDURA QUE LEU ANTES DO CARIMBO NÃO REINICIA A ESCADA QUE JÁ ANDOU (issue #896).
//
// A varredura lê as conversas elegíveis uma vez e arma uma por uma. Entre a leitura e a vez desta
// conversa no laço, o passo 0 pode terminar: carimba `last_follow_up_at` e reagenda a mesma linha
// como `{ stepIndex: 1, episode }`, PENDING, para amanhã. A varredura então arma com a decisão que
// leu antes do carimbo, e o `leaveLaterRun` recusava toda linha de passo > 0 como "sobra de outro
// episódio": o payload virava `{ threadId, episode }` e o run_at, agora. O tick seguinte rodava
// "passo 0", via o episódio carimbado e saía `done`; o último passo (etiqueta e resolve) nunca
// rodava, e nada registrava a perda. O conserto pergunta de novo, no arme e sob a trava da linha, se o
// episódio continua sem carimbo (`stillWanted`).
//
// A intercalação é determinística: o banco que a varredura recebe roda o passo 0 inteiro no instante
// em que a varredura abre a transação do PRIMEIRO arme, que é depois da leitura das conversas. As duas
// transações antes dele são a leitura dos agentes e a das conversas (src/modules/followups/handlers.ts,
// sweepHandler); o teste confere que o passo 0 rodou ali, e não antes, pelo que ele mandou.
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

const CHATWOOT_INBOX_ID = 8961;
const LABEL = "sem-resposta";
const DAY_MS = 24 * 60 * 60_000;
// Uma conversa por caso: a chave do follow-up nomeia a conversa.
const CONV_CORRIDA = 89_601;
const CONV_OUTRO_EPISODIO = 89_602;
const CONV_CARIMBADA = 89_603;
const CONV_UM_PASSO = 89_604;
const CONV_EPISODIO_NOVO = 89_605;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let sweepJobId = 0n;

function threadOf(convId: number): string {
  return `${tenantId}:${instanceId}:${convId}`;
}

function keyOf(convId: number): string {
  return `followup:${threadOf(convId)}`;
}

function stubClient() {
  const sent: string[] = [];
  const labelSets: string[][] = [];
  const resolved: number[] = [];
  let currentLabels: string[] = [];
  const client = {
    getConversation: async (c: number) => ({
      id: c,
      status: "pending",
      meta: {},
    }),
    sendMessage: async (_c: number, t: string) => {
      sent.push(t);
      return {};
    },
    sendPrivateNote: async () => ({}),
    getConversationLabels: async () => currentLabels,
    setConversationLabels: async (_c: number, labels: string[]) => {
      currentLabels = labels;
      labelSets.push(labels);
      return {};
    },
    toggleStatus: async (c: number) => {
      resolved.push(c);
      return {};
    },
  } as unknown as ChatwootClient;
  return { sent, labelSets, resolved, makeClient: async () => client };
}

function registerStubbedFollowUp(s: ReturnType<typeof stubClient>) {
  registerJobHandler("FOLLOWUP", (job, base) =>
    followUpHandler(job, base, {
      makeModel: () => new FakeListChatModel({ responses: ["Ainda por aí?"] }),
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    }),
  );
}

// O banco da varredura, com um gancho na abertura da transação de número `nth`: roda `hook` inteiro
// antes de a transação começar. É `runScopedOn` quem abre cada transação, sempre por
// `base.$extends(...).$transaction(...)`, então contar os `$extends` conta as transações.
function withHookBeforeTransaction(
  db: PrismaClient,
  nth: number,
  hook: () => Promise<void>,
): PrismaClient {
  let opened = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "$extends") {
        return (...args: unknown[]) => {
          // biome-ignore lint/suspicious/noExplicitAny: the proxy forwards Prisma's own overloads
          const extended = (target.$extends as any)(...args);
          opened += 1;
          if (opened !== nth) return extended;
          return new Proxy(extended, {
            get(t2, p2) {
              if (p2 === "$transaction") {
                return async (...txArgs: unknown[]) => {
                  await hook();
                  return t2.$transaction(...txArgs);
                };
              }
              const v = Reflect.get(t2, p2);
              return typeof v === "function" ? v.bind(t2) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function runSweep(base: PrismaClient = appDb): Promise<void> {
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
  await sweep(job, base);
}

async function claimOwn(convId: number): Promise<ClaimedJob[]> {
  const claimed = await claimDueJobs(50, appDb, new Date(), tenantId);
  return claimed.filter((j) => j.dedupeKey === keyOf(convId));
}

async function rowOf(convId: number) {
  return suDb.schedulerJob.findFirstOrThrow({
    where: { tenantId, kind: "FOLLOWUP", dedupeKey: keyOf(convId) },
    select: { id: true, status: true, payload: true, runAt: true },
  });
}

// Uma conversa parada há dois minutos, respondida por nós, que a varredura seleciona para o passo 0.
async function seedIdle(convId: number): Promise<void> {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      status: "pending",
      threadId: threadOf(convId),
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
      lastRepliedMessageId: 1,
    },
  });
}

async function elapse(convId: number, ms: number): Promise<void> {
  await suDb.$executeRaw`
    UPDATE conversations
       SET last_event_at = last_event_at - ${ms} * interval '1 millisecond',
           last_inbound_at = last_inbound_at - ${ms} * interval '1 millisecond',
           last_follow_up_at = last_follow_up_at - ${ms} * interval '1 millisecond'
     WHERE tenant_id = ${tenantId} AND chatwoot_conversation_id = ${convId}`;
  await suDb.$executeRaw`
    UPDATE scheduler_jobs SET run_at = now() - interval '1 second'
     WHERE tenant_id = ${tenantId} AND dedupe_key = ${keyOf(convId)}`;
}

describe.skipIf(!dbUp)(
  "a sweep that read before step 0 stamped (issue #896)",
  () => {
    beforeAll(async () => {
      sweepJobId = await burnSchedulerJobId(suDb);
      const t = await suDb.tenant.create({
        data: { name: "FU896", slug: `fu896-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 5,
        baseUrl: "https://chat.example.com",
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
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          followUpArmedAt: new Date(Date.now() - 30 * DAY_MS),
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: {
            followUp: {
              enabled: true,
              steps: [
                { delayValue: 1, delayUnit: "minutes", instructions: "a" },
                {
                  delayValue: 1,
                  delayUnit: "days",
                  instructions: "b",
                  assignLabels: [LABEL],
                  resolve: true,
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
          chatwootAgentBotId: 5,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `fu896-route-${process.pid}`,
          name: "Atendente",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: CHATWOOT_INBOX_ID,
          name: "Suporte",
          agentId: agent.id,
          channelType: "Channel::Api",
        },
      });
      inboxDbId = inbox.id;
      registerFollowUpHandlers();
    });

    afterAll(async () => {
      if (tenantId) {
        await clearFlowLog(suDb, { tenantId });
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

    test("step 0 finishing between the sweep's read and its arm keeps step 1, and the ladder reaches its last step", async () => {
      await seedIdle(CONV_CORRIDA);
      await runSweep();
      const [step0] = await claimOwn(CONV_CORRIDA);
      expect(step0).toBeDefined();
      if (!step0) return;

      const s = stubClient();
      registerStubbedFollowUp(s);
      // A varredura lê a conversa ainda sem carimbo (o passo 0 está reivindicado e não rodou), e o
      // passo 0 roda inteiro antes do arme dela.
      let sentWhenArmOpened = -1;
      await runSweep(
        withHookBeforeTransaction(appDb, 3, async () => {
          await runClaimed(step0, appDb);
          sentWhenArmOpened = s.sent.length;
        }),
      );
      expect(sentWhenArmOpened).toBe(1);

      const after = await rowOf(CONV_CORRIDA);
      expect(after.status).toBe("PENDING");
      expect(after.payload).toMatchObject({ stepIndex: 1 });
      expect(after.runAt.getTime()).toBeGreaterThan(Date.now() + DAY_MS / 2);

      await elapse(CONV_CORRIDA, 2 * DAY_MS);
      const [step1] = await claimOwn(CONV_CORRIDA);
      expect(step1?.payload.stepIndex).toBe(1);
      if (!step1) return;
      await runClaimed(step1, appDb);
      expect(s.sent).toHaveLength(2);
      expect(s.labelSets.at(-1)).toContain(LABEL);
      expect(s.resolved).toEqual([CONV_CORRIDA]);
    });

    // The re-check must not refuse a NEW episode: a conversation followed up before, whose customer
    // spoke after that stamp, is unstamped for the episode the sweep read, and is armed as always.
    test("a conversation that spoke after its last follow-up is armed for its new episode", async () => {
      await seedIdle(CONV_EPISODIO_NOVO);
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_EPISODIO_NOVO },
        data: { lastFollowUpAt: new Date(Date.now() - 10 * 60_000) },
      });
      await runSweep();
      const row = await rowOf(CONV_EPISODIO_NOVO);
      expect(row.status).toBe("PENDING");
      expect(row.payload).not.toHaveProperty("stepIndex");
    });

    test("a later step left by ANOTHER episode is still replaced by the new episode's step 0", async () => {
      await seedIdle(CONV_OUTRO_EPISODIO);
      // A escada de um episódio anterior ficou pendente para amanhã, e o nosso último envio abriu
      // um episódio novo sem cancelá-la (issue #796).
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: keyOf(CONV_OUTRO_EPISODIO),
          status: "PENDING",
          runAt: new Date(Date.now() + DAY_MS),
          payload: {
            threadId: threadOf(CONV_OUTRO_EPISODIO),
            stepIndex: 1,
            episode: "1",
          },
        },
      });
      await runSweep();
      const after = await rowOf(CONV_OUTRO_EPISODIO);
      expect(after.payload).not.toHaveProperty("stepIndex");
      expect(after.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    test("step 0 run on an episode already followed up ends, and says the ladder was lost", async () => {
      await clearFlowLog(suDb, { tenantId });
      await seedIdle(CONV_CARIMBADA);
      // O episódio já teve o seu follow-up: o carimbo é posterior às duas últimas falas.
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_CARIMBADA },
        data: { lastFollowUpAt: new Date(Date.now() - 60_000) },
      });
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: keyOf(CONV_CARIMBADA),
          status: "PENDING",
          runAt: new Date(Date.now() - 1_000),
          payload: { threadId: threadOf(CONV_CARIMBADA), episode: "1" },
        },
      });
      const s = stubClient();
      registerStubbedFollowUp(s);
      const [job] = await claimOwn(CONV_CARIMBADA);
      expect(job).toBeDefined();
      if (!job) return;
      await runClaimed(job, appDb);

      expect(s.sent).toHaveLength(0);
      expect((await rowOf(CONV_CARIMBADA)).status).toBe("DONE");
      const lines = await flowLogRows(suDb, {
        // flowlog-scope: tenant-wide — o tenant é deste arquivo e o caso esvazia o log antes; o
        // sujeito é QUANTAS linhas a perda escreveu.
        where: { tenantId, stage: "dead_letter" },
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe("warn");
      expect(lines[0]?.threadId).toBe(threadOf(CONV_CARIMBADA));
      expect(lines[0]?.detail).toMatchObject({
        unit: "job",
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_CARIMBADA),
      });
    });

    // Review rounds 1 and 2: step 0 can END the sequence on purpose inside the window between the
    // sweep's read and its arm: the only step of a one-step ladder, a noted window, a schedule that
    // never opens, retries spent. Each stamps the episode. The arm asks again whether the episode is
    // still unstamped, so the finished row stays finished instead of going back to step 0.
    test("a ladder that ended between the sweep's read and its arm stays ended", async () => {
      await clearFlowLog(suDb, { tenantId });
      const agent = await suDb.agent.findFirstOrThrow({ where: { tenantId } });
      await suDb.agent.update({
        where: { id: agent.id },
        data: {
          settings: {
            followUp: {
              enabled: true,
              steps: [
                { delayValue: 1, delayUnit: "minutes", instructions: "a" },
              ],
            },
          },
        },
      });
      try {
        await seedIdle(CONV_UM_PASSO);
        await runSweep();
        const [step0] = await claimOwn(CONV_UM_PASSO);
        expect(step0).toBeDefined();
        if (!step0) return;
        const s = stubClient();
        registerStubbedFollowUp(s);
        await runSweep(
          withHookBeforeTransaction(appDb, 3, async () => {
            await runClaimed(step0, appDb);
          }),
        );
        expect(s.sent).toHaveLength(1);
        expect((await rowOf(CONV_UM_PASSO)).status).toBe("DONE");
        expect(await claimOwn(CONV_UM_PASSO)).toHaveLength(0);
        const lines = await flowLogRows(suDb, {
          // flowlog-scope: tenant-wide — o tenant é deste arquivo e o caso esvazia o log antes; o
          // sujeito é QUANTAS linhas um fim de sequência de propósito escreveu.
          where: { tenantId, stage: "dead_letter" },
        });
        expect(lines).toHaveLength(0);
      } finally {
        await suDb.agent.update({
          where: { id: agent.id },
          data: { settings: agent.settings ?? {} },
        });
      }
    });
  },
);
