-- Viewer access to dashboards (docs/dashboards.md, "Viewer access"): who may open a dashboard by its
-- public address, the viewers themselves, their sessions, the last time each opened each dashboard,
-- and the e-mail sign-in codes. Present in every edition, so the schema never diverges; only the code
-- that reads them is Pro. Wrapped so a failure cannot leave a table without FORCE.
BEGIN;

ALTER TABLE "dashboards" ADD COLUMN "viewer_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "viewer_domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "dashboard_viewers" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "email" TEXT NOT NULL,
    "google_id" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_viewers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dashboard_viewer_sessions" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "viewer_id" BIGINT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_viewer_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dashboard_viewer_visits" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "dashboard_id" BIGINT NOT NULL,
    "viewer_id" BIGINT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_viewer_visits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dashboard_viewer_codes" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_viewer_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dashboard_viewers_tenant_id_email_key" ON "dashboard_viewers"("tenant_id", "email");
CREATE UNIQUE INDEX "dashboard_viewer_sessions_token_hash_key" ON "dashboard_viewer_sessions"("token_hash");
CREATE INDEX "dashboard_viewer_sessions_tenant_id_viewer_id_idx" ON "dashboard_viewer_sessions"("tenant_id", "viewer_id");
CREATE UNIQUE INDEX "dashboard_viewer_visits_dashboard_id_viewer_id_key" ON "dashboard_viewer_visits"("dashboard_id", "viewer_id");
CREATE INDEX "dashboard_viewer_visits_tenant_id_dashboard_id_idx" ON "dashboard_viewer_visits"("tenant_id", "dashboard_id");
CREATE INDEX "dashboard_viewer_codes_tenant_id_email_created_at_idx" ON "dashboard_viewer_codes"("tenant_id", "email", "created_at");

ALTER TABLE "dashboard_viewers" ADD CONSTRAINT "dashboard_viewers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dashboard_viewer_sessions" ADD CONSTRAINT "dashboard_viewer_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dashboard_viewer_sessions" ADD CONSTRAINT "dashboard_viewer_sessions_viewer_id_fkey" FOREIGN KEY ("viewer_id") REFERENCES "dashboard_viewers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dashboard_viewer_visits" ADD CONSTRAINT "dashboard_viewer_visits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dashboard_viewer_visits" ADD CONSTRAINT "dashboard_viewer_visits_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dashboard_viewer_visits" ADD CONSTRAINT "dashboard_viewer_visits_viewer_id_fkey" FOREIGN KEY ("viewer_id") REFERENCES "dashboard_viewers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dashboard_viewer_codes" ADD CONSTRAINT "dashboard_viewer_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries.
ALTER TABLE "dashboard_viewers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_viewers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboard_viewers"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "dashboard_viewers" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

ALTER TABLE "dashboard_viewer_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_viewer_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboard_viewer_sessions"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "dashboard_viewer_sessions" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

ALTER TABLE "dashboard_viewer_visits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_viewer_visits" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboard_viewer_visits"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "dashboard_viewer_visits" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

ALTER TABLE "dashboard_viewer_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_viewer_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboard_viewer_codes"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "dashboard_viewer_codes" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
