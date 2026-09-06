-- The job that classifies a conversation a monitoring agent watches and writes the verdict as
-- labels (issue #477).
--
-- Alone in its own migration because Postgres refuses to use a value added to an enum inside the
-- same transaction that added it, and Prisma runs one migration file per transaction. The next
-- migration is free to reference 'OBSERVE'; this one must not.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'OBSERVE';
