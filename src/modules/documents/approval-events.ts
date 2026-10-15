import logger from "@/api/lib/logger";
import { parseDbId } from "@/lib/db-id";
import type { ScopedDb } from "@/lib/tenancy";
import {
  emitOutbound,
  emitOutboundMany,
  type OutboundEvent,
} from "@/modules/webhooks/outbound/service";

// The outbound events of a document approval request, emitted inside the transaction that makes the
// change and under a savepoint: a failed statement aborts the whole transaction in Postgres, so
// catching the error alone would roll back the decision being announced. Ids, statuses and times
// only: the reviewer's note and the document's values are team and customer text. Every event
// carries the conversation twice: `conversation_id` is our `Conversation` row, as in `conversation.*`,
// and `chatwoot_conversation_id` is the number an app that only sees Chatwoot knows it by.

export type DecidedStatus = "approved" | "rejected" | "expired";

const id = (v: bigint | null | undefined): string | null =>
  v == null ? null : String(v);

export function requestedData(r: {
  id: bigint;
  templateId: bigint | null;
  conversationId: bigint | null;
  expiresAt: Date;
}): Record<string, unknown> {
  return {
    request_id: String(r.id),
    template_id: id(r.templateId),
    conversation_id: id(r.conversationId),
    expires_at: r.expiresAt.toISOString(),
    status: "pending",
  };
}

export function decidedData(r: {
  id: bigint;
  conversationId: bigint | null;
  status: DecidedStatus;
  reviewerUserId: bigint | null;
  issuedDocumentId: bigint | null;
  decidedAt: Date;
}): Record<string, unknown> {
  return {
    request_id: String(r.id),
    conversation_id: id(r.conversationId),
    status: r.status,
    reviewer_user_id: id(r.reviewerUserId),
    issued_document_id: id(r.issuedDocumentId),
    decided_at: r.decidedAt.toISOString(),
  };
}

export function outcomeData(r: {
  id: bigint;
  conversationId: bigint | null;
  outcome: string;
}): Record<string, unknown> {
  return {
    request_id: String(r.id),
    conversation_id: id(r.conversationId),
    outcome: r.outcome.toLowerCase(),
  };
}

// Adds `chatwoot_conversation_id` right after `conversation_id`, read in the same transaction, with
// an explicit null when the request has no conversation.
async function withChatwootIds(
  db: ScopedDb,
  items: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const ids = [
    ...new Set(
      items
        .map((i) => i.conversation_id)
        .filter((v): v is string => typeof v === "string"),
    ),
  ];
  const rows =
    ids.length === 0
      ? []
      : await db.conversation.findMany({
          where: {
            id: {
              in: ids
                .map((v) => parseDbId(v))
                .filter((v): v is bigint => v !== null),
            },
          },
          select: { id: true, chatwootConversationId: true },
        });
  const byId = new Map(
    rows.map((r) => [String(r.id), String(r.chatwootConversationId)]),
  );
  return items.map((item) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
      out[k] = v;
      if (k === "conversation_id")
        out.chatwoot_conversation_id =
          typeof v === "string" ? (byId.get(v) ?? null) : null;
    }
    return out;
  });
}

async function underSavepoint(
  db: ScopedDb,
  event: OutboundEvent,
  emit: () => Promise<unknown>,
): Promise<void> {
  await db.$executeRawUnsafe("SAVEPOINT announce_document_approval");
  try {
    await emit();
    await db.$executeRawUnsafe("RELEASE SAVEPOINT announce_document_approval");
  } catch (err) {
    await db.$executeRawUnsafe(
      "ROLLBACK TO SAVEPOINT announce_document_approval",
    );
    logger.warn(
      "outbound emit failed (event=%s): %s",
      event,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function announceApprovalEvent(
  db: ScopedDb,
  tenantId: bigint,
  event: OutboundEvent,
  data: Record<string, unknown>,
): Promise<void> {
  return underSavepoint(db, event, async () => {
    const [enriched] = await withChatwootIds(db, [data]);
    await emitOutbound(db, tenantId, event, enriched ?? data);
  });
}

export function announceApprovalEvents(
  db: ScopedDb,
  tenantId: bigint,
  event: OutboundEvent,
  items: readonly Record<string, unknown>[],
): Promise<void> {
  if (items.length === 0) return Promise.resolve();
  return underSavepoint(db, event, async () =>
    emitOutboundMany(db, tenantId, event, await withChatwootIds(db, items)),
  );
}
