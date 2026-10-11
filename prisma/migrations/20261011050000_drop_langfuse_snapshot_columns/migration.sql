-- The eight Langfuse-era columns of spend_cost_snapshots (issue #1066). #1061 moved the ceiling's
-- figure to the usage ledger and stopped writing them; they stayed one release behind @ignore so the
-- previous image could still name them. Rolling back past this release is no longer supported.
ALTER TABLE "spend_cost_snapshots"
  DROP COLUMN "traced_calls",
  DROP COLUMN "costed_calls",
  DROP COLUMN "unpriced_models",
  DROP COLUMN "project_key",
  DROP COLUMN "carried_usd",
  DROP COLUMN "carried_traced_calls",
  DROP COLUMN "carried_costed_calls",
  DROP COLUMN "carried_unpriced_models";
