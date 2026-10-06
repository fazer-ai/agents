-- What the suggestion reviewer reads and writes on an approval-queue item, and the key that folds a
-- proposal repeated for the same base onto the item already there. No backfill: rows written
-- before this keep NULL in every new column, so they never collide on the key and are never a
-- candidate for a review, and everything else about them (approve, edit, reject) is unchanged.
BEGIN;

ALTER TABLE "approval_queue_items"
  ADD COLUMN "normalized_hash" TEXT,
  ADD COLUMN "embedding" vector(1536),
  ADD COLUMN "agent_id" BIGINT,
  ADD COLUMN "reviewer_comment" TEXT,
  ADD COLUMN "replaces_document_id" BIGINT,
  ADD COLUMN "matched_item_id" BIGINT,
  ADD COLUMN "matched_document_id" BIGINT,
  ADD COLUMN "rejection_reason" TEXT;

CREATE UNIQUE INDEX "approval_queue_items_suggestion_key"
    ON "approval_queue_items"("tenant_id", "knowledge_base_id", "normalized_hash");

-- The key leads with tenant_id, so it serves every lookup the bare index answered.
DROP INDEX "approval_queue_items_tenant_id_idx";

COMMIT;
