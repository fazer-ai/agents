// The product seam of a WhatsApp call a voice agent carries: which agent takes it (the
// inbox's voice route token in the stream URL), what it is told, and what goes back to Chatwoot once
// the call is over (the transcript and summary on the Call, the summary as a private note).

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { normalizeAgentMode } from "@/modules/agents/mode";
import type { ChatwootClient, RecentMessage } from "@/modules/chatwoot/client";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { cleanTranscription } from "@/modules/chatwoot/render";
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
  "Nunca ofereça horário, valor ou informação que não esteja nestas instruções, na conversa do WhatsApp abaixo ou no retorno de uma ferramenta.",
  "Não anuncie que vai usar uma ferramenta: use e responda com o resultado.",
  "Quando a pessoa disser que não quer mais nada, que vai desligar, ou se despedir, despeça-se em uma frase curta e chame end_call nessa mesma resposta. Depois de se despedir, não cumprimente de novo.",
].join("\n");

// The call is from the contact of this conversation, and what was said there holds on the call: the
// agent answers from it instead of asking again for what the contact or the team already wrote.
// Measured on ElevenLabs' conversation simulation with gpt-4.1-mini at temperature 0, asking for an
// order number and date the conversation holds: the conversation after the voice rules was answered
// 0 times in 5 with this note and 0 in 5 without it moved alone; right after the agent's own prompt,
// with this note, 12 in 13, and an asked-for fact the conversation does not hold was not invented.
const HISTORY_NOTE =
  "Quem está ligando é o contato desta conversa, e você já sabe o que está escrito abaixo. Quando a pessoa perguntar algo que esta conversa responde (um número de pedido, um prazo, o que a equipe disse), responda com isso na hora. Não peça nome, número nem outro dado para localizar o que já está aqui.";

const HISTORY_LIMIT = 20;

// The conversation as Chatwoot has it now, mirrored the way a webhook would be: on an inbox with no
// text agent no webhook ever arrives, and the agent's contact context and its contact tools read this
// row. Every call refreshes it, and the mirror's staleness rule keeps a newer delivery from being
// overwritten by this read.
async function mirrorLive(
  route: VoiceRoute,
  live: Record<string, unknown>,
  base: PrismaClient = basePrisma,
): Promise<void> {
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
      await mirrorLive(route, conv, deps.base).catch((err: Error) => {
        logger.warn(
          "voice-call: could not record conversation %d: %s",
          conversationId,
          err.message,
        );
      });
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

/**
 * What a message says: its text, or the words of the voice note it carries, which the REST list puts
 * on the audio attachment's `meta.transcribed_text`, with an empty `content`.
 */
function said(m: RecentMessage): string {
  const text = m.content?.trim();
  if (text) return text;
  const audio = m.attachments?.find((a) => a.file_type === "audio");
  return cleanTranscription(audio?.meta?.transcribed_text ?? "");
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
        (m) => !m.private && (m.message_type === 0 || m.message_type === 1),
      )
      .map((m) => ({
        who: m.message_type === 0 ? "Contato" : "Atendimento",
        text: said(m),
      }))
      .filter((m) => m.text)
      .slice(-HISTORY_LIMIT)
      .map((m) => `${m.who}: ${m.text}`)
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
      // Before the voice rules: placed after them, the model asked for what the conversation held.
      history
        ? `# Conversa até agora no WhatsApp (mais recente por último)\n${HISTORY_NOTE}\n${history}`
        : "",
      `# Ligação de voz\n${VOICE_RULES}\n${opening}\nAgora é ${nowInSaoPaulo()} (horário de Brasília).\n${upcomingDays()}`,
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
      .sendPrivateNote(
        ctx.conversationId,
        literalForChatwoot(`${header}\n\n${summary}`),
      )
      .catch((err: Error) => {
        logger.warn("voice-call: private note failed: %s", err.message);
      });
  }
  return { transcript, summary };
}
