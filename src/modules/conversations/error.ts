import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Conversation-level last-error bookkeeping (item 6). A failed agent turn stamps a sanitized error on
// the conversation so the operator gets a visible badge + a manual "re-engage" action; a successful
// turn clears it. Both are BEST-EFFORT and runtime-internal (sysCtx) — a bookkeeping failure must
// never mask the original error or break the reply path.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export async function recordConversationError(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  error: unknown;
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
        },
        data: {
          lastError: sanitizeErrorMessage(params.error),
          lastErrorAt: new Date(),
        },
      }),
    );
  } catch {
    // best-effort: never mask the original failure
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
