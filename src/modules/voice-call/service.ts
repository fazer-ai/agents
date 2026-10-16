// The product seam of a WhatsApp call a voice agent carries: which agent takes it (the
// inbox's voice route token in the stream URL), what it is told, and what goes back to Chatwoot once
// the call is over (the transcript and summary on the Call, the summary as a private note).

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { normalizeAgentMode } from "@/modules/agents/mode";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { hashRouteToken } from "@/modules/webhooks/inbound/route-token";
import type { CallRecord } from "./bridge";
import type { CallDirection, VoiceSessionConfig } from "./providers/types";

export interface VoiceRoute {
  tenantId: bigint;
  instanceId: bigint;
  // The Chatwoot inbox the call came to; null for a call from the playground.
  inboxId: number | null;
  agentId: bigint;
  agentName: string;
  systemPrompt: string;
}

export interface CallContext {
  conversationId: number | null;
  inboxId: number | null;
  direction: CallDirection;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN", actorType: "system" };
}

/**
 * The inbox and voice agent behind a call stream's route token (`Inbox.voiceRouteTokenHash`), or null
 * for an unknown token, a disconnected account, or an inbox whose calls no voice agent answers now.
 */
export async function resolveVoiceRoute(
  routeToken: string,
  base: PrismaClient = basePrisma,
): Promise<VoiceRoute | null> {
  const inbox = await asSuperAdminOn(base, (db) =>
    db.inbox.findUnique({
      where: { voiceRouteTokenHash: hashRouteToken(routeToken) },
      select: {
        tenantId: true,
        chatwootInstanceId: true,
        chatwootInboxId: true,
        voiceAgentId: true,
        instance: { select: { disconnectedAt: true } },
      },
    }),
  );
  if (
    !inbox ||
    inbox.voiceAgentId === null ||
    inbox.instance.disconnectedAt !== null
  )
    return null;
  const agentId = inbox.voiceAgentId;
  const agent = await runScopedOn(base, sysCtx(inbox.tenantId), (db) =>
    db.agent.findUnique({
      where: { id: agentId },
      select: {
        name: true,
        systemPrompt: true,
        enabled: true,
        kind: true,
        mode: true,
      },
    }),
  );
  if (
    !agent?.enabled ||
    agent.kind !== "voice" ||
    normalizeAgentMode(agent.mode) !== "production"
  )
    return null;
  return {
    tenantId: inbox.tenantId,
    instanceId: inbox.chatwootInstanceId,
    inboxId: inbox.chatwootInboxId,
    agentId,
    agentName: agent.name,
    systemPrompt: agent.systemPrompt,
  };
}

const VOICE_RULES = [
  "Você está numa ligação de voz pelo WhatsApp, não num chat.",
  "Fale português do Brasil, em frases curtas e naturais, uma ideia por vez, como numa ligação.",
  "Nunca use listas, markdown, links, emojis ou números de tópico: tudo o que você escreve vira fala.",
  "Diga valores, datas e horários por extenso do jeito que se fala.",
  "Se não entender, peça para a pessoa repetir. Se a pessoa pedir um atendente humano, diga que vai registrar o pedido e que alguém retorna pelo WhatsApp.",
  "Não chame a pessoa de senhor ou senhora: use o nome dela quando souber, ou fale sem tratamento.",
  "Nunca ofereça horário, valor ou informação que não esteja nestas instruções ou no retorno de uma ferramenta.",
  "Não anuncie que vai usar uma ferramenta: use e responda com o resultado.",
  "Quando a pessoa disser que não quer mais nada, que vai desligar, ou se despedir, despeça-se em uma frase curta e chame end_call nessa mesma resposta. Depois de se despedir, não cumprimente de novo.",
].join("\n");

const HISTORY_LIMIT = 20;

// A conversation in an inbox with no text agent was never delivered to this product, so it has no
// row: the agent's contact context and the tools that act on the contact read that row. Made here from
// the live read, as its first webhook would, and only when there is none, so a row the webhooks keep
// is never overwritten with this older read.
async function mirrorUnseen(
  route: VoiceRoute,
  conversationId: number,
  live: Record<string, unknown>,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const seen = await runScopedOn(base, sysCtx(route.tenantId), (db) =>
    db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: route.tenantId,
          chatwootInstanceId: route.instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: { id: true },
    }),
  );
  if (seen) return;
  const n = normalizeChatwootEvent({ ...live, event: "conversation_updated" });
  if (n) await mirrorChatwootEvent(route.tenantId, route.instanceId, n, base);
}

/**
 * The conversation the call names, kept only when Chatwoot says it is in the token's inbox: the token
 * opens one inbox, and its history, tools and the call's note reach that inbox's conversations only.
 * null when it is elsewhere or cannot be read, and the call goes on without one.
 */
export async function fenceConversation(
  route: VoiceRoute,
  conversationId: number | null,
  deps: LoadChatwootClientDeps & { base?: PrismaClient } = {},
): Promise<number | null> {
  if (!conversationId || route.inboxId === null) return null;
  try {
    const client = await loadChatwootClient(route.tenantId, route.instanceId, {
      base: deps.base,
      makeClient: deps.makeClient,
    });
    const conv = (await client.getConversation(conversationId)) as Record<
      string,
      unknown
    > | null;
    if (conv && Number(conv.inbox_id) === route.inboxId) {
      await mirrorUnseen(route, conversationId, conv, deps.base).catch(
        (err: Error) => {
          logger.warn(
            "voice-call: could not record conversation %d: %s",
            conversationId,
            err.message,
          );
        },
      );
      return conversationId;
    }
    logger.warn(
      "voice-call: conversation %d is not in inbox %d; the call goes on without it",
      conversationId,
      route.inboxId,
    );
  } catch (err) {
    logger.warn(
      "voice-call: could not read conversation %d: %s",
      conversationId,
      (err as Error).message,
    );
  }
  return null;
}

/** The conversation so far on WhatsApp, as lines the agent reads before the call: who said what. */
export async function conversationHistory(
  route: VoiceRoute,
  conversationId: number | null,
  deps: { base?: PrismaClient } = {},
): Promise<string> {
  if (!conversationId) return "";
  try {
    const client = await loadChatwootClient(route.tenantId, route.instanceId, {
      base: deps.base,
    });
    const messages = await client.listRecentMessages(conversationId);
    return messages
      .filter(
        (m) =>
          !m.private &&
          (m.message_type === 0 || m.message_type === 1) &&
          m.content?.trim(),
      )
      .slice(-HISTORY_LIMIT)
      .map(
        (m) =>
          `${m.message_type === 0 ? "Contato" : "Atendimento"}: ${m.content?.trim()}`,
      )
      .join("\n");
  } catch (err) {
    logger.warn(
      "voice-call: could not read the conversation history: %s",
      (err as Error).message,
    );
    return "";
  }
}

function nowInSaoPaulo(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const iso = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
  }).format(now);
  return `${parts}, ${iso}`;
}

/** The next two weeks with their weekdays: the model reads the date instead of computing it. */
function upcomingDays(now = new Date(), days = 14): string {
  const weekday = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const iso = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
  });
  const lines = Array.from({ length: days }, (_, i) => {
    const day = new Date(now.getTime() + i * 86_400_000);
    const label = i === 0 ? " (hoje)" : i === 1 ? " (amanhã)" : "";
    return `- ${weekday.format(day)}: ${iso.format(day)}${label}`;
  });
  return `Próximos dias (use estas datas, não calcule):\n${lines.join("\n")}`;
}

export function voiceSessionConfig(
  route: VoiceRoute,
  ctx: CallContext,
  voice?: string,
  history = "",
  openingDelayMs = 1_600,
): VoiceSessionConfig {
  const opening =
    ctx.direction === "outbound"
      ? "Você está LIGANDO para o contato. Assim que ele atender, apresente-se e diga o motivo da ligação."
      : "O contato ligou para você. Atenda com uma saudação curta, dizendo seu nome.";
  return {
    instructions: [
      route.systemPrompt,
      `# Ligação de voz\n${VOICE_RULES}\n${opening}\nAgora é ${nowInSaoPaulo()} (horário de Brasília).\n${upcomingDays()}`,
      history
        ? `# Conversa até agora no WhatsApp (mais recente por último)\n${history}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    greeting: "",
    opensCall: true,
    // Retell's begin_message_delay in the v3: who answers a call says "alô?" first, so a placed call
    // waits for it; a call to the clinic is answered at once, as a receptionist does.
    openingDelayMs: ctx.direction === "outbound" ? openingDelayMs : 300,
    language: "pt-BR",
    voice,
    direction: ctx.direction,
    variables: {},
  };
}

export function transcriptText(record: CallRecord, agentName: string): string {
  return record.transcript
    .map(
      (entry) =>
        `${entry.role === "agent" ? agentName : "Contato"}: ${entry.text}`,
    )
    .join("\n");
}

export interface ReportDeps {
  /** The summary of the call, or null when there is none to give. */
  summarize(record: CallRecord): Promise<string | null>;
  base?: PrismaClient;
  makeClient?: LoadChatwootClientDeps["makeClient"];
}

const NO_SUMMARY = "Resumo indisponível.";

// How far back the call's message is looked for: a page is about twenty messages, and a call's
// message is posted when it rings, so only what was written during the call sits in front of it.
const CALL_SEARCH_PAGES = 10;

async function callInConversation(
  client: ChatwootClient,
  conversationId: number,
  callId: string,
): Promise<boolean> {
  let before: number | undefined;
  try {
    for (let page = 0; page < CALL_SEARCH_PAGES; page++) {
      const body = (await client.getMessages(
        conversationId,
        before === undefined ? undefined : { before },
      )) as {
        payload?: Array<{ id?: number; call?: { provider_call_id?: string } }>;
      } | null;
      const messages = body?.payload ?? [];
      if (messages.some((m) => m.call?.provider_call_id === callId))
        return true;
      const ids = messages
        .map((m) => m.id)
        .filter((id): id is number => typeof id === "number");
      if (ids.length === 0) break;
      before = Math.min(...ids);
    }
  } catch (err) {
    logger.warn(
      "voice-call: could not read conversation %d: %s",
      conversationId,
      (err as Error).message,
    );
    return false;
  }
  logger.warn(
    "voice-call: call %s is not in conversation %d; its report is dropped",
    callId,
    conversationId,
  );
  return false;
}

/** Writes the call's outcome back to Chatwoot: transcript and summary on the Call, the summary as a note. */
export async function reportCall(
  route: VoiceRoute,
  ctx: CallContext,
  record: CallRecord,
  deps: ReportDeps,
) {
  // NOTE: a call nobody picked up has nothing to report; Chatwoot already files it as unanswered.
  if (!record.answeredAt) return null;
  const transcript = transcriptText(record, route.agentName);
  const summary =
    (await deps.summarize(record).catch((err: Error) => {
      logger.warn("voice-call: summary failed: %s", err.message);
      return null;
    })) ?? NO_SUMMARY;
  const bot = await loadAgentBot(
    route.tenantId,
    route.instanceId,
    route.agentId,
    deps.base,
  );
  const client = await loadChatwootClient(route.tenantId, route.instanceId, {
    base: deps.base,
    makeClient: deps.makeClient,
    botToken: bot?.accessToken ?? "",
  });
  // The fork finds the call by its id across the whole account, and the id comes from the stream:
  // it is reported only when the call is one of the fenced conversation's.
  if (
    record.callId &&
    ctx.conversationId &&
    (await callInConversation(client, ctx.conversationId, record.callId))
  ) {
    await client
      .reportVoiceCall({ provider_call_id: record.callId, transcript, summary })
      .catch((err: Error) => {
        logger.warn("voice-call: report to Chatwoot failed: %s", err.message);
      });
  }
  if (ctx.conversationId) {
    const minutes = record.answeredAt
      ? Math.max(
          1,
          Math.round(
            (Date.parse(record.endedAt) - Date.parse(record.answeredAt)) /
              60_000,
          ),
        )
      : 0;
    const header = `Ligação ${ctx.direction === "outbound" ? "feita" : "atendida"} por ${route.agentName}${minutes ? ` (${minutes} min)` : ""}`;
    await client
      .sendPrivateNote(ctx.conversationId, `${header}\n\n${summary}`)
      .catch((err: Error) => {
        logger.warn("voice-call: private note failed: %s", err.message);
      });
  }
  return { transcript, summary };
}
