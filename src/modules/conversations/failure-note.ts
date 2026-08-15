import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  maxIncomingId,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";

// A turn that dies leaves the customer with no reply, and the only traces are an `error` line in
// `execution_logs`, `Conversation.lastError` in our console, and an `AlertChannel` dispatch when one
// is configured. None of those is open in front of the person working the inbox, so a dead turn is
// indistinguishable from an agent that chose to stay silent. This posts a private note (agents see
// it, the customer does not) saying so.
//
// The hard part is not the note: it is knowing when the turn is DEFINITIVELY lost. The note tells an
// operator to take over, and taking over closes `shouldBotHandle` — the gate a pending retry depends
// on — so a premature note causes the failure it reports. Hence the rule below, and hence the fact
// that this is NOT called from the handlers' catch blocks (issue #71):
//
//   * a job that will be retried is not lost, so the announcement hangs off the DEAD-LETTER event
//     rather than off the failure. `failJob` reports whether its CAS actually dead-lettered, which
//     also covers the flush that was re-armed mid-run (`armDebounce` upserts the CLAIMED row back to
//     PENDING, the CAS then matches nothing, and another flush is already queued). The DEAD row can
//     be re-armed AFTER that too, so the state is re-read at announce time (see `assess` below);
//   * on the direct webhook path there is no job and no retry, so what has to be excluded is a NEWER
//     message whose own turn may still answer — the same supersede fence the success path applies at
//     `shouldPost`. A fence that cannot be read is `unknown`, and unknown does not announce: the cost
//     of a missing note is an operator who finds out from the console, the cost of a wrong one is a
//     conversation taken over while its answer was still coming.

export type TurnFailure =
  // A scheduler job. `deadLettered` is the CAS result, not the attempt count: only the statement that
  // actually moved the row to DEAD may claim the turn is over.
  | { path: "job"; deadLettered: boolean }
  // The direct path. `clear` = no newer incoming message exists, so nothing else will answer;
  // `superseded` = one does; `unknown` = the fence could not be read.
  | { path: "direct"; fence: "clear" | "superseded" | "unknown" };

export function isTurnLost(f: TurnFailure): boolean {
  return f.path === "job" ? f.deadLettered : f.fence === "clear";
}

// The direct path's fence, read the same way the success path reads it at `shouldPost`: a newer
// incoming message than the one this turn was triggered by means another turn is coming for it, and
// that turn may well answer. Admin-token read (same as the flush's re-fetch), so it does not depend
// on the persona bot resolving.
export async function readDirectFence(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  triggerId: number | null;
  base?: PrismaClient;
  deps?: LoadChatwootClientDeps;
}): Promise<"clear" | "superseded" | "unknown"> {
  // NOTE: No trigger message (a non-message event, or a payload without one) means there is nothing
  // to compare against, so the fence cannot say anything and the turn is not announced.
  if (params.triggerId === null) return "unknown";
  try {
    const client = await loadChatwootClient(
      params.tenantId,
      params.instanceId,
      {
        ...params.deps,
        base: params.base ?? basePrisma,
      },
    );
    const latest = parseChatwootMessages(
      await client.getMessages(params.chatwootConversationId),
    );
    return maxIncomingId(latest, params.triggerId) > params.triggerId
      ? "superseded"
      : "clear";
  } catch (err) {
    logger.warn(
      "conversations: failed-turn fence unreadable (conv=%s): %s",
      String(params.chatwootConversationId),
      err instanceof Error ? err.message : String(err),
    );
    return "unknown";
  }
}

// One announcement per conversation per window. A provider outage burns through every conversation
// in an inbox, and an inbox buried in identical notes is the same as no notes at all.
export const FAILURE_NOTICE_COOLDOWN_MS = 30 * 60_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Elects the single announcer, atomically. Two concurrent failures on one conversation both read the
// same pre-failure stamp, so a read-then-write cooldown lets both through; the claim therefore IS the
// write — whoever's conditional UPDATE matches the row gets the note, and the other sees 0 rows.
//
// NOTE: A claim whose post then fails keeps the stamp, so that conversation stays quiet for the rest
// of the window. That direction is deliberate: the failure mode of a post is a Chatwoot that is down,
// where a re-claim would not deliver anything either, and releasing the claim is exactly how one
// failed turn becomes two notes once it comes back.
export async function claimFailureNotice(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  now?: Date;
  cooldownMs?: number;
  base?: PrismaClient;
}): Promise<boolean> {
  const base = params.base ?? basePrisma;
  const now = params.now ?? new Date();
  const cooldownMs = params.cooldownMs ?? FAILURE_NOTICE_COOLDOWN_MS;
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { count } = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.conversation.updateMany({
      where: {
        tenantId: params.tenantId,
        chatwootInstanceId: params.instanceId,
        chatwootConversationId: params.chatwootConversationId,
        OR: [
          { failureNoticeSentAt: null },
          { failureNoticeSentAt: { lt: cutoff } },
        ],
      },
      data: { failureNoticeSentAt: now },
    }),
  );
  return count > 0;
}

// The persona whose conversation this is, so the note is posted AS the agent the operator sees on the
// inbox. `loadChatwootClient` defaults the bot token to "" and Chatwoot answers 401, which a
// best-effort catch swallows — a note that never posts at all. The bot comes from the conversation's
// inbox (`Inbox.agentId`), the same resolution the console does.
async function personaBotToken(
  tenantId: bigint,
  instanceId: bigint,
  chatwootConversationId: number,
  base: PrismaClient,
): Promise<string | null> {
  const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findFirst({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId,
      },
      select: { inbox: { select: { agentId: true } } },
    }),
  );
  const agentId = conv?.inbox?.agentId;
  if (agentId == null) return null;
  const bot = await loadAgentBot(tenantId, instanceId, agentId, base);
  return bot?.accessToken ?? null;
}

function noteText(reason: string): string {
  return [
    "⚠️ Não consegui responder a esta conversa.",
    "Um atendente humano precisa assumir.",
    `Motivo: ${reason}`,
  ].join("\n\n");
}

// Best-effort from end to end: a Chatwoot that is down must never turn one failed turn into two.
//
// `assess` is deliberately a callback rather than a value. The failure and the announcement are
// separated by database and network work, and a message arriving in that gap starts a direct turn or
// re-arms the DEAD debounce row back to PENDING — so a snapshot taken at failure time can announce
// over work that is already live, which is the one outcome this whole module exists to avoid. It is
// therefore called as late as it can be, right before the claim, and after the reads that could fail
// for their own reasons (resolving the persona bot burns nothing when it comes back empty).
//
// What remains is the claim→post gap, which is irreducible: Chatwoot is the source of truth for
// "another message arrived" and we cannot hold a lock across it.
export async function announceFailedTurn(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  assess: () => Promise<TurnFailure>;
  error: unknown;
  now?: Date;
  cooldownMs?: number;
  base?: PrismaClient;
  deps?: LoadChatwootClientDeps;
}): Promise<"posted" | "not-lost" | "coalesced" | "failed"> {
  const base = params.base ?? basePrisma;
  const {
    tenantId,
    instanceId,
    chatwootConversationId: conversationId,
  } = params;
  try {
    const botToken = await personaBotToken(
      tenantId,
      instanceId,
      conversationId,
      base,
    );
    if (botToken === null) {
      logger.warn(
        "conversations: no persona bot to announce a failed turn as (conv=%s)",
        String(conversationId),
      );
      return "failed";
    }
    if (!isTurnLost(await params.assess())) return "not-lost";
    if (
      !(await claimFailureNotice({
        tenantId,
        instanceId,
        chatwootConversationId: conversationId,
        now: params.now,
        cooldownMs: params.cooldownMs,
        base,
      }))
    ) {
      return "coalesced";
    }
    const client = await loadChatwootClient(tenantId, instanceId, {
      ...params.deps,
      base,
      botToken,
    });
    await client.sendPrivateNote(
      conversationId,
      noteText(sanitizeErrorMessage(params.error)),
    );
    return "posted";
  } catch (err) {
    logger.warn(
      "conversations: failed-turn note not posted (conv=%s): %s",
      String(conversationId),
      err instanceof Error ? err.message : String(err),
    );
    return "failed";
  }
}
