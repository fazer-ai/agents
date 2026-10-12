-- The trigger state's generation follows the scheduler's order, not the order the reads land: it is
-- the observe job's (row id, claim_seq), so a run the scheduler already superseded cannot take a
-- generation past the run that superseded it (docs/decisions.md "When a rule acts").
ALTER TABLE "decision_rule_claims" ADD COLUMN "job_id" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "decision_rule_states" ADD COLUMN "job_id" BIGINT NOT NULL DEFAULT 0;
