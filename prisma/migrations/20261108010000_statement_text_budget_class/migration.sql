-- The budget a statement ran under, by the pool that sent it: 'metrics' (the console's reads, under
-- METRICS_TIMEOUT_MS) or 'default' (everything else, under DB_TX_TIMEOUT_MS). Null until the snapshot
-- learns it; read as 'default'.
ALTER TABLE "db_statement_texts" ADD COLUMN "budget_class" TEXT;
