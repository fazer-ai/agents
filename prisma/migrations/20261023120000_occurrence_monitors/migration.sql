-- Several occurrence monitors per account (docs/occurrences.md, "Monitors"). The `occurrences` block of
-- `tenant.settings` becomes the account's first monitor, a row of `occurrence_monitors` named
-- "Ocorrências" holding the block verbatim, and every reading, read mark, theme, member, event,
-- canonical, alias and round of the account becomes that monitor's. An account with neither a block nor
-- a row of the monitor gets no monitor. The uniques that said "one per conversation" or "one per
-- spelling" now say it per monitor, so two monitors never share a theme, a canonical or a reading.
--
-- Safe to run again: every statement is written to change nothing the second time, so a monitor is
-- never created twice and a row never moves to another monitor. The block leaves `tenant.settings`
-- only once its copy is in the monitor. A saved dashboard panel of the monitor names it, and the
-- account's round job is rekeyed to the monitor it runs. Prisma runs the file outside a transaction,
-- so it opens its own, and FORCE is restored even if a statement fails (docs/deploy.md).

BEGIN;

CREATE TABLE IF NOT EXISTS "occurrence_monitors" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "occurrence_monitors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "occurrence_monitors_tenant_id_position_idx" ON "occurrence_monitors"("tenant_id", "position");
CREATE UNIQUE INDEX IF NOT EXISTS "occurrence_monitors_tenant_id_name_key" ON "occurrence_monitors"("tenant_id", "name");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'occurrence_monitors_tenant_id_fkey') THEN
    ALTER TABLE "occurrence_monitors" ADD CONSTRAINT "occurrence_monitors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "occurrence_monitors" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'occurrence_monitors' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON "occurrence_monitors"
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'occurrence_monitors' AND policyname = 'fleet_super_admin') THEN
    EXECUTE format(
      'CREATE POLICY fleet_super_admin ON "occurrence_monitors" TO %I USING (true) WITH CHECK (true)',
      public.fazerai_fleet_role());
  END IF;
END $$;

-- The tables this file writes rows of, read past their policies while it runs.
ALTER TABLE "tenants" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_panels" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduler_jobs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_monitors" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "conversation_readings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_conversation_reads" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_runs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_themes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_theme_members" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_theme_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_canonicals" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_aliases" NO FORCE ROW LEVEL SECURITY;

-- The first monitor: an account with a block, or with any row of the monitor (a block lost while its
-- readings stayed), gets one, with the block as it is. An account that already has a monitor gets none.
INSERT INTO "occurrence_monitors" ("tenant_id", "name", "config", "position")
SELECT t.id,
       'Ocorrências',
       CASE WHEN jsonb_typeof(t.settings -> 'occurrences') = 'object'
            THEN t.settings -> 'occurrences'
            ELSE '{}'::jsonb END,
       0
  FROM "tenants" t
 WHERE NOT EXISTS (SELECT 1 FROM "occurrence_monitors" m WHERE m.tenant_id = t.id)
   AND (
     jsonb_typeof(t.settings -> 'occurrences') = 'object'
     OR EXISTS (SELECT 1 FROM "conversation_readings" x WHERE x.tenant_id = t.id)
     OR EXISTS (SELECT 1 FROM "occurrence_conversation_reads" x WHERE x.tenant_id = t.id)
     OR EXISTS (SELECT 1 FROM "occurrence_runs" x WHERE x.tenant_id = t.id)
     OR EXISTS (SELECT 1 FROM "occurrence_themes" x WHERE x.tenant_id = t.id)
     OR EXISTS (SELECT 1 FROM "occurrence_canonicals" x WHERE x.tenant_id = t.id)
   );

-- Each row of the monitor goes to its account's first monitor. Added nullable, filled, then required,
-- so a second run finds the column there and every row already set.
ALTER TABLE "conversation_readings" ADD COLUMN IF NOT EXISTS "monitor_id" BIGINT;
ALTER TABLE "occurrence_conversation_reads" ADD COLUMN IF NOT EXISTS "monitor_id" BIGINT;
ALTER TABLE "occurrence_runs" ADD COLUMN IF NOT EXISTS "monitor_id" BIGINT;
ALTER TABLE "occurrence_themes" ADD COLUMN IF NOT EXISTS "monitor_id" BIGINT;
ALTER TABLE "occurrence_theme_members" ADD COLUMN IF NOT EXISTS "monitor_id" BIGINT;
ALTER TABLE "occurrence_theme_events" ADD COLUMN IF NOT EXISTS "monitor_id" BIGINT;
ALTER TABLE "occurrence_canonicals" ADD COLUMN IF NOT EXISTS "monitor_id" BIGINT;
ALTER TABLE "occurrence_aliases" ADD COLUMN IF NOT EXISTS "monitor_id" BIGINT;

CREATE TEMP TABLE "occurrence_first_monitor" ON COMMIT DROP AS
SELECT DISTINCT ON (tenant_id) tenant_id, id AS monitor_id
  FROM "occurrence_monitors"
 ORDER BY tenant_id, position, id;

UPDATE "conversation_readings" r SET "monitor_id" = f.monitor_id
  FROM "occurrence_first_monitor" f WHERE f.tenant_id = r.tenant_id AND r.monitor_id IS NULL;
UPDATE "occurrence_conversation_reads" r SET "monitor_id" = f.monitor_id
  FROM "occurrence_first_monitor" f WHERE f.tenant_id = r.tenant_id AND r.monitor_id IS NULL;
UPDATE "occurrence_runs" r SET "monitor_id" = f.monitor_id
  FROM "occurrence_first_monitor" f WHERE f.tenant_id = r.tenant_id AND r.monitor_id IS NULL;
UPDATE "occurrence_themes" r SET "monitor_id" = f.monitor_id
  FROM "occurrence_first_monitor" f WHERE f.tenant_id = r.tenant_id AND r.monitor_id IS NULL;
UPDATE "occurrence_theme_members" r SET "monitor_id" = f.monitor_id
  FROM "occurrence_first_monitor" f WHERE f.tenant_id = r.tenant_id AND r.monitor_id IS NULL;
UPDATE "occurrence_theme_events" r SET "monitor_id" = f.monitor_id
  FROM "occurrence_first_monitor" f WHERE f.tenant_id = r.tenant_id AND r.monitor_id IS NULL;
UPDATE "occurrence_canonicals" r SET "monitor_id" = f.monitor_id
  FROM "occurrence_first_monitor" f WHERE f.tenant_id = r.tenant_id AND r.monitor_id IS NULL;
UPDATE "occurrence_aliases" r SET "monitor_id" = f.monitor_id
  FROM "occurrence_first_monitor" f WHERE f.tenant_id = r.tenant_id AND r.monitor_id IS NULL;

ALTER TABLE "conversation_readings" ALTER COLUMN "monitor_id" SET NOT NULL;
ALTER TABLE "occurrence_conversation_reads" ALTER COLUMN "monitor_id" SET NOT NULL;
ALTER TABLE "occurrence_runs" ALTER COLUMN "monitor_id" SET NOT NULL;
ALTER TABLE "occurrence_themes" ALTER COLUMN "monitor_id" SET NOT NULL;
ALTER TABLE "occurrence_theme_members" ALTER COLUMN "monitor_id" SET NOT NULL;
ALTER TABLE "occurrence_theme_events" ALTER COLUMN "monitor_id" SET NOT NULL;
ALTER TABLE "occurrence_canonicals" ALTER COLUMN "monitor_id" SET NOT NULL;
ALTER TABLE "occurrence_aliases" ALTER COLUMN "monitor_id" SET NOT NULL;

-- The uniques, per monitor.
DROP INDEX IF EXISTS "conversation_readings_conversation_id_field_key";
DROP INDEX IF EXISTS "conversation_readings_tenant_id_field_first_read_at_idx";
DROP INDEX IF EXISTS "conversation_readings_tenant_id_field_last_read_at_idx";
DROP INDEX IF EXISTS "occurrence_aliases_tenant_id_field_raw_key";
DROP INDEX IF EXISTS "occurrence_canonicals_tenant_id_field_name_key";
DROP INDEX IF EXISTS "occurrence_conversation_reads_conversation_id_key";
DROP INDEX IF EXISTS "occurrence_theme_members_conversation_id_key";

CREATE INDEX IF NOT EXISTS "conversation_readings_conversation_id_idx" ON "conversation_readings"("conversation_id");
CREATE INDEX IF NOT EXISTS "conversation_readings_monitor_id_field_first_read_at_idx" ON "conversation_readings"("monitor_id", "field", "first_read_at");
CREATE INDEX IF NOT EXISTS "conversation_readings_monitor_id_field_last_read_at_idx" ON "conversation_readings"("monitor_id", "field", "last_read_at");
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_readings_monitor_id_conversation_id_field_key" ON "conversation_readings"("monitor_id", "conversation_id", "field");
CREATE INDEX IF NOT EXISTS "occurrence_aliases_tenant_id_idx" ON "occurrence_aliases"("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "occurrence_aliases_monitor_id_field_raw_key" ON "occurrence_aliases"("monitor_id", "field", "raw");
CREATE INDEX IF NOT EXISTS "occurrence_canonicals_tenant_id_idx" ON "occurrence_canonicals"("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "occurrence_canonicals_monitor_id_field_name_key" ON "occurrence_canonicals"("monitor_id", "field", "name");
CREATE INDEX IF NOT EXISTS "occurrence_conversation_reads_conversation_id_idx" ON "occurrence_conversation_reads"("conversation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "occurrence_conversation_reads_monitor_id_conversation_id_key" ON "occurrence_conversation_reads"("monitor_id", "conversation_id");
CREATE INDEX IF NOT EXISTS "occurrence_runs_monitor_id_started_at_idx" ON "occurrence_runs"("monitor_id", "started_at");
CREATE INDEX IF NOT EXISTS "occurrence_theme_events_monitor_id_created_at_idx" ON "occurrence_theme_events"("monitor_id", "created_at");
CREATE INDEX IF NOT EXISTS "occurrence_theme_members_conversation_id_idx" ON "occurrence_theme_members"("conversation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "occurrence_theme_members_monitor_id_conversation_id_key" ON "occurrence_theme_members"("monitor_id", "conversation_id");
CREATE INDEX IF NOT EXISTS "occurrence_themes_monitor_id_status_idx" ON "occurrence_themes"("monitor_id", "status");

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'conversation_readings', 'occurrence_conversation_reads', 'occurrence_runs', 'occurrence_themes',
    'occurrence_theme_members', 'occurrence_theme_events', 'occurrence_canonicals', 'occurrence_aliases'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_monitor_id_fkey') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("monitor_id") REFERENCES "occurrence_monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE',
        t, t || '_monitor_id_fkey');
    END IF;
  END LOOP;
END $$;

-- A saved panel of the monitor names the account's first monitor, which is what it showed.
UPDATE "dashboard_panels" p
   SET "query" = p.query || jsonb_build_object('monitorId', f.monitor_id::text)
  FROM "occurrence_first_monitor" f
 WHERE f.tenant_id = p.tenant_id
   AND p.query ->> 'source' = 'occurrences'
   AND NOT (p.query ? 'monitorId');

-- The account's one round job becomes its first monitor's.
UPDATE "scheduler_jobs" j
   SET "dedupe_key" = 'occurrences:' || f.monitor_id::text,
       "payload" = jsonb_build_object('monitorId', f.monitor_id::text)
  FROM "occurrence_first_monitor" f
 WHERE f.tenant_id = j.tenant_id
   AND j.kind = 'OCCURRENCE_ROUND'
   AND j.dedupe_key = 'occurrences'
   AND NOT EXISTS (
     SELECT 1 FROM "scheduler_jobs" o
      WHERE o.tenant_id = j.tenant_id AND o.kind = j.kind
        AND o.dedupe_key = 'occurrences:' || f.monitor_id::text);

-- The block leaves the account's settings once the monitor holds it.
UPDATE "tenants" t
   SET "settings" = t.settings - 'occurrences'
 WHERE t.settings ? 'occurrences'
   AND EXISTS (
     SELECT 1 FROM "occurrence_monitors" m
      WHERE m.tenant_id = t.id
        AND (jsonb_typeof(t.settings -> 'occurrences') <> 'object' OR m.config = t.settings -> 'occurrences'));

ALTER TABLE "occurrence_aliases" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_canonicals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_theme_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_theme_members" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_themes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_conversation_reads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "conversation_readings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_monitors" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduler_jobs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_panels" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

COMMIT;
