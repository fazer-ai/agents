-- The recovery that folds back the colleague's reply an ingestion lost (issue #728).
--
-- Alone in its own migration because Postgres refuses to use a value added to an enum inside the
-- same transaction that added it, and Prisma runs one migration file per transaction. The next
-- migration is free to reference 'HUMAN_REPLY_RECOVERY'; this one must not.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'HUMAN_REPLY_RECOVERY';
