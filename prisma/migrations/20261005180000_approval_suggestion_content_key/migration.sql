-- A conversation that proposes the same knowledge entry again lands on the row it already has
-- (issue #578): the observer's tick is stateless and rereads the whole conversation, so every burst
-- proposed the same rule anew. The key is tenant, thread, target base and the sha256 of the proposed
-- content; the title is out of it because the model rewords it between proposals, and the base is in
-- it because the same text proposed for two bases is two entries.
--
-- Rows written before the key: the first of each (tenant, thread, base, content) gets its hash, so a new
-- proposal collapses onto it, and the later copies keep NULL, which never collides, so the index
-- builds over a queue that already holds duplicates. A row with no thread (the REST route) gets its
-- hash and never collides either.
--
-- FORCE ROW LEVEL SECURITY binds the table owner, whose UPDATE would reach zero rows and report
-- success. Lifted for the backfill and put back (.claude/rules/prisma.md), inside the file's own
-- transaction so a failure cannot leave the table without FORCE.
BEGIN;

ALTER TABLE "approval_queue_items" ADD COLUMN "content_hash" TEXT;

ALTER TABLE "approval_queue_items" NO FORCE ROW LEVEL SECURITY;

UPDATE "approval_queue_items" AS a
   SET "content_hash" = r.hash
  FROM (
    SELECT "id", "thread_id",
           encode(sha256(convert_to("proposed_content", 'UTF8')), 'hex') AS hash,
           row_number() OVER (
             PARTITION BY "tenant_id", "thread_id", "knowledge_base_id",
                          encode(sha256(convert_to("proposed_content", 'UTF8')), 'hex')
             ORDER BY "id"
           ) AS rn
      FROM "approval_queue_items"
  ) AS r
 WHERE a."id" = r."id"
   AND (r."thread_id" IS NULL OR r.rn = 1);

ALTER TABLE "approval_queue_items" FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX "approval_queue_items_suggestion_key"
    ON "approval_queue_items"("tenant_id", "thread_id", "knowledge_base_id", "content_hash");

-- The key leads with tenant_id, so it serves every lookup the bare index answered.
DROP INDEX "approval_queue_items_tenant_id_idx";

COMMIT;
