-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "follow_up_armed_at" TIMESTAMP(3);

-- Backfill: existing agents are considered armed as of this deploy. Semantics: "only follow up
-- episodes of silence that BEGIN after arming" — pre-deploy backlogs never get swept, which is
-- exactly the incident this column fixes (mass follow-up on historical conversations when an
-- agent goes live). In-flight sequences (already-enqueued FOLLOWUP jobs past step 0) are not
-- affected: the watermark only gates sequence STARTS.
UPDATE "agents" SET "follow_up_armed_at" = NOW();
