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
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  followUpHandler,
  registerFollowUpHandlers,
} from "@/modules/followups/handlers";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// Guardrails da cadeia "follow-up em conversa resolvida" (post da comunidade "Followup indo como
// conversa privada", 2026-08-06). O incidente: espelho local preso em `pending` (resolve perdido /
// entrega fora de ordem) → sweep enfileira FOLLOWUP para conversas que o Chatwoot real já resolveu
// → nudge posta o texto como nota privada (fora da janela de 24h sem template), em massa, para a
// base histórica. Cada teste aqui trava uma das defesas:
//   (1) mirror: mensagem não-incoming não regride resolved→pending (reaberturas legítimas seguem);
//   (2) live gate: o handler verifica o estado REAL no Chatwoot antes de postar e reconcilia o
//       espelho stale (fail-closed quando não dá para verificar);
//   (3) watermark de ativação: o sweep só inicia sequência para episódios pós-arm;
//   (4) nota fora-da-janela explicada + encerra a sequência;
//   (5) transições OFF→ON do estado efetivo armam Agent.followUpArmedAt no service.

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
  };
}

function convPayload(
  convId: number,
  inboxId: number,
  over: { status: string; lastActivityAt: number },
) {
  return {
    id: convId,
    inbox_id: inboxId,
    status: over.status,
    contact_inbox: { id: 88_000 + convId },
    meta: {
      assignee_type: null,
      assignee: null,
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
  },
) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      inboxId: inboxDbId,
      status: over.status ?? "pending",
      assigneeType: null,
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
    expect((await mirroredConv(CONV)).status).toBe("resolved");

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
      // Payload omitido ⇒ o scheduler preserva o payload atual (mesmo step).
      expect(result.payload).toBeUndefined();
    }
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
    expect((await mirroredConv(CONV)).lastFollowUpAt).toBeNull();
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
      { id: 99n, tenantId, kind: "FOLLOWUP_SWEEP", payload: {}, attempts: 0 },
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

    // Create default (test mode) → OFF → não armado.
    const dormant = await createAgent(
      ctx(),
      { name: "Dormant", settings: { followUp: { enabled: true } } },
      appDb,
    );
    expect(await armedOf(dormant.id)).toBeNull();

    // test→production com followUp on = transição OFF→ON → arma.
    const before = Date.now();
    await updateAgent(ctx(), BigInt(dormant.id), { mode: "production" }, appDb);
    const armed = await armedOf(dormant.id);
    expect(armed).not.toBeNull();
    expect((armed as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);

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
    expect((rearmed as Date).getTime()).toBeGreaterThanOrEqual(
      (armed as Date).getTime(),
    );
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
