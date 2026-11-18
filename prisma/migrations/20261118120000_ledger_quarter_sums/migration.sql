-- THE LEDGER'S QUARTER-HOUR SUMS (issue #1750, docs/dashboard.md "Ledger sums").
--
-- The dashboard's ledger blocks read `llm_usage` sums per UTC quarter hour instead of its rows, and
-- the model call latency from a histogram per UTC day. Every zone's offset from UTC is a whole number
-- of quarter hours, so a quarter falls in one local day in any zone.
--
-- Nothing on the insert path writes a sum. A job per tenant (LEDGER_SUMS, src/modules/analytics/
-- ledger-sums.ts) writes them for the quarters wholly below a safe mark that no uncommitted row can
-- fall under, and moves `ledger_sums_state.summed_until` up to it. The statement triggers below only
-- append to `ledger_sum_marks` the quarters of rows written, rewritten or deleted below what may
-- already be summed (an import, a backfill, a re-price, a removal), and the job recomputes a marked
-- quarter from its rows. A reader reads the sums of the unmarked quarters below `summed_until`, and
-- the rows of the marked quarters and of the stretch above it, so every figure is the one the rows
-- give. A tenant with no state row, or one whose job has summed nothing yet, reads the rows.
--
-- Wrapped in a transaction: a failure between a CREATE TABLE and its FORCE ROW LEVEL SECURITY leaves a
-- tenant-scoped table that does not bind its owner (.claude/rules/prisma.md). No lock on `llm_usage`
-- beyond the instant of each CREATE TRIGGER: no row is read or written here.
BEGIN;

-- The UTC quarter hour of a `timestamp without time zone` holding UTC wall-clock.
CREATE FUNCTION ledger_quarter(ts timestamp) RETURNS timestamp LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT date_trunc('hour', ts) + floor(date_part('minute', ts) / 15) * interval '15 minutes'
$$;

-- The histogram bucket of a call's duration: buckets 5% wide, so a percentile read from them is within
-- 5% of the exact one. Bucket 0 holds every call of 1 ms or less.
CREATE FUNCTION ledger_latency_bucket(ms integer) RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN ms <= 1 THEN 0 ELSE 1 + floor(ln(ms::float8) / ln(1.05::float8))::integer END
$$;

CREATE TABLE "ledger_quarter_sums" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "quarter" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL,
    "agent_id" BIGINT,
    "inbox_id" BIGINT,
    "model" TEXT NOT NULL,
    -- `COALESCE(node, 'agent')`: a row with no node is an agent turn, as every ledger reader groups it.
    "node" TEXT NOT NULL,
    -- Null when no call of the group was priced, never zero.
    "cost_usd" DECIMAL(28,10),
    "requests" INTEGER NOT NULL,
    "unpriced" INTEGER NOT NULL,
    "prompt_tokens" BIGINT NOT NULL,
    "completion_tokens" BIGINT NOT NULL,
    "cached_read_tokens" BIGINT NOT NULL,
    "cache_creation_tokens" BIGINT NOT NULL,

    CONSTRAINT "ledger_quarter_sums_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ledger_quarter_sums_tenant_id_quarter_idx" ON "ledger_quarter_sums"("tenant_id", "quarter");

CREATE TABLE "ledger_latency_days" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL,
    "agent_id" BIGINT,
    "inbox_id" BIGINT,
    "model" TEXT NOT NULL,
    "bucket" INTEGER NOT NULL,
    "calls" INTEGER NOT NULL,
    "min_ms" INTEGER NOT NULL,
    "max_ms" INTEGER NOT NULL,

    CONSTRAINT "ledger_latency_days_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ledger_latency_days_tenant_id_day_idx" ON "ledger_latency_days"("tenant_id", "day");

-- Append-only: no key, so two writers never wait on each other's mark.
CREATE TABLE "ledger_sum_marks" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "quarter" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_sum_marks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ledger_sum_marks_tenant_id_quarter_idx" ON "ledger_sum_marks"("tenant_id", "quarter");

CREATE TABLE "ledger_sums_state" (
    "tenant_id" BIGINT NOT NULL,
    -- Every quarter below this has its sums, except the marked ones. Null until the first run.
    "summed_until" TIMESTAMP(3),
    -- The candidate mark of the previous run: the instant it was taken, and that run's own transaction
    -- id, assigned after it. Once the oldest running transaction is past that id, every transaction
    -- that had an id at the instant has ended, and the quarters below the instant minus the grace can
    -- be summed.
    "candidate_at" TIMESTAMP(3),
    "candidate_xid" xid8,

    CONSTRAINT "ledger_sums_state_pkey" PRIMARY KEY ("tenant_id")
);

ALTER TABLE "ledger_quarter_sums" ADD CONSTRAINT "ledger_quarter_sums_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_latency_days" ADD CONSTRAINT "ledger_latency_days_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_sum_marks" ADD CONSTRAINT "ledger_sum_marks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_sums_state" ADD CONSTRAINT "ledger_sums_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ledger_quarter_sums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_quarter_sums" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_latency_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_latency_days" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_sum_marks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_sum_marks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_sums_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_sums_state" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ledger_quarter_sums"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "ledger_latency_days"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "ledger_sum_marks"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "ledger_sums_state"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format('CREATE POLICY fleet_super_admin ON "ledger_quarter_sums" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "ledger_latency_days" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "ledger_sum_marks" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "ledger_sums_state" TO %I USING (true) WITH CHECK (true)', v_fleet);
END $$;

-- The marks. A row counts when it is older than the grace (5 minutes) at the moment its statement
-- runs: the job sums only quarters wholly below its own mark minus the grace, taken before the
-- snapshot whose transactions it waits out, so a row the job could have summed without seeing it was
-- written by a statement that ran after that mark, and is marked here. A row inside the grace is
-- above every quarter the job may sum, and is read from the rows anyway. One mark per distinct
-- quarter per statement, from the transition tables: a re-price of a month is one statement and a few
-- thousand marks, not one per row.
--
-- A delete cascaded from a tenant's removal marks nothing: the tenant row is already gone in the same
-- transaction, and its sums and marks go with it. The tenant is the one the statement's own scope
-- can see (its RLS policy), which is the one whose rows the statement changed.
CREATE FUNCTION ledger_sum_mark() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes';
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO ledger_sum_marks (tenant_id, quarter)
    SELECT DISTINCT n.tenant_id, ledger_quarter(n.created_at) FROM new_rows n
     WHERE n.created_at < cutoff AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = n.tenant_id);
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO ledger_sum_marks (tenant_id, quarter)
    SELECT DISTINCT r.tenant_id, ledger_quarter(r.created_at)
      FROM (SELECT tenant_id, created_at FROM old_rows UNION ALL SELECT tenant_id, created_at FROM new_rows) r
     WHERE r.created_at < cutoff AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = r.tenant_id);
  ELSE
    INSERT INTO ledger_sum_marks (tenant_id, quarter)
    SELECT DISTINCT o.tenant_id, ledger_quarter(o.created_at) FROM old_rows o
     WHERE o.created_at < cutoff AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = o.tenant_id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER ledger_sum_mark_insert AFTER INSERT ON "llm_usage"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_sum_mark();

CREATE TRIGGER ledger_sum_mark_update AFTER UPDATE ON "llm_usage"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_sum_mark();

CREATE TRIGGER ledger_sum_mark_delete AFTER DELETE ON "llm_usage"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_sum_mark();

COMMIT;
