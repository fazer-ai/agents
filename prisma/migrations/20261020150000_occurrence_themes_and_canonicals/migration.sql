-- Themes, their members and what consolidation did to them, and the canonical subjects with the
-- alias dictionary (docs/occurrences.md). All empty until a monitor that is on runs a round.
BEGIN;

ALTER TABLE "conversation_readings" ADD COLUMN     "canonical_id" BIGINT;

ALTER TABLE "occurrence_runs" ADD COLUMN     "consolidated" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "occurrence_themes" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "merged_into_id" BIGINT,
    "first_seen_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flag_subject_id" BIGINT,
    "flagged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "occurrence_themes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "occurrence_theme_members" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "theme_id" BIGINT NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    "sentence" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "occurrence_theme_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "occurrence_theme_events" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "theme_id" BIGINT NOT NULL,
    "into_id" BIGINT,
    "run_id" BIGINT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "occurrence_theme_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "occurrence_canonicals" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "merged_into_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "occurrence_canonicals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "occurrence_aliases" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "raw" TEXT NOT NULL,
    "canonical_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "occurrence_aliases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "occurrence_themes_tenant_id_status_idx" ON "occurrence_themes"("tenant_id", "status");

CREATE INDEX "occurrence_theme_members_tenant_id_theme_id_read_at_idx" ON "occurrence_theme_members"("tenant_id", "theme_id", "read_at");

CREATE UNIQUE INDEX "occurrence_theme_members_conversation_id_key" ON "occurrence_theme_members"("conversation_id");

CREATE INDEX "occurrence_theme_events_tenant_id_created_at_idx" ON "occurrence_theme_events"("tenant_id", "created_at");

CREATE UNIQUE INDEX "occurrence_canonicals_tenant_id_name_key" ON "occurrence_canonicals"("tenant_id", "name");

CREATE UNIQUE INDEX "occurrence_aliases_tenant_id_raw_key" ON "occurrence_aliases"("tenant_id", "raw");

-- NOT VALID: the table can hold readings already, and checking them here would hold the column's
-- ACCESS EXCLUSIVE lock for the scan. `20261020150600_validate_conversation_readings_canonical_id_fkey`
-- validates it once this transaction committed; new rows are checked from now on either way.
ALTER TABLE "conversation_readings" ADD CONSTRAINT "conversation_readings_canonical_id_fkey" FOREIGN KEY ("canonical_id") REFERENCES "occurrence_canonicals"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "occurrence_themes" ADD CONSTRAINT "occurrence_themes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_theme_members" ADD CONSTRAINT "occurrence_theme_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_theme_members" ADD CONSTRAINT "occurrence_theme_members_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "occurrence_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_theme_members" ADD CONSTRAINT "occurrence_theme_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_theme_events" ADD CONSTRAINT "occurrence_theme_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_theme_events" ADD CONSTRAINT "occurrence_theme_events_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "occurrence_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_canonicals" ADD CONSTRAINT "occurrence_canonicals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_aliases" ADD CONSTRAINT "occurrence_aliases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_aliases" ADD CONSTRAINT "occurrence_aliases_canonical_id_fkey" FOREIGN KEY ("canonical_id") REFERENCES "occurrence_canonicals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_themes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_themes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_theme_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_theme_members" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_theme_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_theme_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_canonicals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_canonicals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_aliases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_aliases" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "occurrence_themes"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "occurrence_theme_members"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "occurrence_theme_events"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "occurrence_canonicals"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "occurrence_aliases"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "occurrence_themes" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "occurrence_theme_members" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "occurrence_theme_events" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "occurrence_canonicals" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "occurrence_aliases" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
