-- THE LEDGER'S DAY SUMS (issue #1837, docs/dashboard.md "Long windows: weeks and months").
--
-- A read grouped by local week or month takes a UTC day wholly inside one local group from one row per
-- (day, keys) instead of its 96 quarters. The job (src/modules/analytics/ledger-sums.ts) writes a day
-- from `ledger_quarter_sums` when a step completes it, and again when it recomputes a marked quarter of
-- it. A reader takes the day rows only of a day below `summed_until` with no marked quarter, so a day
-- whose quarters changed is read from its quarters until the job rewrites it.
--
-- The days already summed are written here from their quarters, so a tenant whose job ran before this
-- migration reads the same figures from its day rows as from its quarters. FORCE is lifted around that
-- statement for the tables it reads and writes (.claude/rules/prisma.md), inside the file's own
-- transaction, so a failure cannot leave a table without it.
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

ALTER TABLE "ledger_day_sums" ADD CONSTRAINT "ledger_day_sums_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ledger_day_sums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_day_sums" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ledger_day_sums"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format('CREATE POLICY fleet_super_admin ON "ledger_day_sums" TO %I USING (true) WITH CHECK (true)', v_fleet);
END $$;

ALTER TABLE "ledger_quarter_sums" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_sums_state" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_day_sums" NO FORCE ROW LEVEL SECURITY;

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

ALTER TABLE "ledger_quarter_sums" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_sums_state" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_day_sums" FORCE ROW LEVEL SECURITY;

COMMIT;
