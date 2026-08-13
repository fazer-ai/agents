import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type LoadChatwootClientDeps,
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
  try {
    return await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
      // Read before the write: the stamp we are about to overwrite is what says whether this
      // conversation already announced a failure recently.
      const previous = await db.conversation.findFirst({
        where,
        select: { lastErrorAt: true },
      });
      await db.conversation.updateMany({
        where,
        data: {
          lastError: sanitizeErrorMessage(params.error),
          lastErrorAt: new Date(),
        },
      });
      const previousAt = previous?.lastErrorAt?.getTime();
      return {
        announce:
          previousAt === undefined ||
          Date.now() - previousAt >= FAILURE_NOTE_COOLDOWN_MS,
      };
    });
  } catch {
    // best-effort: never mask the original failure
    return { announce: false };
  }
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
    const client = await loadChatwootClient(
      params.tenantId,
      params.instanceId,
      {
        base: params.base,
        makeClient: params.makeClient,
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
