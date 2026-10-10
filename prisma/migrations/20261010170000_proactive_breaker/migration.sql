-- The account-wide breaker for proactive messages (docs/proactive-breaker.md). Its configuration is a
-- block of `tenants.settings`; this row is its STATE, written by the gate on every trip and by the
-- admin's resume, so it lives apart from the JSON column the settings screens merge under a lock.
--
-- One row per tenant, created on first need. `tripped_at` is the latch: set by the send that found
-- the account at its limit, cleared only by a resume, which also stamps `resumed_at` so the count
-- after it starts from zero. `auto_*` is the automatic limit's inputs, refreshed at most daily.
CREATE TABLE "proactive_breakers" (
    "tenant_id" BIGINT NOT NULL,
    "tripped_at" TIMESTAMP(3),
    "trip_count" INTEGER,
    "trip_limit" INTEGER,
    "resumed_at" TIMESTAMP(3),
    "auto_peak" INTEGER,
    "auto_peak_at" TIMESTAMP(3),
    "auto_computed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proactive_breakers_pkey" PRIMARY KEY ("tenant_id")
);

ALTER TABLE "proactive_breakers" ADD CONSTRAINT "proactive_breakers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-scoped, under the same pair of policies every other tenant table carries since
-- 20260827000000_rls_split_tenant_and_fleet_policies.
ALTER TABLE "proactive_breakers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "proactive_breakers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "proactive_breakers"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "proactive_breakers" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;
