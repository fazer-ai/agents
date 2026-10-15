import logger from "@/api/lib/logger";
import type { ScopedDb } from "@/lib/tenancy";
import {
  emitOutbound,
  emitOutboundMany,
  type OutboundEvent,
} from "@/modules/webhooks/outbound/service";

// The outbound events of a document approval request, emitted inside the transaction that makes the
// change and under a savepoint: a failed statement aborts the whole transaction in Postgres, so
// catching the error alone would roll back the decision being announced. Ids, statuses and times
// only: the reviewer's note and the document's values are team and customer text.

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
  return underSavepoint(db, event, () =>
    emitOutbound(db, tenantId, event, data),
  );
}

export function announceApprovalEvents(
  db: ScopedDb,
  tenantId: bigint,
  event: OutboundEvent,
  items: readonly Record<string, unknown>[],
): Promise<void> {
  if (items.length === 0) return Promise.resolve();
  return underSavepoint(db, event, () =>
    emitOutboundMany(db, tenantId, event, items),
  );
}
