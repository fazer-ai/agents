-- Inboxes no agent receives, read by the occurrences sweep (docs/occurrences.md, "Inboxes no agent
-- receives"). A conversation only the sweep knows of gets a row in `conversations` once, marked
-- `sweep_only`, which the conversation list and the dashboards leave out until a webhook mirrors it;
-- that moment changes what a kept day counts, so the conversation's dirty trigger watches the flag.
-- Each monitor keeps how far it has listed each such inbox, and its read queue what the listing showed
-- and what the reading covered. Prisma runs the file outside a transaction, so it opens its own.
-- The sweep's own job kind, added before the transaction: a new enum value cannot be used in the
-- transaction that adds it, and nothing here uses it.
ALTER TYPE "SchedulerJobKind" ADD VALUE IF NOT EXISTS 'OCCURRENCE_SWEEP';

BEGIN;

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "sweep_only" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "occurrence_conversation_reads" ADD COLUMN IF NOT EXISTS "swept_activity_at" TIMESTAMP(3);
ALTER TABLE "occurrence_conversation_reads" ADD COLUMN IF NOT EXISTS "read_swept_activity_at" TIMESTAMP(3);
ALTER TABLE "occurrence_conversation_reads" ADD COLUMN IF NOT EXISTS "swept_due_since" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "occurrence_sweep_cursors" (
    "tenant_id" BIGINT NOT NULL,
    "monitor_id" BIGINT NOT NULL,
    "inbox_id" BIGINT NOT NULL,
    "activity_at" TIMESTAMP(3),
    "swept_at" TIMESTAMP(3),
    "unlisted_at" TIMESTAMP(3),

    CONSTRAINT "occurrence_sweep_cursors_pkey" PRIMARY KEY ("monitor_id", "inbox_id")
);

CREATE INDEX IF NOT EXISTS "occurrence_sweep_cursors_tenant_id_idx" ON "occurrence_sweep_cursors"("tenant_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'occurrence_sweep_cursors_tenant_id_fkey') THEN
    ALTER TABLE "occurrence_sweep_cursors" ADD CONSTRAINT "occurrence_sweep_cursors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'occurrence_sweep_cursors_monitor_id_fkey') THEN
    ALTER TABLE "occurrence_sweep_cursors" ADD CONSTRAINT "occurrence_sweep_cursors_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "occurrence_monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'occurrence_sweep_cursors_inbox_id_fkey') THEN
    ALTER TABLE "occurrence_sweep_cursors" ADD CONSTRAINT "occurrence_sweep_cursors_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "inboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "occurrence_sweep_cursors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_sweep_cursors" FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'occurrence_sweep_cursors' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON "occurrence_sweep_cursors"
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'occurrence_sweep_cursors' AND policyname = 'fleet_super_admin') THEN
    EXECUTE format(
      'CREATE POLICY fleet_super_admin ON "occurrence_sweep_cursors" TO %I USING (true) WITH CHECK (true)',
      public.fazerai_fleet_role());
  END IF;
END $$;

CREATE OR REPLACE FUNCTION dashboard_dirty_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (now() AT TIME ZONE 'UTC') - interval '24 hours';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at < cutoff THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (NEW.tenant_id, NEW.id, NULL, NEW.created_at);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.created_at < cutoff THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (OLD.tenant_id, OLD.id, NULL, OLD.created_at);
    END IF;
  ELSIF (OLD.created_at < cutoff OR NEW.created_at < cutoff)
    AND (OLD.status, OLD.resolved_by, OLD.assignee_type, OLD.inbox_id, OLD.labels,
         OLD.last_inbound_at, OLD.chatwoot_created_at, OLD.chatwoot_first_reply_at,
         OLD.chatwoot_platform_reply_at, OLD.created_at, OLD.sweep_only)
        IS DISTINCT FROM
        (NEW.status, NEW.resolved_by, NEW.assignee_type, NEW.inbox_id, NEW.labels,
         NEW.last_inbound_at, NEW.chatwoot_created_at, NEW.chatwoot_first_reply_at,
         NEW.chatwoot_platform_reply_at, NEW.created_at, NEW.sweep_only) THEN
    -- Backdated from a day never kept into one that is, the conversation's new day is queued.
    INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
    VALUES (NEW.tenant_id, NEW.id, NULL,
            CASE WHEN OLD.created_at < cutoff THEN OLD.created_at ELSE NEW.created_at END);
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.thread_id IS DISTINCT FROM NEW.thread_id) THEN
    INSERT INTO dashboard_dirty (tenant_id, section, at)
    SELECT DISTINCT OLD.tenant_id, 'know', date_bin('15 minutes', q.created_at, TIMESTAMP '2000-01-01')
      FROM approval_queue_items q
     WHERE q.tenant_id = OLD.tenant_id AND q.thread_id = OLD.thread_id AND q.created_at < cutoff;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.thread_id IS DISTINCT FROM NEW.thread_id THEN
    INSERT INTO dashboard_dirty (tenant_id, section, at)
    SELECT DISTINCT NEW.tenant_id, 'know', date_bin('15 minutes', q.created_at, TIMESTAMP '2000-01-01')
      FROM approval_queue_items q
     WHERE q.tenant_id = NEW.tenant_id AND q.thread_id = NEW.thread_id AND q.created_at < cutoff;
  END IF;
  RETURN NULL;
END $$;

COMMIT;
