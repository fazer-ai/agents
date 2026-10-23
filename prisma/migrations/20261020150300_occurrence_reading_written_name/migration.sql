-- The canonical name a subject reading's copy last put in Chatwoot, kept across canonical merges, and
-- what Chatwoot may still hold from before the reading's current value (docs/occurrences.md,
-- "Canonical subjects"), and when the copy last failed, so a reading that keeps failing waits behind
-- the others instead of taking the round's batch every time.
BEGIN;

ALTER TABLE "conversation_readings" ADD COLUMN "written_name" TEXT;
ALTER TABLE "conversation_readings" ADD COLUMN "remote_before" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "conversation_readings" ADD COLUMN "copy_tried_at" TIMESTAMP(3);

COMMIT;
