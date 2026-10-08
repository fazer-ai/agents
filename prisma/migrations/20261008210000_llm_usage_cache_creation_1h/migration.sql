-- The 1-hour cache writes of a call, kept apart from the total so they can be priced at their own
-- rate (issue #1164). Additive: a column with a constant default, which Postgres adds without
-- rewriting the table.
ALTER TABLE "llm_usage" ADD COLUMN "cache_creation_1h_tokens" INTEGER NOT NULL DEFAULT 0;
