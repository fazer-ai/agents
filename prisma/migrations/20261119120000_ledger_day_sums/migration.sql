-- THE LEDGER'S DAY SUMS (issue #1837, docs/dashboard.md "Long windows: weeks and months").
--
-- A read grouped by local week or month takes a UTC day wholly inside one local group from one row per
-- (day, keys) instead of its 96 quarters. The job (src/modules/analytics/ledger-sums.ts) writes a day
-- from `ledger_quarter_sums`, and records it in `ledger_summed_days`. A reader takes the day rows only
-- of a day recorded there with no marked quarter.
--
-- Whoever rewrites a quarter sum takes its day off `ledger_summed_days` (the statement trigger below),
-- so a day row can never stand for quarters newer than it: not the job's own rewrite before it writes
-- the day again in the same transaction, and not a worker of the previous release, which keeps the
-- quarters during a rolling upgrade and knows nothing of the days. The job writes again every day below
-- its mark that is not recorded, a few per step, so a day taken off comes back on the next steps.
--
-- The days already summed are written here from their quarters, so a tenant whose job ran before this
-- migration reads them from day rows at once. FORCE is lifted around that statement for the tables it
-- reads and writes (.claude/rules/prisma.md), inside the file's own transaction, so a failure cannot
-- leave a table without it.
BEGIN;

CREATE TABLE "ledger_day_sums" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL,
    "agent_id" BIGINT,
    "inbox_id" BIGINT,
    "model" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    -- Null when no call of the group was priced, never zero.
    "cost_usd" DECIMAL(28,10),
    "requests" INTEGER NOT NULL,
    "unpriced" INTEGER NOT NULL,
    "prompt_tokens" BIGINT NOT NULL,
    "completion_tokens" BIGINT NOT NULL,
    "cached_read_tokens" BIGINT NOT NULL,
    "cache_creation_tokens" BIGINT NOT NULL,

    CONSTRAINT "ledger_day_sums_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ledger_day_sums_tenant_id_day_idx" ON "ledger_day_sums"("tenant_id", "day");

CREATE TABLE "ledger_summed_days" (
    "tenant_id" BIGINT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_summed_days_pkey" PRIMARY KEY ("tenant_id", "day")
);

ALTER TABLE "ledger_day_sums" ADD CONSTRAINT "ledger_day_sums_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_summed_days" ADD CONSTRAINT "ledger_summed_days_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ledger_day_sums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_day_sums" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_summed_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_summed_days" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ledger_day_sums"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "ledger_summed_days"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format('CREATE POLICY fleet_super_admin ON "ledger_day_sums" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "ledger_summed_days" TO %I USING (true) WITH CHECK (true)', v_fleet);
END $$;

ALTER TABLE "ledger_quarter_sums" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_sums_state" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_day_sums" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_summed_days" NO FORCE ROW LEVEL SECURITY;

-- Every UTC day wholly below the tenant's mark, from its quarters.
INSERT INTO "ledger_day_sums" (tenant_id, day, source, anonymous, agent_id, inbox_id, model, node, cost_usd,
                               requests, unpriced, prompt_tokens, completion_tokens, cached_read_tokens,
                               cache_creation_tokens)
SELECT q.tenant_id, date_trunc('day', q.quarter), q.source, q.anonymous, q.agent_id, q.inbox_id, q.model, q.node,
       SUM(q.cost_usd), SUM(q.requests)::int, SUM(q.unpriced)::int, SUM(q.prompt_tokens)::bigint,
       SUM(q.completion_tokens)::bigint, SUM(q.cached_read_tokens)::bigint, SUM(q.cache_creation_tokens)::bigint
  FROM "ledger_quarter_sums" q
  JOIN "ledger_sums_state" st ON st.tenant_id = q.tenant_id
 WHERE st.summed_until IS NOT NULL AND q.quarter < date_trunc('day', st.summed_until)
 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;

INSERT INTO "ledger_summed_days" (tenant_id, day)
SELECT st.tenant_id, d.day
  FROM "ledger_sums_state" st
 CROSS JOIN LATERAL generate_series(
         (SELECT date_trunc('day', min(q.quarter)) FROM "ledger_quarter_sums" q WHERE q.tenant_id = st.tenant_id),
         date_trunc('day', st.summed_until) - interval '1 day', interval '1 day') AS d(day)
 WHERE st.summed_until IS NOT NULL;

ALTER TABLE "ledger_quarter_sums" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_sums_state" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_day_sums" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_summed_days" FORCE ROW LEVEL SECURITY;

-- A quarter sum written, rewritten or deleted takes its UTC day off the summed days. One statement per
-- statement, from the transition tables. The tenant's removal cascades here too, harmlessly.
CREATE FUNCTION ledger_day_unsum() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    DELETE FROM ledger_summed_days d
     USING (SELECT DISTINCT tenant_id, date_trunc('day', quarter) AS day FROM new_rows) r
     WHERE d.tenant_id = r.tenant_id AND d.day = r.day;
  ELSIF TG_OP = 'UPDATE' THEN
    DELETE FROM ledger_summed_days d
     USING (SELECT DISTINCT tenant_id, date_trunc('day', quarter) AS day
              FROM (SELECT tenant_id, quarter FROM old_rows UNION ALL SELECT tenant_id, quarter FROM new_rows) x) r
     WHERE d.tenant_id = r.tenant_id AND d.day = r.day;
  ELSE
    DELETE FROM ledger_summed_days d
     USING (SELECT DISTINCT tenant_id, date_trunc('day', quarter) AS day FROM old_rows) r
     WHERE d.tenant_id = r.tenant_id AND d.day = r.day;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER ledger_day_unsum_insert AFTER INSERT ON "ledger_quarter_sums"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_day_unsum();

CREATE TRIGGER ledger_day_unsum_update AFTER UPDATE ON "ledger_quarter_sums"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_day_unsum();

CREATE TRIGGER ledger_day_unsum_delete AFTER DELETE ON "ledger_quarter_sums"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_day_unsum();

COMMIT;
