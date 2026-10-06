-- ONE ANNOUNCEMENT PER MODEL, MONTH AND SOURCE for a model the usage ledger could not price. The row is
-- the claim: whoever inserts it announces, a conflict means someone already did. Kept apart from the
-- flow log, whose retention would delete the marker before the month ends.
--
-- Wrapped in a transaction so a failure between the CREATE TABLE and the FORCE ROW LEVEL SECURITY
-- cannot leave a tenant-scoped table that does not bind its own owner.
BEGIN;

CREATE TABLE "unpriced_model_announcements" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "month_start" TIMESTAMP(3) NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unpriced_model_announcements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "unpriced_model_announcements_claim_key" ON "unpriced_model_announcements"("tenant_id", "source", "month_start", "model");

ALTER TABLE "unpriced_model_announcements" ADD CONSTRAINT "unpriced_model_announcements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "unpriced_model_announcements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unpriced_model_announcements" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "unpriced_model_announcements"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "unpriced_model_announcements" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
