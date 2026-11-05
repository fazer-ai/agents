-- The instance's database screen (docs/logs.md, "Database"): pg_stat_statements deltas, table
-- snapshots, and the statement timeouts the app captured with their plans. Like the instance alert
-- tables these belong to the INSTANCE, not to a tenant: no tenant_id to match, RLS with the fleet
-- policy ONLY, so the runtime role reads and writes them only after entering the fleet role.
-- One transaction: a failure after CREATE TABLE must not leave a table without its policy.
BEGIN;

-- One row per snapshot taken, extension or not: the instants the screen's windows are cut on.
CREATE TABLE "db_stat_snapshot_runs" (
    "taken_at" TIMESTAMP(3) NOT NULL,
    "statements_available" BOOLEAN NOT NULL,

    CONSTRAINT "db_stat_snapshot_runs_pkey" PRIMARY KEY ("taken_at")
);

-- What each pg_stat_statements entry did between two consecutive snapshots: the difference of its
-- counters, taken by the sampler at write time (a reset or an eviction counts what the entry holds
-- since then). Only entries that ran are written; a window is the sum of the rows inside it, so no
-- row ever depends on another being kept.
CREATE TABLE "db_statement_deltas" (
    "taken_at" TIMESTAMP(3) NOT NULL,
    "userid" BIGINT NOT NULL,
    "dbid" BIGINT NOT NULL,
    "queryid" BIGINT NOT NULL,
    "calls" BIGINT NOT NULL,
    "total_exec_ms" DOUBLE PRECISION NOT NULL,
    "rows" BIGINT NOT NULL,

    CONSTRAINT "db_statement_deltas_pkey" PRIMARY KEY ("userid", "dbid", "queryid", "taken_at")
);

CREATE INDEX "db_statement_deltas_taken_at_idx" ON "db_statement_deltas"("taken_at");

-- The normalized text of each entry, once, instead of once per snapshot.
CREATE TABLE "db_statement_texts" (
    "userid" BIGINT NOT NULL,
    "dbid" BIGINT NOT NULL,
    "queryid" BIGINT NOT NULL,
    "query" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "db_statement_texts_pkey" PRIMARY KEY ("userid", "dbid", "queryid")
);

CREATE INDEX "db_statement_texts_last_seen_at_idx" ON "db_statement_texts"("last_seen_at");

CREATE TABLE "db_table_snapshots" (
    "taken_at" TIMESTAMP(3) NOT NULL,
    "table_name" TEXT NOT NULL,
    "total_bytes" BIGINT NOT NULL,
    "live_tuples" BIGINT NOT NULL,
    "dead_tuples" BIGINT NOT NULL,

    CONSTRAINT "db_table_snapshots_pkey" PRIMARY KEY ("table_name", "taken_at")
);

CREATE INDEX "db_table_snapshots_taken_at_idx" ON "db_table_snapshots"("taken_at");

-- A statement that failed with 57014, as the app saw it: the SQL it sent (parameters as $N, values
-- never stored), what was running it, the tenant scope and budget of its transaction, and the plan
-- captured for it under that same scope (only the first occurrence of a statement per window has one).
CREATE TABLE "db_statement_timeouts" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "label" TEXT,
    "scope_tenant_id" BIGINT,
    "fleet" BOOLEAN NOT NULL DEFAULT false,
    "budget_ms" INTEGER,
    "plan" TEXT,
    "plan_error" TEXT,
    "planned_as" TEXT,

    CONSTRAINT "db_statement_timeouts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "db_statement_timeouts_occurred_at_idx" ON "db_statement_timeouts"("occurred_at");
CREATE INDEX "db_statement_timeouts_fingerprint_occurred_at_idx" ON "db_statement_timeouts"("fingerprint", "occurred_at");

ALTER TABLE "db_stat_snapshot_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "db_stat_snapshot_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "db_statement_deltas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "db_statement_deltas" FORCE ROW LEVEL SECURITY;
ALTER TABLE "db_statement_texts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "db_statement_texts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "db_table_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "db_table_snapshots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "db_statement_timeouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "db_statement_timeouts" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY fleet_super_admin ON "db_stat_snapshot_runs" TO %I USING (true) WITH CHECK (true)', public.fazerai_fleet_role());
  EXECUTE format('CREATE POLICY fleet_super_admin ON "db_statement_deltas" TO %I USING (true) WITH CHECK (true)', public.fazerai_fleet_role());
  EXECUTE format('CREATE POLICY fleet_super_admin ON "db_statement_texts" TO %I USING (true) WITH CHECK (true)', public.fazerai_fleet_role());
  EXECUTE format('CREATE POLICY fleet_super_admin ON "db_table_snapshots" TO %I USING (true) WITH CHECK (true)', public.fazerai_fleet_role());
  EXECUTE format('CREATE POLICY fleet_super_admin ON "db_statement_timeouts" TO %I USING (true) WITH CHECK (true)', public.fazerai_fleet_role());
END $$;

COMMIT;
