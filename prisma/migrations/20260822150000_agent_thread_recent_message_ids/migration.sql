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

-- `agent_threads` carries FORCE ROW LEVEL SECURITY, so tenant isolation applies to the table OWNER
-- too; only a superuser or a BYPASSRLS role is exempt. docs/deploy.md allows MIGRATION_DATABASE_URL
-- to be superuser OR db owner, and on managed Postgres the administrative role is typically the
-- owner WITHOUT rolsuper — where a bare UPDATE matches zero rows and reports success. That failure
-- mode is not hypothetical here: it is what 20260818120000 exists to repair on another table, and
-- it would land in exactly the place this backfill is protecting, leaving migrated threads looking
-- like fresh ones and re-appending old ids on a re-delivery.
--
-- Plain SET, not SET LOCAL: outside a transaction SET LOCAL is a no-op with only a warning, which
-- would reproduce the very silence this guards against.
SET app.is_super_admin = 'on';

UPDATE "agent_threads"
   SET "recent_synced_message_ids" = array_fill("last_synced_message_id", ARRAY[64])
 WHERE "last_synced_message_id" IS NOT NULL;

UPDATE "agent_threads"
   SET "recent_agent_message_ids" = array_fill("last_agent_message_id", ARRAY[64])
 WHERE "last_agent_message_id" IS NOT NULL;

RESET app.is_super_admin;
