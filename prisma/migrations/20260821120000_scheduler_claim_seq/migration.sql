-- Issue #164. A job row could not answer "is the claim I am holding still the current one": every
-- write that finishes a job CAS'd on (id, status = 'CLAIMED') and nothing more, while enqueueJob
-- re-arms the SAME physical row back to PENDING. The claim now bumps this counter and hands the
-- value to the handler, so a superseded run's CAS finds nothing to update.
--
-- Additive with a default, so it is safe across a rolling deploy and safe to roll back to: the
-- previous image names its own columns and never this one.
ALTER TABLE "scheduler_jobs" ADD COLUMN "claim_seq" INTEGER NOT NULL DEFAULT 0;
