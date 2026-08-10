-- Agent-memory retention sweep (limits.forgetResolvedAfterDays).
--
-- IF NOT EXISTS keeps the migration re-runnable; adding a value to an existing enum type does not
-- rewrite the table and takes no long lock, so this is safe on a live database.
ALTER TYPE "SchedulerJobKind" ADD VALUE IF NOT EXISTS 'MEMORY_SWEEP';
