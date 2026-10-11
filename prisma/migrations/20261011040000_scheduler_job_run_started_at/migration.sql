-- When a scheduler job's run started, kept apart from claimed_at: the recovery after a deadline
-- renews claimed_at for the lease, and the snoozed sweep needs the run's real start (issue #1274).
-- Nullable and unset on existing rows: the sweep falls back to claimed_at, as before.
ALTER TABLE "scheduler_jobs" ADD COLUMN "run_started_at" TIMESTAMP(3);
