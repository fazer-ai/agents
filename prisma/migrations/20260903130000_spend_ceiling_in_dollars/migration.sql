-- The ceiling is denominated in dollars now (issue #426): the invoice it exists to bound is, and a
-- token count cannot be made to track one (output costs more than input, cached reads are cheaper,
-- and every model has its own price). The figure comes from Langfuse, which keeps the price table,
-- and it is read by a PERIODIC JOB into this table; the gate reads the row, never Langfuse, so a
-- Langfuse outage costs staleness and not a silent tenant.
--
-- One row per (tenant, source, calendar month). `polled_at` is the last SUCCESSFUL poll and
-- `poll_error` / `poll_failed_at` the last failure, kept apart so a failing poll never overwrites the
-- last good figure and the console can say both "US$ 22.50 as of 12:01" and "polls failing since
-- 12:06". `traced_calls`, `costed_calls` and `unpriced_models` are the reconciliation against the
-- local ledger: Langfuse prices a model it does not know at zero, silently, and a ceiling that
-- undercounts has to say so on the screen that shows the bar.
CREATE TABLE "spend_cost_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "month_start" TIMESTAMP(3) NOT NULL,
    "cost_usd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "traced_calls" INTEGER NOT NULL DEFAULT 0,
    "costed_calls" INTEGER NOT NULL DEFAULT 0,
    "unpriced_models" JSONB NOT NULL DEFAULT '[]',
    "project_key" TEXT,
    "carried_usd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "carried_traced_calls" INTEGER NOT NULL DEFAULT 0,
    "carried_costed_calls" INTEGER NOT NULL DEFAULT 0,
    "carried_unpriced_models" JSONB NOT NULL DEFAULT '[]',
    "polled_at" TIMESTAMP(3),
    "poll_error" TEXT,
    "poll_failed_at" TIMESTAMP(3),
    "poll_last_failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spend_cost_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "spend_cost_snapshots_tenant_id_source_month_start_key" ON "spend_cost_snapshots"("tenant_id", "source", "month_start");

ALTER TABLE "spend_cost_snapshots" ADD CONSTRAINT "spend_cost_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-scoped, under the same pair of policies every other tenant table carries since
-- 20260827000000_rls_split_tenant_and_fleet_policies.
ALTER TABLE "spend_cost_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spend_cost_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "spend_cost_snapshots"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "spend_cost_snapshots" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

-- The job that writes the row. Value only: the first use is in code, never in this migration
-- (an enum value added here cannot be used in the same transaction).
ALTER TYPE "SchedulerJobKind" ADD VALUE 'SPEND_CEILING_POLL';
