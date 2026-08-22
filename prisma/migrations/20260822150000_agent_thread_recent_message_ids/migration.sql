-- Issue #194: within one direction the ingestion ids also arrive out of order, and a high-water mark
-- read the later-arriving lower id as already handled. Membership decides a re-delivery now; the
-- scalar watermarks stay as "how far we got".
--
-- Backfill seeds each row SATURATED with the mark it already had, and the saturation is the point.
-- `ingestVerdict` refuses an id below the oldest one a FULL window holds and accepts anything a
-- partial window does not name — correct for a thread that has always had a window, and wrong for a
-- migrated one, where the ids below the mark were ingested by the old build and simply are not
-- remembered. Seeded with a single element, every one of those would have read as new and been
-- appended a second time on a re-delivery. Filled to the cap, the mark IS the floor, which is
-- exactly the old behaviour, and each real ingest pushes one filler out until the window is genuine
-- history within a cap's worth of messages.
ALTER TABLE "agent_threads"
  ADD COLUMN "recent_synced_message_ids" INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN "recent_agent_message_ids"  INTEGER[] NOT NULL DEFAULT '{}';

UPDATE "agent_threads"
   SET "recent_synced_message_ids" = array_fill("last_synced_message_id", ARRAY[64])
 WHERE "last_synced_message_id" IS NOT NULL;

UPDATE "agent_threads"
   SET "recent_agent_message_ids" = array_fill("last_agent_message_id", ARRAY[64])
 WHERE "last_agent_message_id" IS NOT NULL;
