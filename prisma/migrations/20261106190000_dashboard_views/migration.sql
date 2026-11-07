-- The dashboard views people open (docs/dashboard.md, "Keeping the days warm"): one row per tenant,
-- filter and zone, with the last time the console opened it and how far back from today it reached. The warm-up
-- pass recomputes, between visits, the kept days of the views opened lately, so a view opened after a
-- day of changes reads its days instead of computing them in front of the viewer.
-- Wrapped so a failure cannot leave the table without FORCE.
BEGIN;

CREATE TABLE "dashboard_views" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "filter_key" TEXT NOT NULL,
    "tz" TEXT NOT NULL,
    "span_days" INTEGER,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dashboard_views_tenant_id_filter_key_tz_key" ON "dashboard_views"("tenant_id", "filter_key", "tz");
CREATE INDEX "dashboard_views_opened_at_idx" ON "dashboard_views"("opened_at");

ALTER TABLE "dashboard_views" ADD CONSTRAINT "dashboard_views_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dashboard_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_views" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "dashboard_views"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "dashboard_views" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
