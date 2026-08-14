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

// Conversation-level last-error bookkeeping (item 6). A failed agent turn stamps a sanitized error on
// the conversation so the operator gets a visible badge + a manual "re-engage" action; a successful
// turn clears it. Both are BEST-EFFORT and runtime-internal (sysCtx) — a bookkeeping failure must
// never mask the original error or break the reply path.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// NOTE: the badge lives in OUR console, which nobody has open while they work the inbox. A turn
// that ends without a reply is indistinguishable there from one the agent chose to stay silent on
// (issue #63), so the failure is also announced where the team actually is — as a private note on
// the Chatwoot conversation. One per conversation per window: a provider outage fails every turn of
// every live conversation, and a note per failure would bury the inbox at the exact moment it needs
// to be readable. The previous stamp is the coalescing key, so this needs no new column.
const FAILURE_NOTE_COOLDOWN_MS = 30 * 60_000;

export interface RecordedConversationError {
  // True when this failure is the first of its window, i.e. worth announcing in Chatwoot.
  announce: boolean;
}

export async function recordConversationError(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  error: unknown;
  base?: PrismaClient;
}): Promise<RecordedConversationError> {
  const base = params.base ?? basePrisma;
  const where = {
    tenantId: params.tenantId,
    chatwootInstanceId: params.instanceId,
    chatwootConversationId: params.chatwootConversationId,
  };
  const now = new Date();
  const lastError = sanitizeErrorMessage(params.error);
  try {
    return await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
      // Claim the announcement in the SAME statement that stamps the error. Reading the previous
      // stamp and then writing lets two failures on one conversation both see the old value and both
      // announce, which is precisely what the window exists to prevent — and concurrent turns on one
      // conversation are ordinary here (a burst with debounce off is one webhook delivery each).
      // Postgres re-evaluates this WHERE against the row the winner just wrote (READ COMMITTED), so
      // the loser matches nothing.
      const claimed = await db.conversation.updateMany({
        where: {
          ...where,
          OR: [
            { lastErrorAt: null },
            {
              lastErrorAt: {
                lt: new Date(now.getTime() - FAILURE_NOTE_COOLDOWN_MS),
              },
            },
          ],
        },
        data: { lastError, lastErrorAt: now },
      });
      if (claimed.count > 0) return { announce: true };
      // Lost the claim (or nothing to claim): the stamp still has to move. `lastErrorAt` is the
      // console's "when did this conversation last fail", not a window anchor, and freezing it here
      // would age the badge while the conversation is actively failing.
      await db.conversation.updateMany({
        where,
        data: { lastError, lastErrorAt: now },
      });
      return { announce: false };
    });
  } catch {
    // best-effort: never mask the original failure
    return { announce: false };
  }
}

// The bot whose turn failed, resolved from the conversation's inbox (`Inbox.agentId`) rather than
// from the caller: the two call sites reach this catch with different things in scope, and a token
// threaded through one of them would leave the other posting with none.
async function conversationBotToken(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  base?: PrismaClient;
}): Promise<string | null> {
  const base = params.base ?? basePrisma;
  const agentId = await runScopedOn(
    base,
    sysCtx(params.tenantId),
    async (db) => {
      const conv = await db.conversation.findFirst({
        where: {
          tenantId: params.tenantId,
          chatwootInstanceId: params.instanceId,
          chatwootConversationId: params.chatwootConversationId,
        },
        select: { inbox: { select: { agentId: true } } },
      });
      return conv?.inbox?.agentId ?? null;
    },
  );
  if (agentId == null) return null;
  const bot = await loadAgentBot(
    params.tenantId,
    params.instanceId,
    agentId,
    base,
  );
  return bot?.accessToken ?? null;
}

// Announces an unrecoverable turn on the conversation itself, as a private note (agents see it, the
// customer does not). Best-effort from end to end: a Chatwoot that is down must not turn a failed
// turn into a second failure. Call it only when recordConversationError said to announce.
export async function postTurnFailureNote(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  error: unknown;
  base?: PrismaClient;
  makeClient?: LoadChatwootClientDeps["makeClient"];
}): Promise<void> {
  try {
    // `sendPrivateNote` authenticates with the PERSONA BOT token (it posts through `sendMessage`),
    // and `loadChatwootClient` defaults that token to "". A client built without it gets a 401 from
    // Chatwoot and the announcement disappears into the catch below — the note would never reach a
    // single inbox. The persona comes from the conversation's inbox, the same resolution the console
    // uses for its own bot-token actions.
    const botToken = await conversationBotToken(params);
    if (!botToken) {
      logger.warn(
        { conversationId: params.chatwootConversationId },
        "turn failure note skipped: the inbox has no persona bot to post as",
      );
      return;
    }
    const client = await loadChatwootClient(
      params.tenantId,
      params.instanceId,
      {
        base: params.base,
        makeClient: params.makeClient,
        botToken,
      },
    );
    // NOTE: pt-BR fixed, matching the other product-generated notes (src/graph/tools/native.ts).
    // The reason is already sanitized (secret-scrubbed and length-bounded) by the same helper that
    // writes Conversation.lastError.
    await client.sendPrivateNote(
      params.chatwootConversationId,
      `⚠️ O agente não conseguiu responder a esta mensagem e a tentativa se esgotou, então o cliente ficou sem resposta. Um atendente humano precisa assumir.\n\nMotivo: ${sanitizeErrorMessage(params.error)}`,
    );
  } catch (err) {
    logger.warn(
      { err, conversationId: params.chatwootConversationId },
      "turn failure note could not be posted",
    );
  }
}

export async function clearConversationError(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  try {
    await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.conversation.updateMany({
        where: {
          tenantId: params.tenantId,
          chatwootInstanceId: params.instanceId,
          chatwootConversationId: params.chatwootConversationId,
          NOT: { lastError: null },
        },
        data: { lastError: null, lastErrorAt: null },
      }),
    );
  } catch {
    // best-effort
  }
}
