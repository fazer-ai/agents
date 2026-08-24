import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { OUTSIDE_WINDOW_NOTE_PREFIX } from "@/graph/nudge";
import type { TenantContext } from "@/lib/tenancy";
import { createAgent, updateAgent } from "@/modules/agents/service";
import { ChatwootClient } from "@/modules/chatwoot/client";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import {
  normalizeChatwootEvent,
  parseLiveConversation,
} from "@/modules/chatwoot/normalize";
import {
  followUpHandler,
  registerFollowUpHandlers,
} from "@/modules/followups/handlers";
import {
  type ClaimedJob,
  retireJobsByDedupeKey,
} from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// NOTE: Guardrails da cadeia "follow-up em conversa resolvida" (post da comunidade "Followup indo como
// conversa privada", 2026-08-06). O incidente: espelho local preso em `pending` (resolve perdido /
// entrega fora de ordem) → sweep enfileira FOLLOWUP para conversas que o Chatwoot real já resolveu
// → nudge posta o texto como nota privada (fora da janela de 24h sem template), em massa, para a
// base histórica. Cada teste aqui trava uma das defesas:
//   (1) mirror: só um message_created INCOMING reabre resolved/snoozed (message_updated e
//       não-incoming carregam snapshot congelado e não regridem; reaberturas legítimas seguem);
//   (2) live gate: o handler verifica o estado REAL no Chatwoot antes de postar e reconcilia o
//       espelho stale (fail-closed quando não dá para verificar);
//   (3) watermark de ativação: o sweep só inicia sequência para episódios pós-arm;
//   (4) nota fora-da-janela explicada + encerra a sequência (sem auto-resolve);
//   (5) transições OFF→ON do estado efetivo (qualquer modo) armam Agent.followUpArmedAt no
//       service; promover test→production re-arma.

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
let accountBase = "";
// Agente A: sweep/live-gate (armado 3h atrás — o fence do backlog é testável dos dois lados).
let agentAId = 0n;
let inboxAId = 0n;
// Agente B: nota fora-da-janela (armado 30d atrás; 2 steps para provar o encerramento da sequência).
let agentBId = 0n;
let inboxBId = 0n;

const INBOX_A = 71;
const INBOX_B = 72;
const HOUR = 3_600_000;
const ARMED_A_AGO_MS = 3 * HOUR;

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

function jobFor(convId: number): ClaimedJob {
  return {
    id: 1n,
    tenantId,
    kind: "FOLLOWUP",
    payload: { threadId: threadOf(convId) },
    attempts: 0,
    claimSeq: 0,
  };
}

function convPayload(
  convId: number,
  inboxId: number,
  over: {
    status: string;
    lastActivityAt: number;
    assignee?: { id: number; name: string };
  },
) {
  return {
    id: convId,
    inbox_id: inboxId,
    status: over.status,
    contact_inbox: { id: 88_000 + convId },
    meta: {
      assignee_type: over.assignee ? "User" : null,
      assignee: over.assignee ?? null,
      sender: {
        id: 500 + convId,
        name: "Cliente",
        phone_number: "+5511999990000",
      },
    },
    channel: "Channel::Whatsapp",
    last_activity_at: over.lastActivityAt,
  };
}

async function mirror(payload: unknown) {
  const n = normalizeChatwootEvent(payload);
  expect(n).not.toBeNull();
  if (!n) throw new Error("unreachable");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

async function mirroredConv(convId: number) {
  return suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: {
      status: true,
      assigneeType: true,
      assigneeId: true,
      lastInboundAt: true,
      lastFollowUpAt: true,
    },
  });
}

function stubClient(liveState: () => unknown) {
  const sent: Array<[number, string]> = [];
  const notes: Array<[number, string]> = [];
  const client = {
    getConversation: async (_c: number) => liveState(),
    sendMessage: async (c: number, t: string) => {
      sent.push([c, t]);
      return {};
    },
    sendPrivateNote: async (c: number, t: string) => {
      notes.push([c, t]);
      return {};
    },
    getConversationLabels: async () => [],
    setConversationLabels: async () => ({}),
    toggleStatus: async () => ({}),
  } as unknown as ChatwootClient;
  return { sent, notes, makeClient: async () => client };
}

function handlerDeps(s: ReturnType<typeof stubClient>) {
  return {
    makeModel: () =>
      new FakeListChatModel({ responses: ["Oi! Ainda posso ajudar?"] }),
    makeClient: s.makeClient,
    checkpointer: new MemorySaver(),
    persistUsage: async () => {},
  };
}

async function seedConversation(
  convId: number,
  inboxDbId: bigint,
  over: {
    status?: string;
    lastEventAt: Date;
    lastInboundAt: Date;
    lastFollowUpAt?: Date | null;
    // O que o ESPELHO diz sobre quem detém a conversa. Default: ninguém.
    assigneeType?: string | null;
    assigneeId?: number | null;
  },
) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      inboxId: inboxDbId,
      status: over.status ?? "pending",
      assigneeType: over.assigneeType ?? null,
      ...(over.assigneeId != null ? { assigneeId: over.assigneeId } : {}),
      threadId: threadOf(convId),
      lastEventAt: over.lastEventAt,
      lastInboundAt: over.lastInboundAt,
      lastFollowUpAt: over.lastFollowUpAt ?? null,
    },
  });
}

describe.skipIf(!dbUp)("follow-up em conversa resolvida — guardrails", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "FU-GUARD", slug: `fu-guard-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 11,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const deployment = await suDb.chatwootDeployment.findFirstOrThrow({
      where: { tenantId },
      select: { baseUrl: true },
    });
    accountBase = `${deployment.baseUrl}/api/v1/accounts/11`;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const modelConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
      credentialRef: `vault:${llmKey.id}`,
    };
    const agentA = await suDb.agent.create({
      data: {
        tenantId,
        name: "Guard A",
        systemPrompt: "Você é prestativa.",
        mode: "production",
        modelConfig,
        followUpArmedAt: new Date(Date.now() - ARMED_A_AGO_MS),
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 60, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
    });
    agentAId = agentA.id;
    const agentB = await suDb.agent.create({
      data: {
        tenantId,
        name: "Guard B",
        systemPrompt: "Você é prestativa.",
        mode: "production",
        modelConfig,
        followUpArmedAt: new Date(Date.now() - 30 * 24 * HOUR),
        settings: {
          followUp: {
            enabled: true,
            steps: [
              { delayValue: 1, delayUnit: "minutes", instructions: "" },
              { delayValue: 1, delayUnit: "days", instructions: "" },
            ],
          },
        },
      },
    });
    agentBId = agentB.id;
    for (const [agentId, cwInboxId] of [
      [agentAId, INBOX_A],
      [agentBId, INBOX_B],
    ] as const) {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
          chatwootAgentBotId: Number(cwInboxId),
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `fu-guard-${cwInboxId}-${process.pid}`,
          name: "Guard",
        },
      });
    }
    // Inboxes WhatsApp OFICIAL (Cloud API): o gate da janela de 24h se aplica.
    const inboxA = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_A,
        name: "WA A",
        agentId: agentAId,
        channelType: "Channel::Whatsapp",
        provider: "whatsapp_cloud",
      },
    });
    inboxAId = inboxA.id;
    const inboxB = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_B,
        name: "WA B",
        agentId: agentBId,
        channelType: "Channel::Whatsapp",
        provider: "whatsapp_cloud",
      },
    });
    inboxBId = inboxB.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "scheduler_jobs",
        "llm_usage",
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

  test("(1) mirror: outgoing entregue fora de ordem NÃO regride resolved; reaberturas legítimas seguem", async () => {
    const CONV = 4301;
    const tIn = Math.floor((Date.now() - 2 * 24 * HOUR) / 1000);
    const tClose = tIn + 3600;

    // Inbound do cliente → pending; resolve entregue (activity avançou last_activity_at).
    await mirror({
      event: "message_created",
      id: 9001,
      content: "quero saber sobre o produto",
      message_type: "incoming",
      private: false,
      conversation: convPayload(CONV, INBOX_A, {
        status: "pending",
        lastActivityAt: tIn,
      }),
    });
    await mirror({
      event: "conversation_resolved",
      ...convPayload(CONV, INBOX_A, {
        status: "resolved",
        lastActivityAt: tClose,
        assignee: { id: 7, name: "Atendente Humana" },
      }),
    });
    expect((await mirroredConv(CONV)).status).toBe("resolved");

    // Retry atrasado da despedida (payload congelado no enqueue: status "pending", MESMO segundo do
    // resolve). Antes do fix isto regredia o espelho para pending — o gatilho do incidente.
    await mirror({
      event: "message_created",
      id: 9002,
      content: "Resolvido! Qualquer coisa chama.",
      message_type: "outgoing",
      private: false,
      sender: { type: "user", id: 1, name: "Atendente" },
      conversation: convPayload(CONV, INBOX_A, {
        status: "pending",
        lastActivityAt: tClose,
      }),
    });
    const afterStale = await mirroredConv(CONV);
    expect(afterStale.status).toBe("resolved");
    // O snapshot congelado também não apaga o assignee que o resolve gravou.
    expect(afterStale.assigneeType).toBe("User");

    // Reabertura LEGÍTIMA 1: o cliente responde (incoming) → o Chatwoot reabre como pending.
    await mirror({
      event: "message_created",
      id: 9003,
      content: "na verdade tenho outra dúvida",
      message_type: "incoming",
      private: false,
      conversation: convPayload(CONV, INBOX_A, {
        status: "pending",
        lastActivityAt: tClose + 60,
      }),
    });
    expect((await mirroredConv(CONV)).status).toBe("pending");

    // Resolve de novo, e reabertura LEGÍTIMA 2: evento de CONVERSA continua autoritativo.
    await mirror({
      event: "conversation_resolved",
      ...convPayload(CONV, INBOX_A, {
        status: "resolved",
        lastActivityAt: tClose + 120,
      }),
    });
    await mirror({
      event: "conversation_status_changed",
      ...convPayload(CONV, INBOX_A, {
        status: "open",
        lastActivityAt: tClose + 180,
      }),
    });
    expect((await mirroredConv(CONV)).status).toBe("open");

    // message_updated de mensagem INCOMING (ex.: write-back do STT) com snapshot congelado
    // pré-resolve também NÃO reabre — só um message_created incoming novo reabre.
    await mirror({
      event: "conversation_resolved",
      ...convPayload(CONV, INBOX_A, {
        status: "resolved",
        lastActivityAt: tClose + 240,
      }),
    });
    await mirror({
      event: "message_updated",
      id: 9003,
      content: "na verdade tenho outra dúvida (transcrito)",
      message_type: "incoming",
      private: false,
      conversation: convPayload(CONV, INBOX_A, {
        status: "pending",
        lastActivityAt: tClose + 240,
      }),
    });
    expect((await mirroredConv(CONV)).status).toBe("resolved");
  });

  test("(2) live gate: espelho stale-pending + Chatwoot REAL resolved → aborta sem postar e reconcilia", async () => {
    const CONV = 4302;
    // Espelho stale: pending (o resolve nunca chegou), inativa há 2h — elegível pelo espelho.
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    const s = stubClient(() => ({
      id: CONV,
      status: "resolved",
      meta: {},
    }));
    const result = await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));

    // Nada foi postado (nem mensagem, nem nota) e a sequência morreu.
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
    // O espelho foi reconciliado com a realidade → o sweep para de re-enfileirar esta conversa.
    const after = await mirroredConv(CONV);
    expect(after.status).toBe("resolved");
    // Sem stamp: nada aconteceu; um episódio futuro real (cliente volta) decide sozinho.
    expect(after.lastFollowUpAt).toBeNull();
  });

  // (7) O reset que chega DEPOIS da última checagem do nudge. O handler ainda escreve na conversa por
  // conta própria — `lastFollowUpAt` é exatamente a coluna que o comando limpa —, e essa escrita
  // também arma o passo seguinte, ressuscitando a sequência que o comando encerrou. O encontro é o
  // envio ao cliente: nada dentro do runAgentNudge pergunta de novo depois dele.
  test("(7) um reset depois do envio não recarimba o watermark nem arma o próximo passo", async () => {
    const CONV = 4341;
    // O Agente B, porque ele tem DOIS passos: com um só, "encerrou" e "seguiu" terminam iguais e o
    // teste não distingue pular o carimbo de parar a sequência.
    await seedConversation(CONV, inboxBId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    const dedupeKey = `followup:${threadOf(CONV)}`;
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey,
        runAt: new Date(),
        status: "CLAIMED",
        payload: { threadId: threadOf(CONV) },
      },
      select: { id: true, claimSeq: true },
    });
    const s = stubClient(() => ({ id: CONV, status: "pending", meta: {} }));
    const inner = s.makeClient;
    let retired = false;
    const client = await inner();
    const sendMessage = client.sendMessage.bind(client);
    (client as { sendMessage: unknown }).sendMessage = async (
      c: number,
      t: string,
    ) => {
      const out = await sendMessage(c, t);
      // O comando chega com a mensagem já entregue: tarde demais para segurá-la, e cedo demais para
      // o carimbo.
      if (!retired) {
        retired = true;
        await retireJobsByDedupeKey(tenantId, "FOLLOWUP", dedupeKey, suDb);
      }
      return out;
    };

    const result = await followUpHandler(
      { ...jobFor(CONV), id: row.id, claimSeq: row.claimSeq },
      appDb,
      { ...handlerDeps(s), makeClient: async () => client },
    );

    expect(retired).toBe(true);
    // A mensagem saiu — o fecho não a desfaz, e não é isso que ele guarda.
    expect(s.sent.length).toBe(1);
    // O episódio termina aqui: sem carimbo e sem próximo passo.
    expect(result).toEqual({ outcome: "done" });
    expect((await mirroredConv(CONV)).lastFollowUpAt).toBeNull();
  });

  // (6) O portão ao vivo pergunta POSSE, e /reset devolve a posse. Um follow-up já reivindicado
  // passou pela primeira sondagem e está dentro da chamada do modelo; o operador reseta, a conversa
  // volta para a IA, e a segunda sondagem encontra tudo em ordem — postando um nudge do episódio que
  // acabou de ser apagado. A lápide é a pergunta que a devolução não consegue responder que sim.
  test("(6) um follow-up aposentado enquanto rodava não posta, mesmo com a posse devolvida", async () => {
    const CONV = 4340;
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    const dedupeKey = `followup:${threadOf(CONV)}`;
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey,
        runAt: new Date(),
        // Reivindicado: o estado em que um cancel não alcança a linha.
        status: "CLAIMED",
        payload: { threadId: threadOf(CONV) },
      },
      select: { id: true, claimSeq: true },
    });
    // O que o /reset faz com ela, e o que a execução em voo segura.
    await retireJobsByDedupeKey(tenantId, "FOLLOWUP", dedupeKey, suDb);
    // Chatwoot diz que a conversa é da IA — que é exatamente o que a devolução deixa para trás.
    const s = stubClient(() => ({ id: CONV, status: "pending", meta: {} }));

    const result = await followUpHandler(
      { ...jobFor(CONV), id: row.id, claimSeq: row.claimSeq },
      appDb,
      handlerDeps(s),
    );

    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
  });

  // O reconcile escreve status e assignee a partir de um snapshot REST que também traz a versão da
  // conversa (`updated_at.to_f`, o mesmo campo do webhook). Sem gravá-la, a linha fica à frente das
  // próprias marcas e o próximo evento atrasado parece mais novo que um estado que ele antecede.
  test("(2e) o reconcile grava a versão do snapshot, então um evento atrasado não o desfaz", async () => {
    const CONV = 4320;
    const T = Math.floor(Date.now() / 1000) - 7200;
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(T * 1000),
      lastInboundAt: new Date(T * 1000),
    });
    const s = stubClient(() => ({
      id: CONV,
      status: "resolved",
      meta: {},
      last_activity_at: T,
      updated_at: T + 30.5,
    }));
    await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));
    expect((await mirroredConv(CONV)).status).toBe("resolved");

    // O evento que o espelho perdeu, entregue agora: anterior ao snapshot, e com uma versão que
    // supera a marca antiga.
    const n = normalizeChatwootEvent({
      event: "conversation_updated",
      id: CONV,
      inbox_id: INBOX_A,
      status: "pending",
      contact_inbox: { id: 77_000 + CONV },
      meta: { assignee_type: null, assignee: null },
      last_activity_at: T,
      updated_at: T + 10,
    });
    if (n) await mirrorChatwootEvent(tenantId, instanceId, n, appDb);
    expect((await mirroredConv(CONV)).status).toBe("resolved");
  });

  // Uma sonda que CONFIRMA o espelho ainda traz algo novo: a versão. Numa linha migrada antes das
  // colunas existirem as marcas são nulas, e o próximo evento atrasado seria aceito como a primeira
  // palavra versionada sobre uma conversa que este GET acabou de verificar.
  test("(2f) o reconcile grava a versão mesmo quando os valores conferem", async () => {
    const CONV = 4321;
    const T = Math.floor(Date.now() / 1000) - 7200;
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(T * 1000),
      lastInboundAt: new Date(T * 1000),
    });
    // O Chatwoot concorda com o espelho (pending, sem humano) — nada a corrigir, só a versão.
    const s = stubClient(() => ({
      id: CONV,
      status: "pending",
      meta: {},
      last_activity_at: T,
      updated_at: T + 30.5,
    }));
    await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));
    const marks = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: CONV },
      select: { chatwootStatusAt: true, chatwootAssigneeAt: true },
    });
    expect(marks.chatwootStatusAt).toBe(T + 30.5);
    expect(marks.chatwootAssigneeAt).toBe(T + 30.5);
  });

  // O GET acontece antes do lock, e status/assignee mudam sem mover `last_activity_at`: um webhook
  // que aterrissa nesse intervalo é mais novo que a sonda, e só a versão sabe disso. Sem essa cerca
  // o reconcile reescreve o estado que a sonda viu por cima do que chegou depois — aqui, um humano
  // já desatribuído volta a ser dono e o agente para de responder.
  test("(2g) um snapshot mais velho que a marca não sobrescreve o assignee", async () => {
    const CONV = 4322;
    const T = Math.floor(Date.now() / 1000) - 7200;
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(T * 1000),
      lastInboundAt: new Date(T * 1000),
    });
    // O webhook da DESATRIBUIÇÃO, versão T+50: a conversa volta para o bot.
    const n = normalizeChatwootEvent({
      event: "conversation_updated",
      id: CONV,
      inbox_id: INBOX_A,
      status: "pending",
      contact_inbox: { id: 77_000 + CONV },
      meta: { assignee_type: null, assignee: null },
      last_activity_at: T,
      updated_at: T + 50,
    });
    if (n) await mirrorChatwootEvent(tenantId, instanceId, n, appDb);

    // A sonda do nudge devolve o estado de ANTES dela: humano dono, versão menor, mesmo segundo.
    const s = stubClient(() => ({
      id: CONV,
      status: "pending",
      meta: {
        assignee_type: "User",
        assignee: { id: 9, name: "Atendente" },
      },
      last_activity_at: T,
      updated_at: T + 10,
    }));
    await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));
    expect((await mirroredConv(CONV)).assigneeType).toBeNull();
  });

  test("(2b) live gate: humano assumiu no Chatwoot real → aborta e espelha o assignee", async () => {
    const CONV = 4303;
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    const s = stubClient(() => ({
      id: CONV,
      status: "pending",
      meta: {
        assignee_type: "User",
        assignee: { id: 7, name: "Atendente Humana" },
      },
    }));
    const result = await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
    expect((await mirroredConv(CONV)).assigneeType).toBe("User");
  });

  // Issue #214: o espelho dizendo que OUTRO Agent Bot detém a conversa NÃO derruba o job antes da
  // sonda. O assignee é justamente o campo que o `syncConversationState` conserta a partir do live
  // (uma atribuição perdida ou entregue fora de ordem deixa o espelho apontando para o bot errado),
  // então decidir posse pelo espelho aqui trocaria um countdown errado na tela por uma mensagem que
  // o cliente nunca recebe. Quem decide é a sonda, e ela diz que o bot da inbox continua com ela.
  test("(2h) live gate: espelho stale em OUTRO bot + live diz que é nosso → envia", async () => {
    const CONV = 4311;
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
      assigneeType: "AgentBot",
      assigneeId: 999,
    });
    const s = stubClient(() => ({
      id: CONV,
      status: "pending",
      meta: {
        assignee_type: "AgentBot",
        assignee: { id: INBOX_A, name: "Guard" },
      },
    }));
    const result = await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent.length).toBe(1);
    expect(s.notes).toEqual([]);
    // E o espelho sai consertado, que é como o countdown volta a ser verdade na tela.
    expect((await mirroredConv(CONV)).assigneeId).toBe(INBOX_A);
  });

  test("(2c) live gate pós-invoke: resolve DURANTE o turno do modelo → nada postado, espelho reconciliado", async () => {
    const CONV = 4310;
    // Dentro da janela de 24h: sem o gate pós-invoke, o texto iria como sendMessage ao cliente.
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    // 1ª consulta (pré-invoke): pending; 2ª (pós-invoke): o operador resolveu no meio do turno.
    let calls = 0;
    const s = stubClient(() => {
      calls += 1;
      return {
        id: CONV,
        status: calls === 1 ? "pending" : "resolved",
        meta: {},
      };
    });
    const result = await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));
    expect(result).toEqual({ outcome: "done" });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
    expect((await mirroredConv(CONV)).status).toBe("resolved");
    expect((await mirroredConv(CONV)).lastFollowUpAt).toBeNull();
  });

  test("(3) live gate fail-closed: GET falhou → nada postado, mesmo step re-tentado depois", async () => {
    const CONV = 4304;
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    const s = stubClient(() => {
      throw new Error("chatwoot indisponível");
    });
    const result = await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));
    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule") {
      expect(result.runAt.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
      // Mesmo step (threadId preservado), com o contador de retries avançado.
      expect(result.payload).toMatchObject({
        threadId: threadOf(CONV),
        nudgeRetries: 1,
      });
    }
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
    expect((await mirroredConv(CONV)).lastFollowUpAt).toBeNull();
  });

  test("(3b) retries esgotados: desiste do episódio com stamp (sem postar) — o sweep não re-enfileira em loop", async () => {
    const CONV = 4314;
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    const s = stubClient(() => {
      throw new Error("chatwoot indisponível");
    });
    const job: ClaimedJob = {
      id: 2n,
      tenantId,
      kind: "FOLLOWUP",
      payload: { threadId: threadOf(CONV), nudgeRetries: 7 },
      attempts: 0,
      claimSeq: 0,
    };
    const result = await followUpHandler(job, appDb, handlerDeps(s));
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
    // O stamp encerra o episódio: o sweep exige lastInboundAt > lastFollowUpAt para re-enfileirar,
    // então esta conversa só volta quando o cliente falar de novo.
    expect((await mirroredConv(CONV)).lastFollowUpAt).not.toBeNull();
  });

  test("(2d) reconcile do live gate respeita o guard monotônico: espelho mais novo não regride", async () => {
    const CONV = 4315;
    // Espelho avançado por um webhook MAIS NOVO que o snapshot do GET (cliente reabriu → pending);
    // 61min atrás para o step 0 (delay 60min) já estar vencido.
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(Date.now() - 61 * 60_000),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    // O GET devolve um snapshot ANTERIOR à reabertura (resolved, activity 2h atrás) — a corrida
    // GET → webhook commit → reconcile.
    let gets = 0;
    const s = stubClient(() => {
      gets += 1;
      return {
        id: CONV,
        status: "resolved",
        last_activity_at: Math.floor(Date.now() / 1000) - 7200,
        meta: {},
      };
    });
    const result = await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));
    expect(gets).toBeGreaterThan(0);
    // O live diz resolved → o follow-up morre (o fluxo reativo atende a reabertura), mas o
    // espelho mais novo NÃO é sobrescrito pelo snapshot velho.
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
    expect((await mirroredConv(CONV)).status).toBe("pending");
  });

  test("(4) sweep: só episódios iniciados APÓS o arm entram; backlog pré-arm fica de fora", async () => {
    // Agente A armado há 3h. PRE: silêncio começou 4h atrás (antes do arm). POST: 2h atrás (depois).
    const PRE = 4305;
    const POST = 4306;
    await seedConversation(PRE, inboxAId, {
      lastEventAt: new Date(Date.now() - 4 * HOUR),
      lastInboundAt: new Date(Date.now() - 4 * HOUR),
    });
    await seedConversation(POST, inboxAId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    registerFollowUpHandlers();
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    expect(sweep).toBeDefined();
    if (!sweep) throw new Error("unreachable");
    await sweep(
      {
        id: 99n,
        tenantId,
        kind: "FOLLOWUP_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    const jobs = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "FOLLOWUP", status: "PENDING" },
      select: { payload: true },
    });
    const threads = jobs.map(
      (j) => (j.payload as { threadId?: string }).threadId,
    );
    expect(threads).toContain(threadOf(POST));
    expect(threads).not.toContain(threadOf(PRE));
  });

  test("(5) fora da janela sem template: UMA nota explicada e a sequência ENCERRA (sem step 2)", async () => {
    const CONV = 4307;
    // Última mensagem do cliente há 25h: fora da janela de 24h; pós-arm do Agente B (30d atrás).
    await seedConversation(CONV, inboxBId, {
      lastEventAt: new Date(Date.now() - 25 * HOUR),
      lastInboundAt: new Date(Date.now() - 25 * HOUR),
    });
    const s = stubClient(() => ({ id: CONV, status: "pending", meta: {} }));
    const result = await followUpHandler(jobFor(CONV), appDb, handlerDeps(s));

    // Sequência de 2 steps ENCERRADA no primeiro: done, não reschedule para o step 2.
    expect(result).toEqual({ outcome: "done" });
    // Nada foi ao cliente; a nota única sai EXPLICADA (o "amarelo" agora se explica sozinho).
    expect(s.sent).toEqual([]);
    expect(s.notes.length).toBe(1);
    expect(s.notes[0]?.[1].startsWith(OUTSIDE_WINDOW_NOTE_PREFIX)).toBe(true);
    expect(s.notes[0]?.[1]).toContain("Ainda posso ajudar?");
    // Stampado: o episódio conta como tratado, senão o próximo sweep re-abriria na hora.
    expect((await mirroredConv(CONV)).lastFollowUpAt).not.toBeNull();
  });

  test("(6) service: transições do estado efetivo armam followUpArmedAt", async () => {
    const armedOf = async (id: string) =>
      (
        await suDb.agent.findUniqueOrThrow({
          where: { id: BigInt(id) },
          select: { followUpArmedAt: true },
        })
      ).followUpArmedAt;

    // Create já efetivamente ON → armado desde a criação.
    const born = await createAgent(
      ctx(),
      {
        name: "Born armed",
        enabled: true,
        mode: "production",
        settings: { followUp: { enabled: true } },
      },
      appDb,
    );
    expect(await armedOf(born.id)).not.toBeNull();

    // Create default (test mode) SEM followUp → OFF de verdade → não armado.
    const off = await createAgent(ctx(), { name: "Off" }, appDb);
    expect(await armedOf(off.id)).toBeNull();

    // Create default (test mode) com followUp on → efetivo ON (o sweep admite conversas ativadas
    // com /teste, então modo teste também arma).
    const dormant = await createAgent(
      ctx(),
      { name: "Dormant", settings: { followUp: { enabled: true } } },
      appDb,
    );
    const armedAtCreate = await armedOf(dormant.id);
    expect(armedAtCreate).not.toBeNull();

    // test→production = PROMOÇÃO → re-arma (watermark novo): o conjunto elegível explode de
    // "ativadas com /teste" para toda pending — um watermark do período de teste exporia o
    // backlog histórico inteiro.
    await updateAgent(ctx(), BigInt(dormant.id), { mode: "production" }, appDb);
    const armed = await armedOf(dormant.id);
    expect(armed).not.toBeNull();
    expect((armed as Date).getTime()).toBeGreaterThan(
      (armedAtCreate as Date).getTime(),
    );

    // Save sem transição (rename) → watermark inalterado.
    await updateAgent(ctx(), BigInt(dormant.id), { name: "Renamed" }, appDb);
    expect((await armedOf(dormant.id))?.getTime()).toBe(
      (armed as Date).getTime(),
    );

    // Desliga e religa follow-up → re-arma (novo watermark, "daqui pra frente").
    await updateAgent(
      ctx(),
      BigInt(dormant.id),
      { settings: { followUp: { enabled: false } } },
      appDb,
    );
    expect((await armedOf(dormant.id))?.getTime()).toBe(
      (armed as Date).getTime(),
    );
    await updateAgent(
      ctx(),
      BigInt(dormant.id),
      { settings: { followUp: { enabled: true } } },
      appDb,
    );
    const rearmed = await armedOf(dormant.id);
    expect((rearmed as Date).getTime()).toBeGreaterThan(
      (armed as Date).getTime(),
    );

    // production→test (rebaixamento) NÃO re-arma: o conjunto elegível só encolhe; o watermark
    // vigente continua correto para as conversas ativadas com /teste.
    await updateAgent(ctx(), BigInt(dormant.id), { mode: "test" }, appDb);
    expect((await armedOf(dormant.id))?.getTime()).toBe(
      (rearmed as Date).getTime(),
    );
  });

  test("(6b) parseLiveConversation: AgentBot sem id numérico = ownership não verificável → null", async () => {
    const base = { id: 1, status: "pending" };
    // Shape unassigned (sem assignee_type/assignee) segue válido.
    expect(parseLiveConversation({ ...base, meta: {} })).toMatchObject({
      status: "pending",
      assigneeType: null,
      assigneeId: null,
    });
    // AgentBot com id numérico segue válido.
    expect(
      parseLiveConversation({
        ...base,
        meta: { assignee_type: "AgentBot", assignee: { id: 7, name: "Bot" } },
      }),
    ).toMatchObject({ assigneeType: "AgentBot", assigneeId: 7 });
    // AgentBot sem objeto assignee ou com id ilegível → null (o live gate vira
    // "live-unavailable" e re-tenta) — com assigneeId null, shouldBotHandle trataria a conversa
    // de OUTRO bot como nossa.
    expect(
      parseLiveConversation({ ...base, meta: { assignee_type: "AgentBot" } }),
    ).toBeNull();
    expect(
      parseLiveConversation({
        ...base,
        meta: { assignee_type: "AgentBot", assignee: { id: "not-a-number" } },
      }),
    ).toBeNull();
  });

  // ── Fiação HTTP real (mockup camada-transporte): ChatwootClient REAL + fetch fake que responde
  // com o shape FIEL do REST show (api/v1/conversations/partials/_conversation.json.jbuilder do
  // fork). Prova path, header de auth, token certo por chamada (admin no GET, bot no POST) e que
  // parseLiveConversation lê o payload verdadeiro — nada de stub de client. ──

  interface WireCall {
    method: string;
    url: string;
    token: string | null;
    body: unknown;
  }

  function wireFetch(conversationBody: () => Record<string, unknown>) {
    const calls: WireCall[] = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({
        method,
        url,
        token: headers.get("api-access-token"),
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (method === "GET" && /\/conversations\/\d+$/.test(url)) {
        return new Response(JSON.stringify(conversationBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/messages")) {
        return new Response("{}", { status: 200 });
      }
      // Chamadas best-effort (labels/kanban/atributos) degradam com warn — 404 é suficiente.
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  // Payload fiel ao jbuilder do fork: display_id em `id`, `status` no topo, `meta.assignee_type`
  // presente APENAS quando há assignee (o if do partial), timestamps int + campos que o parse ignora.
  function restShowPayload(
    convId: number,
    status: string,
    assignee: { id: number; name: string } | null,
  ): Record<string, unknown> {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      meta: {
        sender: {
          id: 501,
          name: "Cliente",
          phone_number: "+5511999990000",
          additional_attributes: {},
          custom_attributes: {},
        },
        channel: "Channel::Whatsapp",
        ...(assignee
          ? { assignee: { ...assignee, role: "agent" }, assignee_type: "User" }
          : {}),
        hmac_verified: false,
      },
      id: convId,
      database_id: 987_000 + convId,
      messages: [],
      account_id: 11,
      uuid: "3f6f9f0a-0000-0000-0000-000000000000",
      additional_attributes: {},
      agent_last_seen_at: nowSec,
      assignee_last_seen_at: 0,
      can_reply: false,
      contact_last_seen_at: nowSec,
      custom_attributes: {},
      inbox_id: INBOX_A,
      labels: [],
      muted: false,
      snoozed_until: null,
      status,
      created_at: nowSec - 90_000,
      updated_at: nowSec - 3600 + 0.42,
      timestamp: nowSec - 7200,
      first_reply_created_at: nowSec - 89_000,
      unread_count: 0,
    };
  }

  function wireDeps(fetchImpl: typeof fetch) {
    return {
      makeModel: () =>
        new FakeListChatModel({ responses: ["Oi! Ainda posso ajudar?"] }),
      // Client REAL construído com o config resolvido do banco (deployment baseUrl + tokens
      // descriptografados) — só o transporte é fake.
      makeClient: async (
        cfg: ConstructorParameters<typeof ChatwootClient>[0],
      ) => new ChatwootClient(cfg, fetchImpl),
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    };
  }

  test("(7) fiação real: GET com admin token no path certo; live resolved → aborta e reconcilia", async () => {
    const CONV = 4308;
    await seedConversation(CONV, inboxAId, {
      lastEventAt: new Date(Date.now() - 2 * HOUR),
      lastInboundAt: new Date(Date.now() - 2 * HOUR),
    });
    const w = wireFetch(() => restShowPayload(CONV, "resolved", null));
    const result = await followUpHandler(
      jobFor(CONV),
      appDb,
      wireDeps(w.fetchImpl),
    );
    expect(result).toEqual({ outcome: "done" });

    // O GET do live gate saiu no path do REST show, autenticado com o ADMIN token da deployment.
    const get = w.calls.find(
      (c) => c.method === "GET" && /\/conversations\/\d+$/.test(c.url),
    );
    expect(get).toBeDefined();
    expect(get?.url).toBe(`${accountBase}/conversations/${CONV}`);
    expect(get?.token).toBe("ADMIN");
    // Nenhuma mensagem/nota postada; espelho reconciliado com o payload real.
    expect(w.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect((await mirroredConv(CONV)).status).toBe("resolved");
  });

  test("(7b) fiação real: live pending fora da janela → POST da nota prefixada com bot token", async () => {
    const CONV = 4309;
    // Inbox B (agente armado há 30d): inbound 25h atrás = pós-arm E fora da janela de 24h.
    await seedConversation(CONV, inboxBId, {
      lastEventAt: new Date(Date.now() - 25 * HOUR),
      lastInboundAt: new Date(Date.now() - 25 * HOUR),
    });
    const w = wireFetch(() => restShowPayload(CONV, "pending", null));
    const result = await followUpHandler(
      jobFor(CONV),
      appDb,
      wireDeps(w.fetchImpl),
    );
    expect(result).toEqual({ outcome: "done" });

    const posts = w.calls.filter((c) => c.method === "POST");
    expect(posts.length).toBe(1);
    expect(posts[0]?.url).toBe(`${accountBase}/conversations/${CONV}/messages`);
    // A nota sai como o PERSONA bot (bot token), privada e explicada.
    expect(posts[0]?.token).toBe("BOT");
    const body = posts[0]?.body as {
      content?: string;
      private?: boolean;
    } | null;
    expect(body?.private).toBe(true);
    expect(body?.content?.startsWith(OUTSIDE_WINDOW_NOTE_PREFIX)).toBe(true);
  });
});
