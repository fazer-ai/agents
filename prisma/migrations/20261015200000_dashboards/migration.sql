-- Account-built dashboards and their panels (docs/dashboards.md). Present in every edition, so the
-- schema never diverges; only the code that reads them is Pro. Wrapped so a failure cannot leave a
-- table without FORCE.
BEGIN;

CREATE TABLE "dashboards" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "default_range" TEXT NOT NULL DEFAULT '24h',
    "refresh_seconds" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dashboards_tenant_id_slug_key" ON "dashboards"("tenant_id", "slug");

ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dashboard_panels" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "dashboard_id" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "width" TEXT NOT NULL DEFAULT 'half',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visualization" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_panels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dashboard_panels_tenant_id_dashboard_id_position_idx" ON "dashboard_panels"("tenant_id", "dashboard_id", "position");

ALTER TABLE "dashboard_panels" ADD CONSTRAINT "dashboard_panels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dashboard_panels" ADD CONSTRAINT "dashboard_panels_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries.
ALTER TABLE "dashboards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboards" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboards"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "dashboards" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

ALTER TABLE "dashboard_panels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_panels" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboard_panels"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "dashboard_panels" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
