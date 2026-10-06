-- The spend ceiling's snapshot is summed from llm_usage now (issue #1060), not read from Langfuse:
-- the reconciliation counters, the unpriced-model list and the project-switch carry existed only
-- because the figure came from a third party, and nothing reads them anymore. A row marked
-- "langfuse-not-configured" by the old poll is not a failure of the new one, so the marker is
-- cleared; its figure stands until the first ledger poll replaces it.
BEGIN;

ALTER TABLE "spend_cost_snapshots"
  DROP COLUMN "traced_calls",
  DROP COLUMN "costed_calls",
  DROP COLUMN "unpriced_models",
  DROP COLUMN "project_key",
  DROP COLUMN "carried_usd",
  DROP COLUMN "carried_traced_calls",
  DROP COLUMN "carried_costed_calls",
  DROP COLUMN "carried_unpriced_models";

-- FORCE binds the owner too, so the cross-tenant UPDATE is bracketed or it reaches zero rows.
ALTER TABLE "spend_cost_snapshots" NO FORCE ROW LEVEL SECURITY;

UPDATE "spend_cost_snapshots"
   SET "poll_error" = NULL, "poll_failed_at" = NULL, "poll_last_failed_at" = NULL
 WHERE "poll_error" = 'langfuse-not-configured';

ALTER TABLE "spend_cost_snapshots" FORCE ROW LEVEL SECURITY;

COMMIT;
