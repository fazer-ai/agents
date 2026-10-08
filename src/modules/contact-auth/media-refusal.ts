import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  mediaRefusedHereThrough,
  rememberMediaRefusal,
} from "@/modules/contact-auth/state";

// The conversation's media refusal mark (`conversations.media_refused_through_message_id`): media of
// a message at or below it never reaches a provider (docs/contact-auth.md, "Media waits for the gate").

const WRITE_ATTEMPTS = 4;
const WRITE_BACKOFF_MS = 300;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Raises the conversation's media refusal mark to this message. Message ids are a per-account
// sequence, so everything at or below the mark arrived before that refusal. Retried; a write that still fails is kept in this process.
export async function recordMediaRefusal(
  tenantId: bigint,
  conversationDbId: bigint | null,
  messageId: number | null | undefined,
  base: PrismaClient,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  if (conversationDbId === null || messageId == null) return;
  const nap = sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const key = mediaRefusalKey(tenantId, conversationDbId);
  rememberMediaRefusal(key, messageId);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    try {
      await runScopedOn(
        base,
        sysCtx(tenantId),
        (db) =>
          db.$executeRaw`UPDATE conversations
          SET media_refused_through_message_id = GREATEST(COALESCE(media_refused_through_message_id, 0), ${messageId}::bigint)
          WHERE id = ${conversationDbId} AND tenant_id = ${tenantId}`,
      );
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < WRITE_ATTEMPTS) await nap(WRITE_BACKOFF_MS * attempt);
    }
  }
  logger.error(
    "chatwoot: the media refusal of message %d (conv=%s) was not recorded in %d attempts; this process still honours it, a restart does not: %s",
    messageId,
    String(conversationDbId),
    WRITE_ATTEMPTS,
    lastErr instanceof Error ? lastErr.message : String(lastErr),
  );
}

export function mediaRefusalKey(
  tenantId: bigint,
  conversationDbId: bigint,
): string {
  return `${tenantId}:${conversationDbId}`;
}

// The conversation's media refusal mark: the column, or the refusal this process could not write.
export async function mediaRefusedThrough(
  tenantId: bigint,
  conversationDbId: bigint,
  base: PrismaClient,
  stored?: bigint | null,
): Promise<number | null> {
  const column =
    stored !== undefined
      ? stored
      : ((
          await runScopedOn(base, sysCtx(tenantId), (db) =>
            db.conversation.findUnique({
              where: { id: conversationDbId },
              select: { mediaRefusedThroughMessageId: true },
            }),
          )
        )?.mediaRefusedThroughMessageId ?? null);
  const here = mediaRefusedHereThrough(
    mediaRefusalKey(tenantId, conversationDbId),
  );
  if (column === null) return here;
  return Math.max(Number(column), here ?? 0);
}

// A WATCHER's refusal (a monitoring agent's gate keeping it out of a conversation), kept apart from
// the conversation's mark above. Several watchers can observe one inbox, and each one's gate decides
// only what it observes: written on the conversation, one watcher's refusal would also keep media
// away from a sibling whose own gate let the conversation through. Kept in this process only, like
// the watcher's own allow for the same message: what it covers is the late `message_updated` of a
// refused audio, seconds after it, so that a yes given in between does not transcribe it.
export function watcherMediaRefusalKey(
  tenantId: bigint,
  conversationDbId: bigint,
  agentId: bigint,
): string {
  return `${mediaRefusalKey(tenantId, conversationDbId)}:watcher:${agentId}`;
}

export function recordWatcherMediaRefusal(
  tenantId: bigint,
  conversationDbId: bigint | null,
  agentId: bigint,
  messageId: number | null | undefined,
): void {
  if (conversationDbId === null || messageId == null) return;
  rememberMediaRefusal(
    watcherMediaRefusalKey(tenantId, conversationDbId, agentId),
    messageId,
  );
}

export function watcherMediaRefusedThrough(
  tenantId: bigint,
  conversationDbId: bigint | null,
  agentId: bigint,
): number | null {
  if (conversationDbId === null) return null;
  return mediaRefusedHereThrough(
    watcherMediaRefusalKey(tenantId, conversationDbId, agentId),
  );
}

export function refusedCovers(
  mark: number | null,
  messageId: number | null | undefined,
): boolean {
  return mark !== null && messageId != null && messageId <= mark;
}
