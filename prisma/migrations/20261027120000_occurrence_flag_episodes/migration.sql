-- Flag episodes (docs/occurrences.md, "Flag history"): one row per stretch a theme stayed flagged, held
-- included, opened by the round that flagged it and closed by the one that unflagged it. A theme has at
-- most one open episode. Deleted with the monitor, never by age. Prisma runs the file outside a
-- transaction, so it opens its own.

BEGIN;

CREATE TABLE IF NOT EXISTS "occurrence_flag_episodes" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "monitor_id" BIGINT NOT NULL,
    "theme_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reference_id" BIGINT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "last_flagged_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "peak" INTEGER NOT NULL DEFAULT 0,
    "run_id" BIGINT,

    CONSTRAINT "occurrence_flag_episodes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "occurrence_flag_episodes_monitor_id_started_at_idx" ON "occurrence_flag_episodes"("monitor_id", "started_at");
CREATE INDEX IF NOT EXISTS "occurrence_flag_episodes_tenant_id_idx" ON "occurrence_flag_episodes"("tenant_id");
CREATE INDEX IF NOT EXISTS "occurrence_flag_episodes_theme_id_idx" ON "occurrence_flag_episodes"("theme_id");
-- One open episode per theme: two rounds (a round and a save's recount) never open two.
CREATE UNIQUE INDEX IF NOT EXISTS "occurrence_flag_episodes_open_theme_key" ON "occurrence_flag_episodes"("theme_id") WHERE "ended_at" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'occurrence_flag_episodes_tenant_id_fkey') THEN
    ALTER TABLE "occurrence_flag_episodes" ADD CONSTRAINT "occurrence_flag_episodes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'occurrence_flag_episodes_monitor_id_fkey') THEN
    ALTER TABLE "occurrence_flag_episodes" ADD CONSTRAINT "occurrence_flag_episodes_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "occurrence_monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'occurrence_flag_episodes_theme_id_fkey') THEN
    ALTER TABLE "occurrence_flag_episodes" ADD CONSTRAINT "occurrence_flag_episodes_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "occurrence_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'occurrence_flag_episodes_run_id_fkey') THEN
    ALTER TABLE "occurrence_flag_episodes" ADD CONSTRAINT "occurrence_flag_episodes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "occurrence_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "occurrence_flag_episodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_flag_episodes" FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'occurrence_flag_episodes' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON "occurrence_flag_episodes"
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'occurrence_flag_episodes' AND policyname = 'fleet_super_admin') THEN
    EXECUTE format(
      'CREATE POLICY fleet_super_admin ON "occurrence_flag_episodes" TO %I USING (true) WITH CHECK (true)',
      public.fazerai_fleet_role());
  END IF;
END $$;

COMMIT;
