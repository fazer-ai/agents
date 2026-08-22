-- Issue #194: within one direction the ingestion ids also arrive out of order, and a high-water mark
-- read the later-arriving lower id as already handled. Membership decides a re-delivery now; the
-- scalar watermarks stay as "how far we got".
--
-- Backfill seeds each row with the mark it already had, so an upgrade does not re-append the message
-- that was in flight when it happened: on the old build that id was the mark, and here it has to
-- read as already ingested rather than as unknown.
ALTER TABLE "agent_threads"
  ADD COLUMN "recent_synced_message_ids" INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN "recent_agent_message_ids"  INTEGER[] NOT NULL DEFAULT '{}';

UPDATE "agent_threads"
   SET "recent_synced_message_ids" = ARRAY["last_synced_message_id"]
 WHERE "last_synced_message_id" IS NOT NULL;

UPDATE "agent_threads"
   SET "recent_agent_message_ids" = ARRAY["last_agent_message_id"]
 WHERE "last_agent_message_id" IS NOT NULL;
